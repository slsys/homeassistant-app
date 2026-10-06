import dgram from 'node:dgram';
import { isIPv4 } from 'node:net';
import { mkdir, readdir, stat, open, unlink, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayError } from './gateway.mjs';

const MiB = 1024 * 1024;
const legacyLogName = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9-]+\.log$/;
const namedLogName =
  /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,47}_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.log$/u;
const isLogName = (name) =>
  typeof name === 'string' && (legacyLogName.test(name) || namedLogName.test(name));

function filePrefix(name) {
  const safe = String(name || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return [...safe].slice(0, 48).join('') || 'SLS';
}

export const UDP_DEFAULTS = Object.freeze({
  source: '',
  host: '',
  port: 5514,
  sizeMiB: 10,
  count: 20,
});
export function unicastIPv4(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const octets = value.split('.').map(Number);
  return octets[0] > 0 && octets[0] < 224 && value !== '255.255.255.255';
}
export function validateUdpConfig(input, reservedPort = 8881, { allowMissingSource = false } = {}) {
  if (
    (!(allowMissingSource && input.source === '') && !unicastIPv4(input.source)) ||
    (input.host && !unicastIPv4(input.host))
  )
    throw new GatewayError('Укажите IPv4 контроллера и корректный адрес получателя', 'validation');
  for (const [key, min, max] of [
    ['port', 1, 65535],
    ['sizeMiB', 1, 1024],
    ['count', 1, 1000],
  ]) {
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max)
      throw new GatewayError(`Некорректное значение ${key}: ${min}–${max}`, 'validation');
  }
  if (input.port === reservedPort)
    throw new GatewayError(
      'Этот UDP-порт занят LocalLink. Выберите отдельный порт для лога.',
      'validation',
    );
  return {
    source: input.source,
    host: input.host || '',
    port: input.port,
    sizeMiB: input.sizeMiB,
    count: input.count,
  };
}

