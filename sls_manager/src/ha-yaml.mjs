import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { parseDocument } from 'yaml';

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const mapping = (value) => value && typeof value === 'object' && !Array.isArray(value);
const tags = [
  '!include',
  '!include_dir_list',
  '!include_dir_named',
  '!include_dir_merge_list',
  '!include_dir_merge_named',
  '!secret',
  '!env_var',
  '!input',
].map((tag) => ({ tag, resolve: (value) => ({ yamlTag: tag, value }) }));

// Read only files reachable from configuration.yaml. Never resolve secrets or execute templates.
export async function readYamlObjects(directory = '/homeassistant') {
  const warnings = new Set();
  const objects = [];
  let root;
  let omittedWarnings = 0;
  const failure = (file, reason) => Object.assign(new Error(reason), { yamlFile: file, yamlReason: reason });
  function report(error, file) {
    const name =
      relative(root || directory, error.yamlFile || file).replaceAll('\\', '/') || 'configuration.yaml';
    const reasons = {
      ENOENT: 'файл или папка не найдены',
      EACCES: 'нет доступа на чтение',
      EPERM: 'нет доступа на чтение',
      ENOTDIR: 'ожидалась папка',
      EISDIR: 'ожидался файл',
    };
    const reason = error.yamlReason || reasons[error.code] || 'не удалось прочитать или разобрать файл';
    const message = 'YAML: ' + name + ' — ' + reason + '.';
    if (warnings.has(message)) return;
    if (warnings.size < 12) warnings.add(message);
    else omittedWarnings++;
  }
  try {
    root = await realpath(directory);
  } catch (error) {
    report(error, directory);
    return { objects, warnings: [...warnings] };
  }
  let count = 0,
    bytes = 0;
  function confined(file) {
    const rel = relative(root, file);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
      throw failure(file, 'путь выходит за пределы конфигурации HA');
    return file;
  }
  function includePath(from, value) {
    // Core sees /config; the same directory is mounted as /homeassistant in the app.
    const name = String(value);
    const mounted = /^\/(?:config|homeassistant)(?:\/|$)/.exec(name);
    return confined(mounted ? resolve(root, name.slice(mounted[0].length)) : resolve(dirname(from), name));
  }
  async function load(file, parents = []) {
    try {
      if (parents.length >= 20) throw failure(file, 'глубина включений превышает 20 уровней');
      if (++count > 512) throw failure(file, 'превышен предел чтения 512 файлов');
      const path = confined(await realpath(confined(file)));
      const rel = relative(root, path);
      if (parents.includes(path)) throw failure(path, 'циклическое включение');
      const size = (await stat(path)).size;
      if (size > 2097152) throw failure(path, 'размер файла превышает 2 МиБ');
      bytes += size;
      if (bytes > 16777216) throw failure(path, 'суммарный объём чтения превышает 16 МиБ');
      const doc = parseDocument(await readFile(path, 'utf8'), {
        customTags: tags,
        strict: true,
        merge: true,
      });
      if (doc.errors.length) {
        const error = doc.errors[0];
        const position = error.linePos?.[0];
        throw failure(
          path,
          'ошибка YAML ' +
            error.code +
            (position ? ', строка ' + position.line + ', столбец ' + position.col : ''),
        );
      }
      async function safeUnpack(value, depth) {
        try {
          return await unpack(value, depth + 1);
        } catch (error) {
          report(error, path);
          return null;
        }
      }
      async function unpack(value, depth = 0) {
        if (depth > 50) throw failure(path, 'глубина YAML-структуры превышает 50 уровней');
        if (value?.yamlTag) {
          if (['!secret', '!env_var', '!input'].includes(value.yamlTag)) return null;
          const target = includePath(path, value.value);
          if (value.yamlTag === '!include') return load(target, [...parents, path]);
          let checked;
          try {
            checked = confined(await realpath(target));
          } catch (error) {
            // HA directory includes treat a missing directory as an empty collection.
            if (error.code === 'ENOENT') return value.yamlTag.endsWith('_list') ? [] : Object.create(null);
            error.yamlFile ||= target;
            throw error;
          }
          const files = [];
          let folders = 0;
          async function walk(folder, depth = 0) {
            if (depth >= 20 || ++folders > 512)
              throw failure(folder, 'превышен предел обхода папок (20 уровней, 512 папок)');
            for (const entry of await readdir(folder, { withFileTypes: true })) {
              if (entry.name.startsWith('.') || entry.name === 'secrets.yaml' || entry.isSymbolicLink())
                continue;
              const name = resolve(folder, entry.name);
              if (entry.isDirectory()) {
                try {
                  await walk(name, depth + 1);
                } catch (error) {
                  report(error, name);
                }
              } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
                if (files.length >= 512) throw failure(folder, 'в папке включений больше 512 YAML-файлов');
                files.push(name);
              }
            }
          }
          try {
            await walk(checked);
          } catch (error) {
            report(error, checked);
          }
          const items = [];
          for (const name of files.sort()) {
            try {
              items.push([name, await load(name, [...parents, path])]);
            } catch (error) {
              report(error, name);
            }
          }
          if (value.yamlTag === '!include_dir_list')
            return items.map(([, item]) => item).filter((item) => item != null);
          if (value.yamlTag === '!include_dir_merge_list')
            return items.flatMap(([, item]) => (Array.isArray(item) ? item : []));
          const merged = Object.create(null);
          for (const [name, item] of items) {
            if (value.yamlTag === '!include_dir_named')
              merged[basename(name).replace(/\.ya?ml$/i, '')] = item;
            else if (mapping(item)) Object.assign(merged, item);
          }
          return merged;
        }
        if (Array.isArray(value)) {
          const result = [];
          for (const item of value) result.push(await safeUnpack(item, depth));
          return result;
        }
        if (mapping(value)) {
          const result = Object.create(null);
          for (const [key, item] of Object.entries(value)) result[key] = await safeUnpack(item, depth);
          Object.defineProperty(result, '_yamlFile', { value: rel.replaceAll('\\', '/') });
          return result;
        }
        return value;
      }
      let value;
      try {
        value = doc.toJS({ maxAliasCount: 100 });
      } catch {
        throw failure(path, 'превышено ограничение раскрытия YAML-псевдонимов');
      }
      return await unpack(value);
    } catch (error) {
      error.yamlFile ||= file;
      throw error;
    }
  }
  function describe(config, domain, key = null, context = []) {
    if (!mapping(config)) return;
    const topics = new Set(),
      references = new Set(),
      devices = new Set(),
      areas = new Set();
    function scan(value, field = '', depth = 0) {
      if (depth > 30) return;
      if (typeof value === 'string') {
        if (field.endsWith('_topic') || field === 'topic') topics.add(value);
        if (field === 'device_id') devices.add(value);
        if (field === 'area_id') areas.add(value);
        for (const match of value.matchAll(/\b([a-z_]+\.[a-z0-9_]+)\b/g)) references.add(match[1]);
        for (const match of value.matchAll(/\bstates\.([a-z_]+\.[a-z0-9_]+)\b/g)) references.add(match[1]);
      } else if (Array.isArray(value)) value.forEach((v) => scan(v, field, depth + 1));
      else if (mapping(value))
        for (const [k, v] of Object.entries(value)) {
          if (/password|secret|token|credential|api_key/i.test(k)) continue;
          scan(v, k, depth + 1);
        }
    }
    scan(config);
    context.forEach((value) => scan(value));
    objects.push({
      domain,
      uniqueId: config.unique_id == null ? null : String(config.unique_id),
      id: config.id == null ? null : String(config.id),
      entityId:
        config.default_entity_id || (key && ['script', 'group'].includes(domain) ? domain + '.' + key : null),
      name: config.name || config.friendly_name || config.alias || null,
      topics: [...topics],
      references: [...references],
      devices: [...devices],
      areas: [...areas],
      file: config._yamlFile || 'configuration.yaml',
    });
  }
  function collect(config) {
    if (!mapping(config)) return;
    for (const [fullDomain, value] of Object.entries(config)) {
      const domain = fullDomain.split(' ')[0];
      if (domain === 'mqtt') {
        for (const block of list(value))
          if (mapping(block))
            for (const [kind, entries] of Object.entries(block))
              for (const entry of list(entries)) describe(entry, kind);
      } else if (domain === 'template') {
        for (const block of list(value))
          if (mapping(block))
            for (const [kind, entries] of Object.entries(block))
              if (!['trigger', 'triggers', 'action', 'actions'].includes(kind))
                for (const entry of list(entries))
                  describe(entry, kind, null, [block.trigger, block.triggers, block.action, block.actions]);
      } else if (['script', 'group'].includes(domain) && mapping(value)) {
        for (const [key, entry] of Object.entries(value)) describe(entry, domain, key);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry?.sensors && mapping(entry.sensors))
            for (const [key, sensor] of Object.entries(entry.sensors))
              describe({ ...sensor, default_entity_id: domain + '.' + key }, domain);
          else describe(entry, domain);
        }
      }
    }
    for (const item of Object.values(config.homeassistant?.packages || {})) collect(item);
  }
  try {
    collect(await load(resolve(root, 'configuration.yaml')));
  } catch (error) {
    report(error, resolve(root, 'configuration.yaml'));
  }
  if (omittedWarnings) warnings.add('YAML: ещё ошибок: ' + omittedWarnings + '.');
  return { objects: objects.slice(0, 20000), warnings: [...warnings] };
}
