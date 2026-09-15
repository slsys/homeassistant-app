import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

export class GatewayError extends Error {
  constructor(message, code = 'gateway_error') {
    super(message);
    this.code = code;
  }
}

export function normalizeAddress(input) {
  if (typeof input !== 'string' || input.length > 255)
    throw new GatewayError('Укажите адрес контроллера', 'validation');
  let url;
  try {
    url = new URL(input.includes('://') ? input.trim() : `http://${input.trim()}`);
  } catch {
    throw new GatewayError('Некорректный адрес контроллера', 'validation');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new GatewayError('Укажите только http(s) адрес и порт, без пути и данных доступа', 'validation');
  return url.origin;
}

export function credentialToken({ token, username, password }) {
  if (token) {
    if (typeof token !== 'string' || !/^[a-fA-F0-9]{32}$/.test(token))
      throw new GatewayError('Токен SLS должен содержать 32 шестнадцатеричных символа', 'validation');
    return token.toLowerCase();
  }
  if (username || password) {
    if (typeof username !== 'string' || typeof password !== 'string')
      throw new GatewayError('Укажите логин и пароль', 'validation');
    // Matches GetUserToken() in firmware; only the resulting token is persisted.
    return createHash('md5')
      .update(username + password, 'utf8')
      .digest('hex');
  }
  return '';
}

const requests = new Map();
// The firmware serves HTTP on a constrained task. Serialize requests per gateway,
// including background polling and commands from multiple browser tabs.
export function requestGateway(entry, path, options) {
  const previous = requests.get(entry.address) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => performRequest(entry, path, options));
  requests.set(entry.address, pending);
  void pending
    .finally(() => {
      if (requests.get(entry.address) === pending) requests.delete(entry.address);
    })
    .catch(() => {});
  return pending;
}

function performRequest(entry, path, { form, text = false, timeout = 8000, limit = 4 * 1024 * 1024 } = {}) {
  const url = new URL(path, entry.address);
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const headers = { Accept: text ? 'text/plain' : 'application/json' };
    if (entry.token) headers.Cookie = `SLSSESSIONID=${entry.token}`;
    if (body !== null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: form ? 'POST' : 'GET', headers, agent: false },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) req.destroy(new GatewayError('Ответ контроллера слишком большой'));
          else chunks.push(chunk);
        });
        res.on('error', () => reject(new GatewayError('Соединение с контроллером прервано')));
        res.on('end', () => {
          if (
            res.statusCode === 401 ||
            res.statusCode === 403 ||
            (res.statusCode >= 300 && res.statusCode < 400)
          )
            return reject(new GatewayError('Требуется авторизация на SLS', 'auth'));
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new GatewayError(`SLS: HTTP ${res.statusCode}`, 'http'));
          const raw = Buffer.concat(chunks).toString('utf8');
          let value;
          try {
            value = JSON.parse(raw);
          } catch {
            if (text) return resolve(raw);
            return reject(new GatewayError('Контроллер вернул ответ в неизвестном формате', 'protocol'));
          }
          if (value?.success === false)
            return reject(
              new GatewayError(
                value.result === 'auth failed' ? 'Неверные данные доступа к SLS' : 'SLS не выполнил запрос',
                value.result === 'auth failed' ? 'auth' : 'gateway_error',
              ),
            );
          resolve(text ? raw : value);
        });
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new GatewayError('Контроллер не ответил за 8 секунд', 'timeout')),
      timeout,
    );
    req.on('close', () => clearTimeout(deadline));
    req.on('error', (error) =>
      reject(
        error instanceof GatewayError
          ? error
          : new GatewayError('Не удалось связаться с контроллером', 'network'),
      ),
    );
    req.end(body);
  });
}

export function publicMqtt(config) {
  return {
    enabled: config.mqtt?.enable === true,
    discovery: config.mqtt?.disc === true || config.hw?.zigbee?.ha === true,
    server: config.mqtt_server || '',
    port: config.mqtt_port || 1883,
    username: config.mqtt_user || '',
    prefix: config.mqtt_prefix || '',
    discoveryPrefix: config.mqtt?.disc_topic || 'homeassistant',
    retain: Boolean(config.mqtt_retain),
    friendlyNames: Boolean(config.hw?.zigbee?.use_fn),
  };
}

export async function readGatewayConfig(entry) {
  const response = await requestGateway(entry, '/api/config');
  const config = response.result ?? response;
  if (!config || typeof config !== 'object' || Array.isArray(config) || !('mqtt' in config))
    throw new GatewayError('Неизвестный формат конфигурации SLS', 'protocol');
  return config;
}

export function validateMqttForm(input) {
  const bounded = (value, max) =>
    typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value);
  if (!bounded(input.server, 253) || !/^[a-zA-Z0-9._-]+$/.test(input.server))
    throw new GatewayError('Укажите IP или имя MQTT-брокера', 'validation');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    throw new GatewayError('Некорректный порт MQTT', 'validation');
  for (const name of ['prefix', 'discoveryPrefix'])
    if (
      !bounded(input[name], 128) ||
      !input[name] ||
      /[+#]/.test(input[name]) ||
      input[name].startsWith('/') ||
      input[name].endsWith('/')
    )
      throw new GatewayError('Некорректный префикс MQTT', 'validation');
  if (!bounded(input.username || '', 128) || !bounded(input.password || '', 256))
    throw new GatewayError('Некорректные данные доступа MQTT', 'validation');
  if (typeof input.enabled !== 'boolean' || typeof input.discovery !== 'boolean')
    throw new GatewayError('Некорректные параметры MQTT', 'validation');
  const form = {
    mqtt_server: input.server,
    mqtt_port: String(input.port),
    mqtt_user: input.username || '',
    mqtt_prefix: input.prefix,
    mqtt_disc_topic: input.discoveryPrefix,
    mqtt_enable: String(input.enabled),
    mqtt_disc: String(input.discovery),
  };
  // Blank password means preserve; clearing an existing password is explicit.
  if (input.password || input.clearPassword === true) form.mqtt_pwd = input.password || '';
  return form;
}
