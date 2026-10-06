import luaparse from 'luaparse';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { requestGateway, GatewayError } from './gateway.mjs';
import { unicastIPv4 } from './udp-log.mjs';

const BEGIN = '-- SLS APP UDP LOG BEGIN';
const END = '-- SLS APP UDP LOG END';
const MAX_SCRIPT = 16 * 1024;
const literal = (text) =>
  '"' +
  [...Buffer.from(text, 'utf8')].map((byte) => '\\' + String(byte).padStart(3, '0')).join('') +
  '"';
const parse = (text) =>
  luaparse.parse(text, { luaVersion: '5.3', locations: true, ranges: true, comments: true });
const member = (node) =>
  node?.type === 'MemberExpression' &&
  node.base?.type === 'Identifier' &&
  node.base.name === 'os' &&
  node.identifier?.name === 'udplogenable';

export function inspectInit(source) {
  const result = { safe: true, reason: null, calls: [], managed: null };
  const block = (reason) => {
    result.safe = false;
    result.reason ||= reason;
  };
  let tree;
  try {
    tree = parse(source);
  } catch {
    return {
      ...result,
      safe: false,
      reason:
        'Синтаксис init.lua не поддерживается автоматическим редактором. Измените автозапуск вручную.',
    };
  }
  const directCalls = new Set(
    tree.body.filter((node) => node.type === 'CallStatement').map((node) => node.expression),
  );
  if (tree.body.some((node) => node.type === 'ReturnStatement' || node.type === 'GotoStatement'))
    block('В init.lua есть return или goto верхнего уровня. Автоматическое изменение недоступно.');
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (member(node)) {
      const call = parent?.type === 'CallExpression' && parent.base === node ? parent : null;
      if (!call || !directCalls.has(call) || node.indexer !== '.')
        block('Найден косвенный или условный вызов UDP-лога. Измените его вручную.');
      if (call) {
        const args = call.arguments;
        const simple =
          args.length >= 1 &&
          args.length <= 3 &&
          args[0]?.type === 'BooleanLiteral' &&
          (!args[1] || ['NumericLiteral', 'NilLiteral'].includes(args[1].type)) &&
          (!args[2] || ['StringLiteral', 'NilLiteral'].includes(args[2].type));
        if (!simple)
          block('Параметры UDP-лога вычисляются скриптом. Автоматическое изменение недоступно.');
        result.calls.push({
          start: call.range[0],
          end: call.range[1],
          line: call.loc.start.line,
          text: source.slice(...call.range),
          enabled: args[0]?.value,
        });
      }
    }
    if (
      node.type === 'Identifier' &&
      node.name === 'os' &&
      !(parent?.type === 'MemberExpression' && parent.base === node)
    )
      block(
        'В init.lua используется переопределение или косвенная ссылка на os. Измените автозапуск вручную.',
      );
    if (
      node.type === 'Identifier' &&
      [
        '_G',
        '_ENV',
        'load',
        'loadstring',
        'loadfile',
        'dofile',
        'require',
        'rawset',
        'setmetatable',
      ].includes(node.name)
    )
      block(
        'В init.lua есть динамическое выполнение или изменение окружения. Автоматическое изменение недоступно.',
      );
    if (
      node.type === 'MemberExpression' &&
      node.base?.name === 'os' &&
      ['exec', 'execute', 'eval', 'evalFile', 'script'].includes(node.identifier?.name)
    )
      block('init.lua запускает другой скрипт. Проверьте настройку UDP-лога вручную.');
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'range', 'comments'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach((item) => visit(item, node));
      else if (child && typeof child === 'object') visit(child, node);
    }
  }
  visit(tree, null);
  if (result.calls.length > 1)
    block('В init.lua несколько вызовов UDP-лога. Выберите нужную логику вручную.');
  const starts = tree.comments.filter((node) => node.raw === BEGIN);
  const ends = tree.comments.filter((node) => node.raw === END);
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0].range[0] >= ends[0].range[0])
      block('Повреждены границы блока UDP-лога приложения.');
    else {
      const start = starts[0].range[0],
        end = ends[0].range[1];
      const inside = source.slice(starts[0].range[1], ends[0].range[0]).trim();
      if (result.calls.length !== 1 || inside !== result.calls[0].text)
        block('Блок приложения был изменён вручную. Автоматическая замена недоступна.');
      else result.managed = { start, end };
    }
  }
  return result;
}

