import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from './store.mjs';
import { LocalLink } from './locallink.mjs';
import { MqttDiscovery } from './mqtt-discovery.mjs';
import { HomeAssistant } from './home-assistant.mjs';
import { Manager } from './manager.mjs';
import { createServer } from './server.mjs';
import { installSidebar } from './sidebar-install.mjs';

const standalone = process.argv.includes('--standalone');
const directory = process.env.SLS_DATA_DIR || (standalone ? resolve('.data') : '/data');
let options = {};
try {
  options = JSON.parse(await readFile(join(directory, 'options.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const pollInterval = options.poll_interval ?? 60;
if (!Number.isInteger(pollInterval) || pollInterval < 30 || pollInterval > 600)
  throw new Error('poll_interval must be 30–600 seconds');
const store = new Store(directory);
await store.load();
const discovery = new LocalLink(options);
const mqttDiscovery = new MqttDiscovery();
const homeAssistant = new HomeAssistant();
const manager = new Manager(store, discovery, { pollInterval, mqttDiscovery, homeAssistant });
const server = createServer(manager, { standalone });
const port = Number(process.env.SLS_PORT || 8099);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SLS_PORT');
const sidebarAbort = new AbortController();
let sidebarTimer;
function stopSidebar() {
  sidebarAbort.abort();
  clearTimeout(sidebarTimer);
}
function sidebarError(error) {
  if (sidebarAbort.signal.aborted) return;
  manager.sidebarInstallation = {
    state: 'error',
    message: 'Не удалось автоматически установить иконку. Проверьте журнал SLS.',
  };
  console.error('Sidebar installation:', error.code || error.message);
}
async function updateSidebar(moduleSource) {
  if (sidebarAbort.signal.aborted) return;
  try {
    await installSidebar({
      dataDirectory: directory,
      moduleSource,
      signal: sidebarAbort.signal,
      onStatus: (status) => {
        manager.sidebarInstallation = status;
      },
    });
  } catch (error) {
    sidebarError(error);
  }
  if (!sidebarAbort.signal.aborted && manager.sidebarInstallation?.state === 'restart_pending')
    sidebarTimer = setTimeout(() => void updateSidebar(moduleSource), 30000).unref();
}
server.on('error', (error) => {
  stopSidebar();
  console.error('HTTP server:', error.code);
  manager.close();
  mqttDiscovery.close();
  discovery.close();
  process.exitCode = 1;
});
server.listen(port, standalone ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(
    `SLS 0.1.11 started (${standalone ? 'localhost development' : 'Home Assistant Ingress'}), port ${port}`,
  );
  discovery.start();
  void mqttDiscovery.start();
  homeAssistant.start();
  manager.start();
  if (!standalone)
    void readFile(new URL('../frontend/sls-sidebar.js', import.meta.url), 'utf8')
      .then(updateSidebar)
      .catch(sidebarError);
});
function shutdown() {
  stopSidebar();
  manager.close();
  mqttDiscovery.close();
  discovery.close();
  server.close();
  server.closeIdleConnections();
  setTimeout(() => process.exit(), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