// One socket per port, one bounded write queue per controller. Nothing here depends on UI polling.
export class UdpLog {
  constructor(directory, { reservedPort = 8881 } = {}) {
    this.root = resolve(directory, 'udp-logs');
    this.reservedPort = reservedPort;
    this.sessions = new Map();
    this.sockets = new Map();
    this.closed = false;
  }
  directory(id) {
    if (!/^[a-zA-Z0-9-]+$/.test(id))
      throw new GatewayError('Некорректный контроллер', 'validation');
    const path = resolve(this.root, id);
    if (dirname(path) !== this.root) throw new GatewayError('Некорректный путь', 'validation');
    return path;
  }
  session(id) {
    if (!this.sessions.has(id))
      this.sessions.set(id, {
        id,
        sessionId: randomUUID(),
        name: 'SLS',
        receiving: false,
        config: { ...UDP_DEFAULTS },
        tail: Promise.resolve(),
        active: null,
        queuedBytes: 0,
        lines: [],
        lineBytes: 0,
        sequence: 0,
        lastReceived: null,
        lastWritten: null,
        dropped: 0,
        error: null,
        removing: false,
      });
    return this.sessions.get(id);
  }
  serial(session, action) {
    const pending = session.tail.catch(() => {}).then(action);
    session.tail = pending;
    return pending;
  }
  assertAvailable(id, config) {
    for (const other of this.sessions.values()) {
      if (
        other.id !== id &&
        other.receiving &&
        config.source &&
        other.config.source === config.source &&
        other.config.port === config.port
      )
        throw new GatewayError(
          'Этот IP и UDP-порт уже используются другим контроллером',
          'validation',
        );
    }
  }
  async configure(id, config, name = 'SLS') {
    if (this.closed) throw new GatewayError('Приложение останавливается');
    config = validateUdpConfig(config, this.reservedPort, { allowMissingSource: true });
    this.assertAvailable(id, config);
    const session = this.session(id);
    // Exclude incoming packets while draining the previous configuration.
    session.receiving = false;
    try {
      await this.serial(session, async () => {
        session.active = null;
        await mkdir(this.directory(id), { recursive: true, mode: 0o700 });
        session.config = { ...config };
        session.name = name;
        try {
          await this.prune(session, config.count);
          session.error = null;
          session.receiving = true;
        } catch (error) {
          session.error = `Не удалось применить предел архива: ${error.code || 'ошибка записи'}`;
          throw error;
        }
      });
    } finally {
      this.syncSockets();
    }
  }
  async track(entry) {
    if (this.closed) return;
    const session = this.session(entry.id);
    try {
      // Ignore the old enabled flag: reception now runs for every tracked controller.
      const config = validateUdpConfig({ ...UDP_DEFAULTS, ...entry.udpLog }, this.reservedPort, {
        allowMissingSource: true,
      });
      const name = entry.name || 'SLS';
      if (
        session.receiving &&
        session.name === name &&
        Object.keys(config).every((key) => session.config[key] === config[key])
      )
        return;
      await this.configure(entry.id, config, name);
    } catch (error) {
      session.receiving = false;
      session.error = error.message;
      this.syncSockets();
    }
  }
  async start(entries) {
    if (this.closed) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Clean archives left by a crash during controller removal; never follow symlinks.
    const saved = new Set(entries.map((entry) => entry.id));
    for (const dir of await readdir(this.root, { withFileTypes: true })) {
      if (dir.isDirectory() && /^[a-zA-Z0-9-]+$/.test(dir.name) && !saved.has(dir.name))
        await rm(this.directory(dir.name), { recursive: true, force: true });
    }
    for (const entry of entries) {
      await this.track(entry);
    }
  }
  syncSockets() {
    if (this.closed) return;
    const ports = new Set(
      [...this.sessions.values()]
        .filter((s) => s.receiving && !s.removing)
        .map((s) => s.config.port),
    );
    for (const [port, record] of this.sockets) {
      if (ports.has(port)) continue;
      clearTimeout(record.retry);
      try {
        record.socket?.close();
      } catch {}
      this.sockets.delete(port);
    }
    for (const port of ports) if (!this.sockets.has(port)) this.bind(port);
  }
  bind(port) {
    const socket = dgram.createSocket('udp4');
    const record = { socket, ready: false, error: null, retry: null };
    this.sockets.set(port, record);
    socket.on('message', (buffer, peer) => this.receive(port, peer.address, buffer));
    socket.on('error', (error) => {
      record.ready = false;
      record.error = `Не удалось слушать UDP ${port}: ${error.code || 'ошибка сокета'}`;
      try {
        socket.close();
      } catch {}
      record.retry = setTimeout(() => {
        if (this.closed || this.sockets.get(port) !== record) return;
        this.sockets.delete(port);
        this.syncSockets();
      }, 10000).unref();
    });
    socket.once('listening', () => {
      record.ready = true;
      record.error = null;
    });
    socket.bind(port, '0.0.0.0');
    socket.unref();
  }
  receive(port, source, buffer) {
    if (this.closed || buffer.length > 65507 || !buffer.length) return;
    const session = [...this.sessions.values()].find(
      (s) => !s.removing && s.receiving && s.config.port === port && s.config.source === source,
    );
    if (!session) return;
    // Reject unrelated UDP traffic. Preserve the controller's original bytes and milliseconds.
    if (!/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(buffer.toString('utf8', 0, 16))) return;
    session.lastReceived = Date.now();
    if (session.queuedBytes + buffer.length > MiB) {
      session.dropped++;
      return;
    }
    session.queuedBytes += buffer.length;
    void this.serial(session, async () => {
      try {
        if (session.removing) return;
        await this.append(session, buffer);
        session.lastWritten = Date.now();
        session.error = null;
        session.lines.push({
          id: ++session.sequence,
          text: buffer.toString('utf8').replace(/\r?\n$/, ''),
          receivedAt: session.lastReceived,
          bytes: buffer.length,
        });
        session.lineBytes += buffer.length;
        while (session.lines.length > 500 || session.lineBytes > MiB)
          session.lineBytes -= session.lines.shift().bytes;
      } catch (error) {
        session.dropped++;
        session.error = `Ошибка записи лога: ${error.code || 'ошибка файловой системы'}`;
        session.active = null;
      } finally {
        session.queuedBytes -= buffer.length;
      }
    }).catch(() => {});
  }
  async append(session, buffer) {
    if (!session.active || session.active.size + buffer.length > session.config.sizeMiB * MiB) {
      session.active = null;
      await this.prune(session, session.config.count - 1);
      const base = filePrefix(session.name) + '_' + new Date().toISOString().replace(/[:.]/g, '-');
      // Exclusive creation also handles a restart or rotation within the same millisecond.
      for (let index = 0; ; index++) {
        const name = base + (index ? '-' + index : '') + '.log';
        try {
          const handle = await open(join(this.directory(session.id), name), 'wx', 0o600);
          await handle.close();
          session.active = { name, size: 0 };
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
    }
    const handle = await open(join(this.directory(session.id), session.active.name), 'a');
    try {
      await handle.writeFile(buffer);
      session.active.size += buffer.length;
    } finally {
      await handle.close();
    }
  }
  async files(id) {
    const directory = this.directory(id);
    let names;
    try {
      names = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const item of names) {
      if (!item.isFile() || !isLogName(item.name)) continue;
      try {
        const info = await stat(join(directory, item.name));
        files.push({
          name: item.name,
          size: info.size,
          start: info.birthtimeMs,
          end: info.mtimeMs,
          active: this.sessions.get(id)?.active?.name === item.name,
        });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return files.sort((a, b) => a.start - b.start || a.end - b.end || a.name.localeCompare(b.name));
  }
  async prune(session, keep) {
    const files = await this.files(session.id);
    for (const file of files.slice(0, Math.max(0, files.length - keep)))
      await unlink(join(this.directory(session.id), file.name));
  }
  async snapshot(id) {
    const session = this.session(id),
      config = session.config;
    const files = await this.files(id),
      socket = this.sockets.get(config.port);
    return {
      sessionId: session.sessionId,
      config,
      files: files.reverse(),
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      limitBytes: config.sizeMiB * MiB * config.count,
      listening: Boolean(session.receiving && socket?.ready),
      error: session.error || (session.receiving && socket?.error) || null,
      lastReceived: session.lastReceived,
      lastWritten: session.lastWritten,
      dropped: session.dropped,
      lines: session.lines,
      sequence: session.sequence,
    };
  }
  async read(id, name, { download = false } = {}) {
    if (!isLogName(name)) throw new GatewayError('Некорректное имя файла', 'validation');
    if (!(await this.files(id)).some((file) => file.name === name))
      throw new GatewayError('Файл не найден', 'not_found');
    let handle;
    try {
      handle = await open(join(this.directory(id), name), 'r');
    } catch (error) {
      if (error.code === 'ENOENT') throw new GatewayError('Файл уже удалён', 'not_found');
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (download && size)
        return {
          size,
          stream: handle.createReadStream({ start: 0, end: size - 1, autoClose: true }),
        };
      const start = Math.max(0, size - 256 * 1024),
        buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1);
      await handle.close();
      return { size, text, truncated: start > 0 };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async deleteFile(id, name) {
    const session = this.session(id);
    return this.serial(session, async () => {
      if (session.active?.name === name)
        throw new GatewayError(
          'Этот файл ещё записывается. Его можно удалить после перехода к следующему файлу.',
          'validation',
        );
      if (!isLogName(name) || !(await this.files(id)).some((file) => file.name === name))
        throw new GatewayError('Файл не найден', 'not_found');
      await unlink(join(this.directory(id), name));
    });
  }
  async remove(id) {
    const session = this.session(id);
    session.removing = true;
    this.syncSockets();
    try {
      await this.serial(session, () => rm(this.directory(id), { recursive: true, force: true }));
      this.sessions.delete(id);
    } catch (error) {
      session.removing = false;
      this.syncSockets();
      throw error;
    }
  }
  async close() {
    this.closed = true;
    for (const record of this.sockets.values()) {
      clearTimeout(record.retry);
      try {
        record.socket.close();
      } catch {}
    }
    this.sockets.clear();
    await Promise.allSettled([...this.sessions.values()].map((session) => session.tail));
  }
}
