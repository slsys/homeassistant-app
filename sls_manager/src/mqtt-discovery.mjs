import mqtt from 'mqtt';
import { HomeAssistantMqttClient } from './mqtt-homeassistant.mjs';
import { DiscoveryCatalog } from './discovery-catalog.mjs';
import { randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { cachedMqtt, OFFLINE_TIMEOUT } from './controller-cache.mjs';

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
  if (!['3.1', '3.1.1', '5'].includes(version)) throw new Error('Неподдерживаемая версия протокола брокера MQTT');
  return {
    protocol: config.ssl ? 'mqtts' : 'mqtt',
    protocolVersion: version === '5' ? 5 : version === '3.1' ? 3 : 4,
    ...(version === '3.1' ? { protocolId: 'MQIsdp' } : {}),
    host: config.host,
    port: Number(config.port) || (config.ssl ? 8883 : 1883),
    username: config.username,
    password: config.password,
  };
}

export async function directMqtt(options = {}) {
  const host = options.mqtt_host?.trim();
  if (!host) return supervisorMqtt();
  if (host.length > 255 || (host.includes(':') ? !isIPv6(host) : !/^[a-zA-Z0-9._-]+$/.test(host)))
    throw new Error('Укажите MQTT-хост без протокола и пути');
  const port = options.mqtt_port ?? 1883;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid mqtt_port');
  const version = options.mqtt_protocol || '3.1.1';
  if (!['3.1.1', '5'].includes(version)) throw new Error('Invalid mqtt_protocol');
  return {
    host,
    port,
    protocol: options.mqtt_tls ? 'mqtts' : 'mqtt',
    protocolVersion: version === '5' ? 5 : 4,
    username: options.mqtt_username || undefined,
    password: options.mqtt_password || undefined,
    rejectUnauthorized: true,
  };
}

