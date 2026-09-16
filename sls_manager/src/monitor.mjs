import mqtt from 'mqtt';
import { DiscoveryCatalog } from './discovery-catalog.mjs';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { requestGateway } from './gateway.mjs';

function ownsConfig(value, prefix) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    if (key === 'via_device' && item === prefix) return true;
    if (
      (key.endsWith('_topic') || ['stat_t', 'cmd_t', 'avty_t', '~'].includes(key)) &&
      typeof item === 'string' &&
      (item === prefix || item.startsWith(`${prefix}/`))
    )
      return true;
    return typeof item === 'object' && item !== null && ownsConfig(item, prefix);
  });
}

export class MqttMonitor {
  constructor() {
    this.configs = new Set();
    this.catalog = new DiscoveryCatalog();
    this.status = { connected: false, bridgeState: null, lastMessage: null, discoveryCount: 0, error: null };
  }
  start(config) {
    this.stop();
    this.status = { connected: false, bridgeState: null, lastMessage: null, discoveryCount: 0, error: null };
    const prefix = config.mqtt_prefix;
    const discovery = config.mqtt?.disc_topic || 'homeassistant';
    if (!config.mqtt?.enable || !config.mqtt_server || !prefix) {
      this.status.error = 'MQTT не настроен на шлюзе';
      return;
    }
    if (/[+#]/.test(prefix + discovery) || !/^[a-zA-Z0-9._-]+$/.test(config.mqtt_server)) {
      this.status.error = 'Неизвестный формат адреса или префикса MQTT';
      return;
    }
    const client = mqtt.connect({
      protocol: 'mqtt',
      host: config.mqtt_server,
      port: Number(config.mqtt_port) || 1883,
      username: config.mqtt_user || undefined,
      password: config.mqtt_pwd || undefined,
      clientId: `sls-manager-${randomUUID().slice(0, 8)}`,
      clean: true,
      queueQoSZero: false,
      reconnectPeriod: 10000,
      connectTimeout: 8000,
      protocolVersion: 4,
      resubscribe: true,
      properties: undefined,
    });
    this.client = client;
    const on = (event, handler) =>
      client.on(event, (...args) => {
        if (this.client === client) handler(...args);
      });
    on('connect', () => {
      this.status.connected = true;
      this.status.error = null;
      // Rebuild from retained configs after each reconnect; a config may have
      // been removed while this client was offline.
      this.configs.clear();
      this.catalog.clear();
      this.status.discoveryCount = 0;
      client.subscribe([`${prefix}/#`, `${discovery}/#`], { qos: 0 }, (error, granted) => {
        if (error || granted?.some((item) => item.qos === 128))
          this.status.error = 'Брокер не разрешил диагностическую подписку';
      });
    });
    on('offline', () => {
      this.status.connected = false;
      this.status.bridgeState = null;
    });
    on('close', () => {
      this.status.connected = false;
      this.status.bridgeState = null;
    });
    on('error', () => {
      this.status.error = 'Нет подключения к брокеру: проверьте адрес, доступ и ACL';
    });
    on('message', (topic, payload, packet) => {
      if (payload.length > 65536) return;
      this.catalog.ingest(topic, payload, packet);
      if (topic === `${prefix}/bridge/state`) {
        this.status.bridgeState = payload.toString();
        this.status.bridgeStateRetained = packet.retain;
      }
      if (topic.startsWith(`${prefix}/`) && !packet.retain) this.status.lastMessage = Date.now();
      if (topic === `${prefix}/bridge/config` && !packet.retain) {
        try {
          const data = JSON.parse(payload.toString());
          if (Number.isFinite(data.Uptime) && data.Uptime >= 0) {
            this.status.liveUptime = data.Uptime;
            this.status.liveUptimeAt = Date.now();
          }
        } catch {
          /* Ignore malformed heartbeat data. */
        }
      }
      if (!topic.startsWith(`${discovery}/`) || !topic.endsWith('/config')) return;
      if (!payload.length) this.configs.delete(topic);
      else {
        try {
          if (ownsConfig(JSON.parse(payload.toString()), prefix) && this.configs.size < 4096)
            this.configs.add(topic);
          else this.configs.delete(topic);
        } catch {
          /* unrelated or malformed discovery data */
        }
      }
      this.status.discoveryCount = this.configs.size;
    });
  }
  stop() {
    const client = this.client;
    this.client = null;
    client?.end(true);
    this.configs.clear();
    this.catalog.clear();
    this.status.connected = false;
  }
}

export function redactLog(text, secrets = []) {
  let value = typeof text === 'string' ? text : (JSON.stringify(text) ?? '');
  if (
    /password|passwd|mqtt_pwd|wifi_pwd|SLSSESSIONID|auth_token|\btoken["']?\s*[:=]|\bcookie["']?\s*:/i.test(
      value,
    )
  )
    return '[Скрыта строка с данными доступа]';
  for (const secret of secrets) if (secret) value = value.split(secret).join('[скрыто]');
  return value.slice(0, 3000);
}

export class EventMonitor {
  constructor(
    entry,
    { reconnectDelay = 10000, createWebSocket = (url, options) => new WebSocket(url, options) } = {},
  ) {
    this.entry = entry;
    this.createWebSocket = createWebSocket;
    this.reconnectDelay = reconnectDelay;
    this.events = [];
    this.status = 'idle';
    this.cacheStatus = 'idle';
    this.cacheError = null;
    this.error = null;
    this.lease = 0;
    this.serial = 0;
    this.closed = false;
    this.opened = false;
    this.generation = 0;
    this.cacheSnapshot = [];
    this.lastMessage = null;
    this.liveCount = 0;
    this.connectedAt = null;
  }
  snapshot() {
    return {
      status: this.status,
      error: this.error,
      cacheStatus: this.cacheStatus,
      cacheError: this.cacheError,
      cacheAt: this.cacheAt || null,
      lastMessage: this.lastMessage,
      liveCount: this.liveCount,
      connectedAt: this.connectedAt,
      events: this.events,
    };
  }
  touch() {
    this.lease = Date.now() + 30000;
    if (!this.timer) {
      this.timer = setInterval(() => {
        const now = Date.now();
        if (now > this.lease) return this.stop();
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        if (this.pingAt !== null && now - this.pingAt >= 10000) {
          this.error = 'WebSocket не отвечает. Восстанавливаем соединение.';
          this.socket.terminate();
          return;
        }
        if (this.pingAt === null && now - this.lastPing >= 15000) {
          this.pingAt = now;
          this.lastPing = now;
          this.socket.ping();
        }
      }, 5000);
      this.timer.unref();
    }
    if (this.opened && !this.socket && !this.retry && !this.starting) this.connect();
  }
  async open() {
    if (this.closed) return;
    this.stop();
    const generation = this.generation;
    const previousCache = this.cachePending;
    this.opened = true;
    this.starting = true;
    this.events = [];
    this.cacheSnapshot = [];
    this.cacheStatus = 'loading';
    this.cacheAt = null;
    this.cacheError = null;
    this.lastMessage = null;
    this.liveCount = 0;
    this.connectedAt = null;
    this.error = null;
    this.touch();
    // A previous view may still be reading the controller. Finish it before
    // loading this view; its generation guard prevents stale data from landing.
    await previousCache;
    if (this.closed || generation !== this.generation) return;
    await this.loadCache();
    if (this.closed || generation !== this.generation) return;
    this.starting = false;
    this.connect();
  }
  clear() {
    this.events = [];
    this.liveCount = 0;
    this.lastMessage = null;
    return this.snapshot();
  }
  append(event) {
    this.events.push({ ...event, id: ++this.serial });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }
  loadCache() {
    if (this.cachePending) return this.cachePending;
    const generation = this.generation;
    this.cacheStatus = 'loading';
    this.cachePending = (async () => {
      try {
        const text = await requestGateway(this.entry, '/api/messages-history?action=getBuffer', {
          text: true,
          limit: 2 * 1024 * 1024,
        });
        if (this.closed || generation !== this.generation) return;
        const lines = text.split(/\r?\n/).filter(Boolean).slice(-500);
        // Firmware returns its ring buffer on every request. Append only
        // beyond the longest suffix/prefix overlap, preserving repeated lines.
        let overlap = Math.min(this.cacheSnapshot.length, lines.length);
        while (overlap && !this.cacheSnapshot.slice(-overlap).every((line, i) => line === lines[i]))
          overlap--;
        for (const line of lines.slice(overlap)) {
          const match = line.match(/^\[([^\]\r\n]{1,45})\]\s?(.*)$/);
          this.append({
            time: Date.now(),
            timeLabel: match?.[1] || '',
            category: 'log',
            source: 'cache',
            message: redactLog(match ? match[2] : line, [this.entry.token]),
          });
        }
        this.cacheSnapshot = lines;
        this.cacheAt = Date.now();
        this.cacheStatus = 'ready';
        this.cacheError = null;
      } catch (error) {
        if (this.closed || generation !== this.generation) return;
        this.cacheStatus = 'error';
        this.cacheError = error.message;
      }
    })().finally(() => {
      this.cachePending = null;
    });
    return this.cachePending;
  }
  connect() {
    if (this.closed || Date.now() > this.lease) return;
    const url = new URL(this.entry.address);
    url.protocol = 'ws:';
    url.port = '80';
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    this.status = 'connecting';
    const options = {
      headers: this.entry.token ? { Cookie: 'SLSSESSIONID=' + this.entry.token } : {},
      handshakeTimeout: 6000,
      maxPayload: 256 * 1024,
      followRedirects: false,
      perMessageDeflate: false,
    };
    const socket = this.createWebSocket(url, options);
    this.socket = socket;
    const isCurrent = () => this.socket === socket && !this.closed;
    socket.on('open', () => {
      if (!isCurrent()) return;
      this.error = null;
      this.status = 'ws';
      this.connectedAt = Date.now();
      this.lastPing = Date.now();
      this.pingAt = null;
      socket.send(JSON.stringify({ action: 'subscribe', category: 'log' }));
    });
    socket.on('pong', () => {
      if (isCurrent()) this.pingAt = null;
    });
    socket.on('message', (data) => {
      if (!isCurrent()) return;
      try {
        const event = JSON.parse(data.toString());
        if (event.category !== 'log') return;
        this.lastMessage = Date.now();
        this.liveCount++;
        const timestamp = Number(event.payload?.ts);
        const milliseconds = Number(event.payload?.ms) || 0;
        this.append({
          time: timestamp > 0 ? timestamp * 1000 + milliseconds : Date.now(),
          category: event.category,
          source: 'websocket',
          message: redactLog(event.payload?.message ?? event.payload, [this.entry.token]),
        });
      } catch {
        /* Ignore unsupported frames. */
      }
    });
    socket.on('error', (error) => {
      if (!isCurrent()) return;
      this.status = 'error';
      this.error = /401|403/.test(error.message)
        ? 'WebSocket требует логин и пароль SLS, даже если HTTP API открыт. Обновите настройки доступа.'
        : 'Нет связи с WebSocket (' + (error.code || 'ошибка соединения') + ').';
    });
    socket.on('close', () => {
      if (!isCurrent()) return;
      this.socket = null;
      if (Date.now() > this.lease) {
        this.status = 'idle';
        return;
      }
      this.status = 'reconnecting';
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, this.reconnectDelay);
      this.retry.unref();
    });
  }
  stop() {
    this.generation++;
    this.starting = false;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    this.status = 'idle';
  }
  close() {
    this.closed = true;
    this.stop();
  }
}
