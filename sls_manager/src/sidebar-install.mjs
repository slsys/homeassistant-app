import { readFile, writeFile, rename, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';

const error = (message) => new Error(message);
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const modulePath = '/local/sls-sidebar.js';
async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function atomicWrite(path, content, mode = 0o600) {
  const temp = path + '.sls-' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content, { mode, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
function parse(source) {
  if (source.length > 2 * 1024 * 1024) throw error('Слишком большой файл конфигурации HA');
  const doc = parseDocument(source, { strict: true, uniqueKeys: true });
  if (doc.errors.length) throw error('Ошибка YAML в конфигурации HA; иконка не установлена');
  return doc;
}
async function inside(root, path, missing = false) {
  const target = resolve(path);
  const resolved = missing
    ? join(await realpath(dirname(target)), target.split(/[\\/]/).at(-1))
    : await realpath(target);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel))
    throw error('Путь конфигурации выходит за каталог HA');
  // Do not replace symlinks: the rename must refer to the same file we read.
  if (target !== resolved) throw error('Символическая ссылка в конфигурации требует ручной настройки иконки');
  return resolved;
}

export async function planSidebar(configRoot, moduleSource) {
  const root = await realpath(configRoot);
  const moduleDirectory = join(root, 'www');
  await mkdir(moduleDirectory, { recursive: true });
  await inside(root, moduleDirectory);
  const output = join(moduleDirectory, 'sls-sidebar.js');
  const beforeModule = await readOptional(output);
  await inside(root, output, beforeModule === null);
  const sameModule = beforeModule?.replace(/\r\n/g, '\n') === moduleSource.replace(/\r\n/g, '\n');
  const desiredUrl = modulePath + '?v=' + hash(moduleSource.replace(/\r\n/g, '\n'));
  const writes = [];
  const documents = new Map();
  async function document(path) {
    path = await inside(root, path);
    if (!documents.has(path)) {
      const before = await readFile(path, 'utf8');
      documents.set(path, { path, before, doc: parse(before), mode: (await stat(path)).mode & 0o777 });
    }
    return documents.get(path);
  }
  async function follow(file, node, depth = 0) {
    if (node?.tag !== '!include') return { file, node };
    if (depth > 6 || !isScalar(node) || typeof node.value !== 'string')
      throw error('Неподдерживаемое подключение frontend в YAML');
    const included = await document(resolve(dirname(file.path), node.value));
    return follow(included, included.doc.contents, depth + 1);
  }
  const main = await document(join(root, 'configuration.yaml'));
  if (!isMap(main.doc.contents)) throw error('Корень configuration.yaml должен быть словарём');
  let frontend = main.doc.get('frontend', true);
  if (!frontend || (isScalar(frontend) && frontend.value === null && !frontend.tag)) {
    frontend = main.doc.createNode({});
    main.doc.set('frontend', frontend);
  }
  let { file, node } = await follow(main, frontend);
  if (!isMap(node) || node.tag)
    throw error('Неподдерживаемый формат frontend; конфигурация сохранена без изменений');
  let modules = node.get('extra_module_url', true);
  if (!modules || (isScalar(modules) && modules.value === null && !modules.tag)) {
    modules = file.doc.createNode([]);
    node.set('extra_module_url', modules);
  }
  const included = await follow(file, modules);
  file = included.file;
  modules = included.node;
  if (!isSeq(modules) || modules.tag) throw error('extra_module_url должен содержать список модулей');
  let existing = false;
  for (const item of modules.items) {
    if (
      isScalar(item) &&
      typeof item.value === 'string' &&
      (item.value === modulePath || item.value.startsWith(modulePath + '?'))
    ) {
      existing = true;
      if (!sameModule) item.value = desiredUrl;
    }
  }
  if (!existing) modules.add(desiredUrl);
  for (const item of documents.values()) {
    // Preserve files byte for byte when the parsed content was not edited.
    const original = parse(item.before);
    if (String(original) !== String(item.doc))
      writes.push({ path: item.path, before: item.before, after: String(item.doc), mode: item.mode });
  }
  if (!sameModule) writes.unshift({ path: output, before: beforeModule, after: moduleSource, mode: 0o644 });
  return { root, writes, fingerprint: hash(JSON.stringify(writes.map((w) => [w.path, w.after]))) };
}

export async function supervisorRequest(path) {
  if (!process.env.SUPERVISOR_TOKEN) throw error('Не предоставлен доступ к Supervisor');
  const response = await fetch('http://supervisor' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.SUPERVISOR_TOKEN, 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(path === '/core/check' ? 120000 : 15000),
  });
  const result = await response.json();
  if (!response.ok || result.result !== 'ok') throw error('Supervisor не выполнил ' + path);
}

// The private journal is also a backup. It is written before any HA file changes.
export async function installSidebar({
  configRoot = '/homeassistant',
  dataDirectory = '/data',
  moduleSource,
  request = supervisorRequest,
  onStatus = () => {},
} = {}) {
  await mkdir(dataDirectory, { recursive: true });
  const journalPath = join(dataDirectory, 'sls-sidebar-install.json');
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw error('Не удалось прочитать журнал установки иконки');
  }
  const save = () => atomicWrite(journalPath, JSON.stringify(journal, null, 2));
  const status = (state, message = null) => {
    const result = { state, message };
    onStatus(result);
    return result;
  };
  if (journal?.phase === 'restart_requested')
    return status(
      'restart_pending',
      'Иконка установлена. Если HA ещё не перезапустился, перезапустите его вручную; повторная команда не отправляется.',
    );
  if (journal?.phase === 'failed')
    return status(
      'error',
      'Автоустановка иконки остановлена. Проверьте журнал SLS; резервная копия сохранена в данных приложения.',
    );
  if (!journal || journal.phase === 'installed') {
    const plan = await planSidebar(configRoot, moduleSource);
    if (!plan.writes.length) return status('installed');
    journal = { ...plan, phase: 'prepared' };
    await save();
  }
  const root = await realpath(configRoot);
  if (journal.root !== root) throw error('Каталог HA изменился; установка иконки остановлена');
  try {
    status('installing', 'Устанавливаем иконку SLS. После проверки конфигурации HA перезапустится один раз.');
    for (const write of journal.writes) {
      const current = await readOptional(write.path);
      await inside(root, write.path, current === null);
      if (current !== write.before && current !== write.after)
        throw error('Конфигурация HA изменена одновременно; установка иконки остановлена');
      if (current !== write.after) await atomicWrite(write.path, write.after, write.mode);
    }
    await request('/core/check');
    // A concurrent edit after validation must not trigger an unchecked restart.
    for (const write of journal.writes)
      if ((await readOptional(write.path)) !== write.after)
        throw error('Конфигурация HA изменилась после проверки');
    journal.phase = 'restart_requested';
    await save();
  } catch (e) {
    for (const write of [...journal.writes].reverse()) {
      if ((await readOptional(write.path)) !== write.after) continue;
      await inside(root, write.path);
      if (write.before === null) await unlink(write.path);
      else await atomicWrite(write.path, write.before, write.mode);
    }
    journal.phase = 'failed';
    await save();
    status(
      'error',
      'Установка иконки отменена: конфигурация HA не прошла проверку или была изменена. Подробности в журнале SLS.',
    );
    throw e;
  }
  // Persist before sending, so an uncertain response cannot cause a restart loop.
  try {
    await request('/core/restart');
    journal.phase = 'installed';
    await save();
    return status('installed');
  } catch {
    return status(
      'restart_pending',
      'Иконка установлена; подтверждение перезапуска HA не получено. Повторная команда не отправляется.',
    );
  }
}