export class MqttDiscovery {
  constructor({ mode = 'homeassistant', options = {}, getConfig, connect } = {}) {
    if (!['homeassistant', 'direct'].includes(mode)) throw new Error('Invalid mqtt_mode');
    this.mode = mode;
    this.getConfig = getConfig || (mode === 'direct' ? () => directMqtt(options) : async () => ({}));
    this.connect = connect || (mode === 'direct' ? mqtt.connect : () => new HomeAssistantMqttClient());
    const discoveryPrefix = options.mqtt_discovery_prefix || 'homeassistant';
    if (!validPrefix(discoveryPrefix)) throw new Error('Invalid mqtt_discovery_prefix');
    this.discoveryPrefixes = new Set([discoveryPrefix]);
    this.scanInterval = options.mqtt_scan_interval ?? 300;
    if (!Number.isInteger(this.scanInterval) || this.scanInterval < 120 || this.scanInterval > 3600)
      throw new Error('mqtt_scan_interval must be 120–3600 seconds');
    this.prefixes = new Set();
    this.devices = new Map();
    this.awaiting = new Map();
    this.tracked = new Set();
    this.catalog = new DiscoveryCatalog();
    this.states = new Map();
    this.connection = { ready: false, error: null };
    this.lastPacketAt = null;
    this.liveTopics = new Map();
    this.stopped = true;
  }
  get status() {
    const ready = Boolean(this.client?.connected && this.connection.ready);
    const connected = ready && (this.mode === 'direct' || (this.lastPacketAt !== null && Date.now() - this.lastPacketAt < 180000));
    const label = this.mode === 'homeassistant' ? 'MQTT через HA' : 'MQTT напрямую';
    return {
      mode: this.mode,
      ready,
      connected,
      haConnected: this.mode === 'homeassistant' ? Boolean(this.client?.connected) : null,
      lastMessageAt: this.lastPacketAt,
      scanning: Boolean(this.scanning),
      error: this.connection.error,
      message: this.connection.error || (connected
        ? label + (this.mode === 'homeassistant' ? ': получаем данные' : ': подключён')
        : ready ? label + ': ожидаем сообщения от брокера' : label + ': подключение…'),
    };
  }
  watchPrefix(prefix) {
    if (!validPrefix(prefix) || this.prefixes.has(prefix) || this.prefixes.size >= MAX_DEVICES) return;
    this.prefixes.add(prefix);
    this.scheduleTopics();
  }
  watchDiscoveryPrefix(prefix) {
    if (!validPrefix(prefix) || this.discoveryPrefixes.has(prefix) || this.discoveryPrefixes.size >= 64) return;
    this.discoveryPrefixes.add(prefix);
    this.scheduleTopics();
  }
  desiredTopics() {
    return new Set([
      ...(this.scanning ? ['#'] : []),
      ...[...this.discoveryPrefixes].map((prefix) => prefix + '/#'),
      '+/bridge/config', '+/bridge/state',
      ...[...this.prefixes].map((prefix) => prefix + '/#'),
    ]);
  }
  scheduleTopics() {
    if (!this.client?.connected || this.stopped) return;
    this.topicsDirty = true;
    if (!this.syncingTopics) void this.syncTopics();
  }
  async syncTopics() {
    const client = this.client;
    if (!client?.connected || this.syncingTopics) return;
    const active = this.activeTopics;
    const current = () =>
      this.client === client && this.activeTopics === active && !this.stopped && client.connected;
    const reportFailure = (error) => {
      this.connection.error = this.mode === 'homeassistant'
        ? error.message
        : 'Брокер не подтвердил MQTT-подписку: проверьте доступ и ACL';
      clearTimeout(this.topicRetry);
      this.topicRetry = setTimeout(() => this.scheduleTopics(), 15000).unref();
    };
    this.syncingTopics = true;
    try {
      do {
        this.topicsDirty = false;
        const desired = this.desiredTopics();
        const added = [...desired].filter((topic) => !active.has(topic));
        const removed = [...active].filter((topic) => !desired.has(topic));
        let subscriptionError = null;
        // A broker may deny the broad scan while allowing specific controller
        // topics. Keep those subscriptions working and retry only the missing ones.
        for (const topic of added) {
          try {
            await new Promise((resolve, reject) => client.subscribe([topic], { qos: 0 }, (error, granted) => {
              if (error || !granted?.length || granted.some((item) => item.qos === 128))
                reject(error || new Error('MQTT-подписка запрещена правами брокера'));
              else resolve();
            }));
            if (!current()) return;
            active.add(topic);
          } catch (error) {
            if (!current()) return;
            subscriptionError ||= error;
          }
        }
        if (!current()) return;
        if (removed.length) {
          await new Promise((resolve, reject) => client.unsubscribe(removed, (error) => error ? reject(error) : resolve()));
          if (!current()) return;
          for (const topic of removed) active.delete(topic);
        }
        this.connection.ready = active.size > 0;
        if (subscriptionError) reportFailure(subscriptionError);
        else {
          this.connection.error = null;
          clearTimeout(this.topicRetry);
        }
      } while (this.topicsDirty && current());
    } catch (error) {
      if (current()) {
        this.connection.ready = active.size > 0;
        reportFailure(error);
      }
    } finally {
      this.syncingTopics = false;
      if (this.client?.connected && this.topicsDirty && !this.stopped) this.scheduleTopics();
    }
  }
  beginScan() {
    this.scanning = true;
    clearTimeout(this.scanEnd);
    this.scheduleTopics();
    // A heartbeat is sent about once a minute. Nested, previously unknown prefixes
    // are found during this window, then followed with a dedicated subscription.
    this.scanEnd = setTimeout(() => {
      this.scanning = false;
      this.scheduleTopics();
    }, 75000).unref();
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
        this.liveTopics.clear();
        this.states.clear();
        this.lastPacketAt = null;
        for (const device of this.devices.values()) {
          this.awaiting.set(device.mqttPrefix, this.awaiting.get(device.mqttPrefix) ?? Date.now());
          delete device.liveUptime;
          delete device.liveUptimeAt;
        }
        this.connection = { ready: false, error: null };
        this.activeTopics = new Set();
        clearTimeout(this.topicRetry);
        clearInterval(this.scanTimer);
        this.beginScan();
        this.scanTimer = setInterval(() => this.beginScan(), this.scanInterval * 1000).unref();
      });
      const disconnected = () => {
        this.connection.ready = false;
        this.connection.error ||= this.mode === 'homeassistant'
          ? 'Нет данных через HA: восстанавливаем MQTT-подписки'
          : 'Нет связи с MQTT-брокером';
        this.lastPacketAt = null;
        this.states.clear();
        clearTimeout(this.scanEnd);
        clearTimeout(this.topicRetry);
        clearInterval(this.scanTimer);
        this.scanning = false;
        for (const device of this.devices.values()) {
          this.awaiting.set(device.mqttPrefix, this.awaiting.get(device.mqttPrefix) ?? Date.now());
          delete device.liveUptime;
          delete device.liveUptimeAt;
        }
      };
      on('offline', disconnected);
      on('close', disconnected);
      on('error', (error) => {
        this.connection.error = this.mode === 'homeassistant'
          ? error.message
          : 'Нет подключения к MQTT-брокеру: проверьте адрес, TLS и ACL';
      });
      on('message', (topic, payload, packet) => this.ingest(topic, payload, packet));
    } catch (error) {
      if (this.stopped) return;
      this.connection = { ready: false, error: error.message };
      this.retry = setTimeout(() => this.start(), 60000).unref();
    }
  }
  ingest(topic, payload, { retain = false } = {}, now = Date.now()) {
    if (payload.length > 65536 || topic.length > 500) return;
    this.lastPacketAt = now;
    // Resubscribing during a discovery scan must not replace a fresh observation
    // with an older retained value, or make a command look like controller data.
    if (retain && this.liveTopics.has(topic) && now - this.liveTopics.get(topic) < 180000) return;
    if (!retain) {
      this.liveTopics.delete(topic);
      this.liveTopics.set(topic, now);
      if (this.liveTopics.size > 8192) this.liveTopics.delete(this.liveTopics.keys().next().value);
    }
    this.catalog.ingest(topic, payload, { retain }, now);
    if (!retain && this.catalog.topics.has(topic) && !/\/bridge\/(config|state)$/.test(topic)) {
      for (const device of this.devices.values()) {
        if (topic.startsWith(device.mqttPrefix + '/')) {
          device.lastDataAt = now;
          device.lastSeen = now;
          this.awaiting.delete(device.mqttPrefix);
          this.states.set(device.mqttPrefix, { value: 'online', retain: false, at: now });
        }
      }
    }
    const bridge = topic.match(/^(.+)\/bridge\/(config|state)$/);
    if (bridge && validPrefix(bridge[1])) {
      const [, prefix, type] = bridge;
      if (type === 'state') {
        const state = payload.toString();
        if (!['online', 'offline'].includes(state)) return;
        if (!this.states.has(prefix) && this.states.size >= MAX_DEVICES)
          this.states.delete(this.states.keys().next().value);
        this.states.set(prefix, { value: state, retain, at: now });
        const device = this.devices.get(prefix);
        if (device && !retain) device.lastDataAt = now;
        if (device && !retain && state === 'online') {
          device.lastSeen = now;
          this.awaiting.delete(prefix);
        }
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
      // Retained telemetry has no original timestamp. Fill gaps without replacing a newer cache.
      const values = { address: data.IP === '0.0.0.0' ? null : data.IP, version: text(data.Version), uptime: data.Uptime, memory: data.FreeMem };
      for (const [key, value] of Object.entries(values))
        if (value !== null && value !== '' && (!retain || device[key] == null || device[key] === '')) device[key] = value;
      Object.assign(device, {
        lastSeen: retain ? device.lastSeen : now,
        lastDataAt: retain ? device.lastDataAt : now,
        observedAt: now,
      });
      if (!retain) {
        this.awaiting.delete(prefix);
        device.liveUptime = data.Uptime;
        device.liveUptimeAt = now;
        this.states.set(prefix, { value: 'online', retain: false, at: now });
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
      version: entry.version || text(device.sw_version || device.sw),
      observedAt: now,
    });
  }
  ensure(prefix, now) {
    if (!this.devices.has(prefix)) {
      if (this.devices.size >= MAX_DEVICES) {
        const oldest = [...this.devices.keys()].find((id) => !this.tracked.has(id)) || this.devices.keys().next().value;
        this.devices.delete(oldest);
        this.awaiting.delete(oldest);
      }
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
      this.awaiting.set(prefix, now);
    }
    this.watchPrefix(prefix);
    return this.devices.get(prefix);
  }
  list(now = Date.now()) {
    for (const [prefix, device] of this.devices)
      if (!this.tracked.has(prefix) && now - Math.max(device.observedAt || 0, this.awaiting.get(prefix) || 0) > 86400000) {
        this.devices.delete(prefix);
        this.awaiting.delete(prefix);
      }
    const status = this.status;
    return [...this.devices.values()].map((device) => {
      const state = this.states.get(device.mqttPrefix)?.value;
      const online = status.ready && state !== 'offline' && !this.awaiting.has(device.mqttPrefix) &&
        device.lastSeen != null && now - device.lastSeen < OFFLINE_TIMEOUT;
      let availability = 'unknown';
      if (online) availability = 'online';
      else if (state === 'offline' ||
        (this.awaiting.has(device.mqttPrefix) ? now - this.awaiting.get(device.mqttPrefix) >= OFFLINE_TIMEOUT
          : device.lastSeen != null && now - device.lastSeen >= OFFLINE_TIMEOUT)) availability = 'offline';
      return { ...device, source: 'MQTT', mac: null, online, availability };
    });
  }
  restore(items, now = Date.now()) {
    for (const item of items) {
      const device = cachedMqtt(item);
      if (!device || this.devices.has(device.mqttPrefix) || this.devices.size >= MAX_DEVICES) continue;
      this.devices.set(device.mqttPrefix, device);
      this.awaiting.set(device.mqttPrefix, now);
      this.watchPrefix(device.mqttPrefix);
    }
  }
  monitor(prefix) {
    const status = this.status;
    const device = this.list().find((item) => item.mqttPrefix === prefix);
    const state = this.states.get(prefix);
    return {
      ...status,
      bridgeState: state?.value || null,
      bridgeStateRetained: Boolean(state?.retain),
      lastMessage: device?.lastDataAt || null,
      liveUptime: device?.liveUptime,
      liveUptimeAt: device?.liveUptimeAt,
      discoveryCount: this.catalog.entries(prefix).length,
      availability: device?.availability || 'unknown',
    };
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.scanEnd);
    clearTimeout(this.topicRetry);
    clearInterval(this.scanTimer);
    const client = this.client;
    this.client = null;
    client?.end(true);
    this.connection.ready = false;
  }
}
