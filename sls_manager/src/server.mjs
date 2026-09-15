import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GatewayError } from './gateway.mjs';

const publicDirectory = new URL('../public/', import.meta.url);
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/log-time.js': ['log-time.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/mark.svg': ['mark.svg', 'image/svg+xml'],
};
const peerIP = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

export function allowedRequest(req, standalone) {
  if (!standalone) return peerIP(req) === '172.30.32.2';
  if (!['127.0.0.1', '::1'].includes(peerIP(req))) return false;
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname);
  } catch {
    return false;
  }
}

async function jsonBody(req) {
  if (req.headers['x-sls-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))
    throw new GatewayError('Ожидается запрос приложения', 'forbidden');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new GatewayError('Запрос слишком большой', 'validation');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new GatewayError('Некорректный JSON', 'validation');
  }
}

export function createServer(manager, { standalone = false } = {}) {
  return http.createServer({ requestTimeout: 30000 }, async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
    try {
      const url = new URL(req.url, 'http://app');
      if (
        url.pathname === '/health' &&
        req.method === 'GET' &&
        ['127.0.0.1', '::1', '172.30.32.2'].includes(peerIP(req))
      )
        return json(200, { ok: true });
      if (!allowedRequest(req, standalone))
        return json(403, { error: 'Доступ разрешён через Home Assistant Ingress' });
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        const content = await readFile(fileURLToPath(new URL(name, publicDirectory)));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(content);
      }
      if (url.pathname === '/api/state' && req.method === 'GET') return json(200, manager.state());
      if (url.pathname === '/api/gateways' && req.method === 'POST')
        return json(201, await manager.connect(await jsonBody(req)));
      if (url.pathname === '/api/mqtt-tracking' && req.method === 'POST')
        return json(201, await manager.trackMqtt((await jsonBody(req)).prefix));
      const match = url.pathname.match(
        /^\/api\/gateways\/([a-zA-Z0-9-]+)(?:\/(refresh|join|mqtt|monitor|events|reboot))?$/,
      );
      if (!match) return json(404, { error: 'Не найдено' });
      const [, id, action] = match;
      if (req.method === 'GET' && !action) return json(200, await manager.details(id));
      if (req.method === 'GET' && action === 'events') return json(200, manager.events(id));
      if (!['POST', 'DELETE'].includes(req.method)) return json(405, { error: 'Метод не поддерживается' });
      const body = await jsonBody(req);
      if (req.method === 'DELETE' && action === 'events') return json(200, manager.clearEvents(id));
      if (req.method === 'DELETE' && !action) {
        await manager.remove(id);
        return json(200, { success: true });
      }
      if (req.method !== 'POST') return json(405, { error: 'Метод не поддерживается' });
      if (!action) return json(200, await manager.connect(body, id));
      if (action === 'events') return json(200, await manager.openEvents(id));
      if (action === 'refresh') return json(200, await manager.details(id, true));
      if (action === 'join') return json(200, await manager.join(id, body.duration));
      if (action === 'mqtt') return json(200, await manager.configureMqtt(id, body));
      if (action === 'monitor') return json(200, await manager.monitor(id, body.enabled));
      if (action === 'reboot') return json(200, await manager.reboot(id, body.transport));
      return json(404, { error: 'Не найдено' });
    } catch (error) {
      const status = { validation: 400, not_found: 404, forbidden: 403, auth: 401 }[error.code] || 502;
      if (!res.headersSent)
        json(status, {
          error: error instanceof GatewayError ? error.message : 'Ошибка приложения. Проверьте журнал SLS.',
        });
      else res.end();
      if (!(error instanceof GatewayError)) console.error('Request failed:', error.code || error.name);
    }
  });
}
