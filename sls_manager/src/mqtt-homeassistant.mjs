import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// MQTT transport over HA Core. It never reads broker credentials or queues commands.
export class HomeAssistantMqttClient extends EventEmitter {
  constructor({
    token = process.env.SUPERVISOR_TOKEN,
    createWebSocket = (url, options) => new WebSocket(url, options),
    reconnectDelay = 10000,
    requestTimeout = 8000,
  } = {}) {
    super();
    this.token = token;
    this.createWebSocket = createWebSocket;
    this.reconnectDelay = reconnectDelay;
    this.requestTimeout = requestTimeout;
    this.connected = false; // Authenticated HA API, not proof of broker connectivity.
    this.viaHomeAssistant = true;
    this.stopped = false;
    this.sequence = 0;
    this.pending = new Map();
    this.subscriptions = new Map();
    queueMicrotask(() => this.open());
  }
  open() {
    if (this.stopped) return;
    const token = this.token;
    if (!token) {
      this.emit('error', new Error('MQTT через HA доступен внутри HAOS; для отдельного запуска выберите direct'));
      this.retry = setTimeout(() => this.open(), 30000).unref();
      return;
    }
    const socket = this.createWebSocket('ws://supervisor/core/websocket', {
      handshakeTimeout: 8000,
      maxPayload: 8 * 1024 * 1024,
    });
    this.socket = socket;
    this.authTimer = setTimeout(() => socket.terminate(), 10000).unref();
    socket.on('pong', () => {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });
    socket.on('message', (bytes) => {
      if (this.socket !== socket || this.stopped) return;
      let message;
      try {
        message = JSON.parse(bytes.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (message.type === 'auth_ok') {
        clearTimeout(this.authTimer);
        this.connected = true;
        this.pingTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN || this.pongTimer) return;
          socket.ping();
          this.pongTimer = setTimeout(() => socket.terminate(), 10000).unref();
        }, 15000).unref();
        this.emit('connect');
      } else if (message.type === 'auth_invalid') {
        this.emit('error', new Error('Нет доступа к HA API: проверьте homeassistant_api'));
        socket.terminate();
      } else if (message.type === 'result') {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.success) request.resolve(message.result);
        else {
          const reasons = {
            unauthorized: 'недостаточно прав HA API',
            unknown_command: 'версия HA не поддерживает MQTT-подписку',
            invalid_format: 'версия HA не поддерживает формат MQTT-запроса',
          };
          request.reject(new Error(reasons[message.error?.code] || 'MQTT-интеграция HA отклонила запрос'));
        }
      } else if (message.type === 'event') {
        const subscription = [...this.subscriptions.values()].find((item) => item.id === message.id);
        const event = message.event;
        if (!subscription || typeof event?.topic !== 'string' || typeof event.payload !== 'string') return;
        if (event.topic.length > 500 || Buffer.byteLength(event.payload) > 65536) return;
        // Overlapping filters can repeat a state. The catalog replaces state by
        // topic; accepting the event also works when another filter is denied by ACL.
        this.emit('message', event.topic, Buffer.from(event.payload), {
          retain: event.retain === true,
          qos: event.qos,
        });
      }
    });
    socket.on('error', () => {
      if (this.socket === socket && !this.stopped)
        this.emit('error', new Error('Нет связи с HA API; MQTT-подписки будут восстановлены'));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      clearTimeout(this.authTimer);
      clearTimeout(this.pongTimer);
      clearInterval(this.pingTimer);
      this.pongTimer = null;
      this.subscriptions.clear();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        const error = new Error('Соединение с HA закрыто; результат запроса не подтверждён');
        if (request.type === 'call_service') error.code = 'delivery_unknown';
        request.reject(error);
      }
      this.pending.clear();
      this.emit('offline');
      this.emit('close');
      if (!this.stopped) this.retry = setTimeout(() => this.open(), this.reconnectDelay).unref();
    });
  }
  request(type, parameters = {}, id = ++this.sequence) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('HA API недоступен'));
    if (this.pending.size >= 128) return Promise.reject(new Error('HA API занят'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error('HA не подтвердил запрос; автоматическое повторение команды отключено');
        if (type === 'call_service') error.code = 'delivery_unknown';
        reject(error);
        // A timed-out subscription may exist at the server. Closing removes it reliably.
        if (type !== 'call_service') this.socket?.terminate();
      }, this.requestTimeout).unref();
      this.pending.set(id, { resolve, reject, timer, type });
      this.socket.send(JSON.stringify({ ...parameters, id, type }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        const failure = new Error('Не удалось подтвердить передачу запроса HA');
        if (type === 'call_service') failure.code = 'delivery_unknown';
        reject(failure);
      });
    });
  }
  subscribe(topics, _options, callback) {
    const filters = Array.isArray(topics) ? topics : [topics];
    void (async () => {
      for (const topic of filters) {
        const existing = this.subscriptions.get(topic);
        if (existing) {
          await existing.ready;
          continue;
        }
        const id = ++this.sequence;
        const subscription = { id, topic };
        this.subscriptions.set(topic, subscription);
        subscription.ready = this.request('mqtt/subscribe', { topic, qos: 0 }, id);
        try {
          await subscription.ready;
        } catch (error) {
          if (this.subscriptions.get(topic) === subscription) this.subscriptions.delete(topic);
          throw error;
        }
      }
      callback?.(null, filters.map((topic) => ({ topic, qos: 0 })));
    })().catch((error) => callback?.(error));
  }
  unsubscribe(topics, callback) {
    const filters = Array.isArray(topics) ? topics : [topics];
    void (async () => {
      for (const topic of filters) {
        const subscription = this.subscriptions.get(topic);
        if (!subscription) continue;
        await subscription.ready;
        await this.request('unsubscribe_events', { subscription: subscription.id });
        if (this.subscriptions.get(topic) === subscription) this.subscriptions.delete(topic);
      }
      callback?.();
    })().catch((error) => callback?.(error));
  }
  publish(topic, payload, options, callback) {
    if (options.qos !== 0 || options.retain !== false) {
      callback(new Error('Команды разрешены только с QoS 0 и retain=false'));
      return;
    }
    // No reconnect/retry here: repeating a reboot after an ambiguous response is unsafe.
    void this.request('call_service', {
      domain: 'mqtt',
      service: 'publish',
      service_data: { topic, payload, qos: 0, retain: false },
    }).then(() => callback(), callback);
  }
  end() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.retry);
    clearTimeout(this.authTimer);
    clearTimeout(this.pongTimer);
    clearInterval(this.pingTimer);
    this.socket?.terminate();
  }
}
