import mqtt from 'mqtt';
import { DiscoveryCatalog } from './discovery-catalog.mjs';
import { randomUUID } from 'node:crypto';
import { isIPv4 } from 'node:net';

const MAX_DEVICES = 512;
const text = (value, max = 150) =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
const validPrefix = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[+#\x00-\x1f]/.test(value);

export async function supervisorMqtt() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new Error('MQTT-поиск доступен при запуске в HAOS');
  const response = await fetch('http://supervisor/services/mqtt', {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Брокер MQTT не предоставлен Home Assistant');
  const result = await response.json();
  const config = result.data;
  if (result.result !== 'ok' || !config?.host) throw new Error('Брокер MQTT не предоставлен Home Assistant');
  const version = config.protocol || '3.1.1';
  if (!['3.1', '3.1.1'].includes(version)) throw new Error('Неподдерживаемая версия протокола брокера MQTT');
  return {
    protocol: config.ssl ? 'mqtts' : 'mqtt',
    protocolVersion: version === '3.1' ? 3 : 4,
    ...(version === '3.1' ? { protocolId: 'MQIsdp' } : {}),
    host: config.host,
    port: Number(config.port) || (config.ssl ? 8883 : 1883),
    username: config.username,
    password: config.password,
  };
}

export class MqttDiscovery {
  constructor({ getConfig = supervisorMqtt, connect = mqtt.connect } = {}) {
    this.getConfig = getConfig;
    this.connect = connect;
    this.devices = new Map();
    this.catalog = new DiscoveryCatalog();
    this.states = new Map();
    this.status = { connected: false, error: null };
    this.stopped = true;
  }
  async start() {
    this.stopped = false;
    try {
      const config = await this.getConfig();
      if (this.stopped) return;
      const client = this.connect({
        ...config,
        clientId: 'sls-discovery-' + randomUUID().slice(0, 8),
        clean: true,
        queueQoSZero: false,
        reconnectPeriod: 10000,
        connectTimeout: 8000,
      });
      this.client = client;
      const on = (event, handler) =>
        client.on(event, (...args) => {
          if (this.client === client && !this.stopped) handler(...args);
        });
      on('connect', () => {
        this.catalog.clear();
        this.status = { connected: true, error: null };
        // Unknown prefixes can have several levels. ingest retains only SLS
        // heartbeats, availability and HA Discovery metadata; never publishes.
        client.subscribe('#', { qos: 0 }, (error, granted) => {
          if (this.client !== client) return;
          if (error || !granted?.length || granted.some((g) => g.qos === 128))
            this.status = { connected: false, error: 'Брокер не разрешил MQTT-поиск (ACL)' };
        });
      });
      const disconnected = () => {
        this.status.connected = false;
        this.states.clear();
        for (const device of this.devices.values()) device.lastSeen = null;
      };
      on('offline', disconnected);
      on('close', disconnected);
      on('error', () => {
        this.status.error = 'Нет подключения к MQTT-брокеру HA: проверьте сервис и ACL';
      });
      on('message', (topic, payload, packet) => this.ingest(topic, payload, packet));
    } catch (error) {
      if (this.stopped) return;
      this.status = { connected: false, error: error.message };
      this.retry = setTimeout(() => this.start(), 60000);
      this.retry.unref();
    }
  }
  ingest(topic, payload, { retain = false } = {}, now = Date.now()) {
    if (payload.length > 65536 || topic.length > 500) return;
    this.catalog.ingest(topic, payload, { retain }, now);
    const bridge = topic.match(/^(.+)\/bridge\/(config|state)$/);
    if (bridge && validPrefix(bridge[1])) {
      const [, prefix, type] = bridge;
      if (type === 'state') {
        const state = payload.toString();
        if (!['online', 'offline'].includes(state)) return;
        if (!this.states.has(prefix) && this.states.size >= MAX_DEVICES)
          this.states.delete(this.states.keys().next().value);
        this.states.set(prefix, state);
        return;
      }
      let data;
      try {
        data = JSON.parse(payload.toString());
      } catch {
        return;
      }
      // Match the firmware SendHearthbeat schema, not Zigbee2MQTT or sensors.
      if (
        !data ||
        !Number.isFinite(data.Uptime) ||
        data.Uptime < 0 ||
        typeof data.IP !== 'string' ||
        !isIPv4(data.IP) ||
        !/^20\d{2}\.\d{2}\.\d{2}[a-z0-9]*$/i.test(data.Version || '') ||
        !Number.isFinite(data.FreeMem) ||
        !Number.isFinite(data.RSSI) ||
        typeof data.log_level !== 'string'
      )
        return;
      const device = this.ensure(prefix, now);
      Object.assign(device, {
        address: data.IP === '0.0.0.0' ? null : data.IP,
        version: text(data.Version),
        uptime: data.Uptime,
        memory: data.FreeMem,
        lastSeen: retain ? device.lastSeen : now,
        lastDataAt: retain ? device.lastDataAt : now,
        observedAt: now,
      });
      if (!retain) {
        device.liveUptime = data.Uptime;
        device.liveUptimeAt = now;
        this.states.set(prefix, 'online');
      }
      return;
    }
    if (!topic.endsWith('/config') || !payload.length) return;
    let data;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const device = data?.device || data?.dev;
    if (!device || (device.manufacturer || device.mf) !== 'SLS') return;
    let availability = data.availability_topic || data.avty_t;
    if (!availability && Array.isArray(data.availability || data.avty)) {
      const entry = (data.availability || data.avty).find(
        (a) => a && /\/bridge\/state$/.test(a.topic || a.t),
      );
      availability = entry?.topic || entry?.t;
    }
    if (typeof availability === 'string' && typeof data['~'] === 'string')
      availability = availability.replace(/^~(?=\/)/, data['~']);
    const prefix = typeof availability === 'string' ? availability.match(/^(.+)\/bridge\/state$/)?.[1] : null;
    if (!validPrefix(prefix)) return;
    const entry = this.ensure(prefix, now);
    Object.assign(entry, {
      name: text(device.name) || entry.name,
      board: text(device.model || device.mdl) || entry.board,
      version: text(device.sw_version || device.sw) || entry.version,
      observedAt: now,
    });
  }
  ensure(prefix, now) {
    if (!this.devices.has(prefix)) {
      if (this.devices.size >= MAX_DEVICES) this.devices.delete(this.devices.keys().next().value);
      this.devices.set(prefix, {
        id: 'mqtt:' + prefix,
        mqttPrefix: prefix,
        name: prefix,
        address: null,
        board: null,
        version: null,
        uptime: null,
        lastSeen: null,
        observedAt: now,
      });
    }
    return this.devices.get(prefix);
  }
  list(now = Date.now()) {
    for (const [prefix, device] of this.devices)
      if (now - device.observedAt > 86400000) this.devices.delete(prefix);
    return [...this.devices.values()].map((device) => ({
      ...device,
      source: 'MQTT',
      mac: null,
      online:
        this.status.connected &&
        this.states.get(device.mqttPrefix) !== 'offline' &&
        device.lastSeen !== null &&
        now - device.lastSeen < 180000,
    }));
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    client?.end(true);
    this.status.connected = false;
  }
}