export function planInit(source, enabled, host, port) {
  const inspection = inspectInit(source);
  if (!inspection.safe) throw new GatewayError(inspection.reason, 'validation');
  const command = enabled ? `os.udplogenable(true, ${port}, "${host}")` : 'os.udplogenable(false)';
  let next;
  if (inspection.managed) {
    const { start, end } = inspection.managed;
    next =
      source.slice(0, start) + (enabled ? `${BEGIN}\n${command}\n${END}` : '') + source.slice(end);
  } else if (inspection.calls.length) {
    const call = inspection.calls[0];
    next = source.slice(0, call.start) + command + source.slice(call.end);
  } else if (enabled) {
    next =
      source + (source.endsWith('\n') || !source ? '' : '\n') + `${BEGIN}\n${command}\n${END}\n`;
  } else next = source;
  try {
    parse(next);
  } catch {
    throw new GatewayError('Невозможно безопасно добавить блок в конец init.lua', 'validation');
  }
  if (Buffer.byteLength(next) > MAX_SCRIPT)
    throw new GatewayError(
      'init.lua превышает предел автоматического редактирования: 16 КиБ',
      'validation',
    );
  return { inspection, next, command, changed: source !== next };
}

export class UdpSender {
  constructor(collector, request = requestGateway) {
    this.collector = collector;
    this.request = request;
    this.plans = new Map();
    this.status = new Map();
  }
  async evaluate(entry, code) {
    const response = await this.request(entry, '/api/scripts?action=evalCode', {
      form: { plain: code },
      limit: 64 * 1024,
    });
    if (typeof response?.result !== 'string')
      throw new GatewayError('Прошивка не вернула результат выполнения Lua', 'protocol');
    return response.result;
  }
  async readInit(entry) {
    const exists = await this.evaluate(
      entry,
      'if os.fileExists("/init.lua") then print("SLS_INIT_PRESENT") else print("SLS_INIT_ABSENT") end',
    );
    if (exists.trim() === 'SLS_INIT_ABSENT') return { source: '', exists: false };
    if (exists.trim() !== 'SLS_INIT_PRESENT')
      throw new GatewayError('Не удалось проверить наличие init.lua');
    const source = await this.request(entry, '/api/files?path=%2Finit.lua', {
      text: true,
      limit: MAX_SCRIPT,
    });
    if (typeof source !== 'string' || source.includes('\0'))
      throw new GatewayError('Неподдерживаемое содержимое init.lua');
    return { source, exists: true };
  }
  async inspect(entry) {
    const { source, exists } = await this.readInit(entry);
    return {
      ...inspectInit(source),
      exists,
      checkedAt: Date.now(),
      runtime: this.status.get(entry.id) || null,
    };
  }
  async preview(entry, input) {
    if (typeof input.enabled !== 'boolean' || typeof input.persistent !== 'boolean')
      throw new GatewayError('Некорректный режим отправки', 'validation');
    if (
      input.enabled &&
      (!unicastIPv4(input.host) ||
        !Number.isInteger(input.port) ||
        input.port < 1 ||
        input.port > 65535 ||
        input.port === this.collector.reservedPort)
    )
      throw new GatewayError('Укажите IPv4 получателя и отдельный UDP-порт', 'validation');
    let original = null,
      next = null,
      inspection = null,
      changed = false;
    if (input.persistent) {
      original = await this.readInit(entry);
      const plan = planInit(original.source, input.enabled, input.host, input.port);
      ({ next, inspection, changed } = plan);
    }
    const command = input.enabled
      ? `os.udplogenable(true, ${input.port}, "${input.host}")`
      : 'os.udplogenable(false)';
    const token = randomUUID();
    this.plans.set(entry.id, {
      token,
      expires: Date.now() + 5 * 60000,
      address: entry.address,
      credential: entry.token,
      original,
      next,
      command,
      changed,
      enabled: input.enabled,
      persistent: input.persistent,
    });
    return {
      token,
      inspection,
      before: original?.source ?? null,
      after: next,
      command,
      changed,
      persistent: input.persistent,
      message: input.persistent
        ? input.enabled
          ? 'Включить сейчас и настроить автозапуск'
          : 'Выключить сейчас и отменить автозапуск'
        : input.enabled
          ? 'Включить сейчас; init.lua не изменяется'
          : 'Выключить сейчас; автозапуск в init.lua сохраняется',
    };
  }
  async apply(entry, token) {
    const plan = this.plans.get(entry.id);
    this.plans.delete(entry.id);
    if (
      !plan ||
      plan.token !== token ||
      plan.expires < Date.now() ||
      plan.address !== entry.address ||
      plan.credential !== entry.token
    )
      throw new GatewayError('Предпросмотр устарел. Проверьте изменения заново.', 'validation');
    this.status.set(entry.id, {
      state: 'unknown',
      at: Date.now(),
      message: 'Команда ещё не подтверждена',
    });
    let initSaved = false;
    try {
      if (plan.changed) {
        const fresh = await this.readInit(entry);
        if (fresh.exists !== plan.original.exists || fresh.source !== plan.original.source)
          throw new GatewayError(
            'init.lua изменился после предпросмотра. Повторите проверку.',
            'validation',
          );
        const backupDirectory = join(this.collector.directory(entry.id), 'init-backups');
        await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
        await writeFile(
          join(backupDirectory, `${Date.now()}-${plan.token}.json`),
          JSON.stringify({ exists: fresh.exists, source: fresh.source }),
          { flag: 'wx', mode: 0o600 },
        );
        const backups = (await readdir(backupDirectory))
          .filter((name) => /^\d+-[a-f0-9-]+\.json$/.test(name))
          .sort();
        for (const name of backups.slice(0, -10)) await unlink(join(backupDirectory, name));
        // Compile without running the user's init script. Verify a temporary file before
        // renaming it over init.lua; firmware without rename/compile support leaves init intact.
        const temp = '/sls-udp-' + plan.token + '.tmp';
        const code =
          `local p="/init.lua"\nlocal expected=${fresh.exists ? literal(fresh.source) : 'nil'}\nlocal candidate=${literal(plan.next)}\nlocal tmp=${literal(temp)}\n` +
          'local compiler=loadstring or load\nassert(type(compiler)=="function","Compiler unavailable")\nassert(compiler(candidate))\n' +
          'local function unchanged() return os.fileExists(p)==(expected~=nil) and os.fileRead(p)==expected end\nassert(unchanged(),"Init changed")\n' +
          'assert(os.fileWrite(tmp,candidate),"Temporary write failed")\nif os.fileRead(tmp)~=candidate then os.fileRemove(tmp); error("Temporary verification failed") end\n' +
          'if not unchanged() then os.fileRemove(tmp); error("Init changed") end\n' +
          'if not os.fileRename(tmp,p) then os.fileRemove(tmp); error("Rename failed; init unchanged") end\n' +
          'assert(os.fileRead(p)==candidate,"Init verification failed")\nprint("SLS_UDP_INIT_SAVED")';
        const output = await this.evaluate(entry, code);
        if (output.trim() !== 'SLS_UDP_INIT_SAVED')
          throw new GatewayError(
            'Подтверждение записи init.lua не получено. Проверьте файл перед повторной попыткой.',
          );
        initSaved = true;
        const verified = await this.readInit(entry);
        if (verified.source !== plan.next)
          throw new GatewayError(
            'Проверка init.lua после записи не пройдена. Резервная копия сохранена.',
          );
      }
      const output = await this.evaluate(entry, plan.command + '\nprint("SLS_UDP_COMMAND_OK")');
      if (output.trim() !== 'SLS_UDP_COMMAND_OK')
        throw new GatewayError('Подтверждение команды не получено. Состояние отправки неизвестно.');
      const status = {
        state: plan.enabled ? 'enabled' : 'disabled',
        at: Date.now(),
        initSaved,
        persistent: plan.persistent,
        message: plan.enabled
          ? 'Команда включения выполнена; получение пакетов проверяется отдельно'
          : 'Команда выключения выполнена',
      };
      this.status.set(entry.id, status);
      return status;
    } catch (error) {
      const message =
        (initSaved ? 'init.lua сохранён, но дальнейшая операция не подтверждена. ' : '') +
        error.message;
      this.status.set(entry.id, { state: 'unknown', at: Date.now(), initSaved, message });
      throw new GatewayError(message, error.code);
    }
  }
  remove(id) {
    this.plans.delete(id);
    this.status.delete(id);
  }
}
