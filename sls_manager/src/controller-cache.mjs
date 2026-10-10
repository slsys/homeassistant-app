import { mkdir, open, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';

export const OFFLINE_TIMEOUT = 180000;
const MAX_BYTES = 2 * 1024 * 1024;
const string = (value, max = 200) =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : undefined;
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : undefined);
const boolean = (value) => (typeof value === 'boolean' ? value : undefined);
const fields = (value, schema) =>
  Object.fromEntries(
    Object.entries(schema)
      .map(([key, clean]) => [key, clean(value?.[key])])
      .filter(([, item]) => item !== undefined),
  );
const ipv4 = (value) =>
  typeof value === 'string' && isIPv4(value) && value !== '0.0.0.0' ? value : undefined;
const prefix = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[+#\x00-\x1f]/.test(value)
    ? value
    : undefined;
const mac = (value) =>
  /^(?:[a-f\d]{2}:){5}[a-f\d]{2}$/i.test(value || '') ? value.toUpperCase() : undefined;
const metadata = {
  name: string,
  address: ipv4,
  board: string,
  version: string,
  uptime: number,
  lastSeen: number,
};

// Explicit field lists keep credentials, connection flags and reboot evidence out of the cache.
export function cachedLocal(value) {
  const result = fields(value, {
    ...metadata,
    id: mac,
    advertisedAddress: ipv4,
    hardware: number,
    revision: number,
  });
  return result.id && result.address && result.lastSeen !== undefined ? result : null;
}
export function cachedMqtt(value) {
  const result = fields(value, {
    ...metadata,
    mqttPrefix: prefix,
    memory: number,
    lastDataAt: number,
    observedAt: number,
  });
  return result.mqttPrefix ? { ...result, id: 'mqtt:' + result.mqttPrefix } : null;
}
export function cachedHttp(value) {
  const result = fields(value, {
    id: string,
    address: string,
    lastSuccess: number,
    lastDataAt: number,
    uptime: number,
    uptimeAt: number,
  });
  if (!result.id || !result.address) return null;
  result.info = fields(value.info, {
    board: string,
    version: string,
    hostname: string,
    mem_heap_free: number,
    mem_psram_free: number,
    mem_psram_total: number,
    services: (v) =>
      Array.isArray(v)
        ? v
            .slice(0, 16)
            .map((item) => string(item, 40))
            .filter(Boolean)
        : undefined,
  });
  result.mqtt = fields(value.mqtt, {
    prefix,
    discoveryPrefix: prefix,
    enabled: boolean,
    discovery: boolean,
    server: string,
    port: number,
    retain: boolean,
    friendlyNames: boolean,
  });
  result.coordinator = fields(value.coordinator, { device_count: number });
  result.coordinator.coordinator = fields(value.coordinator?.coordinator, {
    channel: number,
    state: number,
    ieee_addr: string,
  });
  return result;
}
function clean(document) {
  const list = (key, limit, convert) =>
    Array.isArray(document?.[key]) ? document[key].slice(-limit).map(convert).filter(Boolean) : [];
  return {
    version: 1,
    local: list('local', 512, cachedLocal),
    mqtt: list('mqtt', 512, cachedMqtt),
    http: list('http', 64, cachedHttp),
  };
}

export class ControllerCache {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'controller-cache.json');
    this.data = clean({});
    this.pending = Promise.resolve();
    this.error = null;
  }
  async load() {
    let file;
    try {
      file = await open(this.file, 'r');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_BYTES) throw new Error('Cache too large');
      const document = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (document.version !== 1) throw new Error('Unsupported cache version');
      this.data = clean(document);
      this.previous = JSON.stringify(this.data);
    } catch (error) {
      if (error.code !== 'ENOENT')
        this.error = 'Не удалось прочитать последние данные контроллеров. Ожидаем новые сообщения.';
    } finally {
      await file?.close();
    }
  }
  save(data) {
    const document = clean(data);
    const contents = JSON.stringify(document);
    const write = async () => {
      if (contents === this.previous) {
        this.error = null;
        return;
      }
      try {
        if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('Cache too large');
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(this.file + '.tmp', contents, { mode: 0o600 });
        await rename(this.file + '.tmp', this.file);
        this.data = document;
        this.previous = contents;
        this.error = null;
      } catch (error) {
        this.error =
          'Не удалось сохранить последние данные контроллеров. Проверьте свободное место и журнал SLS.';
        throw error;
      }
    };
    this.pending = this.pending.catch(() => {}).then(write);
    return this.pending;
  }
}
