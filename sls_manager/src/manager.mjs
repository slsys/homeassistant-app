import { randomUUID } from 'node:crypto';
import {
  GatewayError,
  normalizeAddress,
  credentialToken,
  requestGateway,
  readGatewayConfig,
  publicMqtt,
  validateMqttForm,
} from './gateway.mjs';
import { MqttMonitor, EventMonitor } from './monitor.mjs';
import { publishReboot } from './mqtt-command.mjs';

export class Manager {
  constructor(store, discovery, { pollInterval = 60, mqttDiscovery = null, homeAssistant = null } = {}) {
    this.store = store;
    this.discovery = discovery;
    this.mqttDiscovery = mqttDiscovery;
    this.homeAssistant = homeAssistant;
    this.pollInterval = pollInterval;
    this.runtimes = new Map();
    this.mutations = Promise.resolve();
    this.stopped = false;
  }
  mutate(action) {
    const pending = this.mutations.catch(() => {}).then(action);
    this.mutations = pending;
    return pending;
  }
  entry(id) {
    const entry = this.store.entries.find((item) => item.id === id);
    if (!entry) throw new GatewayError('Контроллер не найден', 'not_found');
    return entry;
  }
  httpEntry(id) {
    const entry = this.entry(id);
    if (entry.mode === 'mqtt')
      throw new GatewayError('Для этой операции подключите HTTP-доступ к контроллеру', 'validation');
    return entry;
  }
  visibleControllers() {
    const local = this.discovery.list().map((d) => ({ ...d, mac: d.id, source: 'LocalLink' }));
    for (const remote of this.mqttDiscovery?.list() || []) {
      const saved = this.store.entries.find(
        (e) => e.mode !== 'mqtt' && this.runtimes.get(e.id)?.mqtt?.prefix === remote.mqttPrefix,
      );
      const match = local.find(
        (d) =>
          (saved?.discoveryId && saved.discoveryId === d.id) ||
          (d.address === remote.address && d.name === remote.name),
      );
      if (match) {
        match.source = 'LocalLink + MQTT';
        match.mqttPrefix = remote.mqttPrefix;
        match.mqttOnline = remote.online;
        match.online ||= remote.online;
      } else local.push({ ...remote, mqttOnline: remote.online });
    }
    return local.map((d) => ({
      ...d,
      ha: this.homeAssistant?.metadata(d.mqttPrefix) || null,
      trackedId:
        this.store.entries.find(
          (e) =>
            e.discoveryId === d.id ||
            (d.mqttPrefix &&
              (e.mqttPrefix === d.mqttPrefix || this.runtimes.get(e.id)?.mqtt?.prefix === d.mqttPrefix)) ||
            (e.address && d.source !== 'MQTT' && new URL(e.address).hostname === d.address),
        )?.id || null,
    }));
  }
  observation(entry) {
    const rt = this.runtimes.get(entry.id);
    const prefix = entry.mqttPrefix || rt?.mqtt?.prefix;
    const remote = this.mqttDiscovery?.list().find((d) => d.mqttPrefix === prefix);
    const local = this.discovery
      .list()
      .find(
        (d) =>
          d.id === entry.discoveryId ||
          (entry.address && d.address === new URL(entry.address).hostname) ||
          (entry.mode === 'mqtt' && remote?.address === d.address && remote?.name === d.name),
      );
    return { local, remote };
  }
  rebootTransports(entry) {
    const rt = this.runtimes.get(entry.id);
    const { remote } = this.observation(entry);
    const transports = [];
    if (
      (remote?.online && this.mqttDiscovery?.client?.connected) ||
      (rt?.mqtt?.prefix && rt.monitor.client?.connected && rt.monitor.status.bridgeState === 'online')
    )
      transports.push('mqtt');
    if (entry.mode !== 'mqtt' && rt?.connected) transports.push('http');
    return transports;
  }
  async reboot(id, transport = 'auto') {
    const entry = this.entry(id);
    if (!['auto', 'http', 'mqtt'].includes(transport))
      throw new GatewayError('Неизвестный способ перезагрузки', 'validation');
    const rt = this.runtimes.get(id);
    if (transport === 'auto')
      transport = this.rebootTransports(entry)[0] || (entry.mode === 'mqtt' ? 'mqtt' : 'http');
    if (transport === 'http') {
      await requestGateway(this.httpEntry(id), '/api/reboot', { form: {} });
    } else {
      if (!this.rebootTransports(entry).includes('mqtt'))
        throw new GatewayError('Контроллер недоступен через MQTT', 'validation');
      const { remote } = this.observation(entry);
      const viaHa = remote?.online && this.mqttDiscovery?.client?.connected;
      await publishReboot(
        viaHa ? this.mqttDiscovery.client : rt?.monitor.client,
        viaHa ? remote.mqttPrefix : rt?.mqtt?.prefix,
      );
    }
    return { success: true, transport };
  }
  trackMqtt(prefix) {
    return this.mutate(async () => {
      const observed = this.mqttDiscovery?.list().find((d) => d.mqttPrefix === prefix);
      if (!observed) throw new GatewayError('MQTT-контроллер больше не найден', 'not_found');
      if (
        this.store.entries.some(
          (e) => e.mqttPrefix === prefix || this.runtimes.get(e.id)?.mqtt?.prefix === prefix,
        )
      )
        throw new GatewayError('Этот контроллер уже отслеживается', 'validation');
      if (this.store.entries.length >= 64)
        throw new GatewayError('Достигнут предел: 64 контроллера', 'validation');
      const entry = {
        id: randomUUID(),
        name: observed.name,
        mode: 'mqtt',
        mqttPrefix: prefix,
        address: null,
        token: '',
        mqttSnapshot: observed,
      };
      this.store.entries.push(entry);
      try {
        await this.store.save();
      } catch (error) {
        this.store.entries = this.store.entries.filter((e) => e !== entry);
        throw error;
      }
      return this.publicEntry(entry);
    });
  }
  runtime(entry) {
    if (!this.runtimes.has(entry.id))
      this.runtimes.set(entry.id, {
        connected: false,
        error: null,
        lastSuccess: null,
        info: null,
        uptime: null,
        uptimeAt: null,
        mqtt: null,
        devices: [],
        coordinator: null,
        detailsAt: 0,
        joinUntil: 0,
        monitor: new MqttMonitor(),
        events: new EventMonitor(entry),
      });
    return this.runtimes.get(entry.id);
  }
  publicEntry(entry) {
    const result = this.rawEntry(entry);
    result.ha = this.homeAssistant?.metadata(result.mqtt?.prefix) || null;
    result.mqttCatalogLimited = Boolean(
      this.mqttDiscovery?.catalog.limited || this.runtimes.get(entry.id)?.monitor.catalog.limited,
    );
    return result;
  }
  rawEntry(entry) {
    const { local, remote } = this.observation(entry);
    const localLink = Boolean(local?.online);
    const rebootTransports = this.rebootTransports(entry);
    if (entry.mode === 'mqtt') {
      const live = this.mqttDiscovery?.list().find((d) => d.mqttPrefix === entry.mqttPrefix);
      const observed = live || entry.mqttSnapshot;
      return {
        id: entry.id,
        name: observed?.name || entry.name,
        mode: 'mqtt',
        address: null,
        webAddress: observed?.address ? 'http://' + observed.address : null,
        mqttPrefix: entry.mqttPrefix,
        discoveryId: local?.id || null,
        localLink,
        rebootTransports,
        lastDataAt: Math.max(local?.lastSeen || 0, live?.lastDataAt || observed?.lastDataAt || 0) || null,
        observed,
        connected: Boolean(live?.online),
        lastSuccess: live?.lastSeen || null,
        uptime: observed?.uptime ?? null,
        info: {
          board: observed?.board || 'SLS',
          version: observed?.version,
          mem_heap_free: observed?.memory,
        },
        mqtt: {
          enabled: true,
          prefix: entry.mqttPrefix,
          discovery: this.mqttDiscovery?.catalog.entries(entry.mqttPrefix).length ? true : null,
        },
        monitoring: true,
        monitor: {
          connected: Boolean(this.mqttDiscovery?.status.connected),
          bridgeState: live?.online ? 'online' : 'offline',
          lastMessage: live?.lastSeen,
          discoveryCount: this.mqttDiscovery?.catalog.entries(entry.mqttPrefix).length || 0,
        },
        devices: [],
        error: null,
      };
    }
    const rt = this.runtime(entry);
    const observed = this.discovery.devices.get(entry.discoveryId);
    const uptime = observed && observed.lastSeen > (rt.uptimeAt || 0) ? observed.uptime : rt.uptime;
    return {
      id: entry.id,
      name: entry.name,
      address: entry.address,
      webAddress: entry.address,
      mode: 'http',
      discoveryId: entry.discoveryId,
      authenticated: Boolean(entry.token),
      observed: observed || null,
      addressChanged: Boolean(observed && new URL(entry.address).hostname !== observed.address),
      connected: rt.connected,
      error: rt.error,
      lastSuccess: rt.lastSuccess,
      lastDataAt:
        Math.max(
          rt.lastSuccess || 0,
          local?.lastSeen || 0,
          remote?.lastDataAt || 0,
          rt.monitor.status.lastMessage || 0,
          rt.events.lastMessage || 0,
        ) || null,
      localLink,
      rebootTransports,
      info: rt.info,
      uptime: uptime ?? null,
      mqtt: rt.mqtt,
      monitoring: entry.monitoringMode !== 'off',
      monitor: { ...rt.monitor.status },
      deviceCount: rt.coordinator?.device_count ?? null,
    };
  }
  state() {
    return {
      version: '0.1.10',
      sidebarInstallation: this.sidebarInstallation || null,
      discovery: {
        ...this.discovery.status,
        mqtt: this.mqttDiscovery?.status || null,
        devices: this.visibleControllers(),
      },
      gateways: this.store.entries.map((e) => this.publicEntry(e)),
    };
  }
  connect(input, id) {
    return this.mutate(() => this.connectGateway(input, id));
  }
  async connectGateway(input, id) {
    const old = id ? this.entry(id) : null;
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
      throw new GatewayError('Укажите имя до 100 символов', 'validation');
    const address = normalizeAddress(input.address);
    if (this.store.entries.some((e) => e.id !== id && e.address === address))
      throw new GatewayError('Этот адрес уже добавлен', 'validation');
    if (!old && this.store.entries.length >= 64)
      throw new GatewayError('Достигнут предел: 64 контроллера', 'validation');
    const discoveryId = input.discoveryId || old?.discoveryId || null;
    if (discoveryId && !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(discoveryId))
      throw new GatewayError('Неверный идентификатор LocalLink', 'validation');
    if (discoveryId && this.store.entries.some((e) => e.id !== id && e.discoveryId === discoveryId))
      throw new GatewayError('Этот контроллер уже добавлен', 'validation');
    const hasCredentials = Boolean(input.token || input.username || input.password);
    // Never forward a saved credential to a new, unverified address.
    if (old?.token && old.address !== address && !hasCredentials)
      throw new GatewayError('При смене адреса повторно введите данные доступа', 'validation');
    const entry = {
      id: id || randomUUID(),
      name: input.name.trim(),
      address,
      discoveryId: discoveryId?.toUpperCase() || null,
      token: hasCredentials ? credentialToken(input) : old?.token || '',
      monitoring: old?.monitoringMode !== 'off',
      monitoringMode: old?.monitoringMode || 'on',
    };
    const info = await requestGateway(entry, '/api/info');
    if (!info || typeof info.version !== 'string' || typeof info.board !== 'string')
      throw new GatewayError('Адрес не вернул сведения SLS', 'protocol');
    const before = [...this.store.entries];
    this.store.entries = old
      ? this.store.entries.map((e) => (e.id === id ? entry : e))
      : [...this.store.entries, entry];
    try {
      await this.store.save();
    } catch (error) {
      this.store.entries = before;
      throw error;
    }
    if (old) {
      const rt = this.runtimes.get(id);
      rt?.monitor.stop();
      rt?.events.close();
      this.runtimes.delete(id);
    }
    await this.refresh(entry, true);
    return this.publicEntry(entry);
  }
  async refresh(entry, forceConfig = false) {
    if (entry.mode === 'mqtt') return;
    const rt = this.runtime(entry);
    if (rt.pending) return rt.pending;
    rt.pending = (async () => {
      try {
        const info = await requestGateway(entry, '/api/info');
        if (this.stopped || !this.store.entries.includes(entry)) return;
        if (!info || typeof info.version !== 'string' || typeof info.board !== 'string')
          throw new GatewayError('Неизвестный ответ SLS', 'protocol');
        rt.info = info;
        rt.connected = true;
        rt.lastSuccess = Date.now();
        rt.error = null;
        // /api/info does not include uptime on current firmware.
        let uptime = info.uptime;
        if (!Number.isFinite(uptime) || uptime < 0) {
          try {
            uptime = (await requestGateway(entry, '/api/time')).uptime;
          } catch {
            uptime = null;
          }
        }
        if (this.stopped || !this.store.entries.includes(entry)) return;
        rt.uptime = Number.isFinite(uptime) && uptime >= 0 ? uptime : null;
        rt.uptimeAt = rt.uptime === null ? null : Date.now();
        if (forceConfig || !rt.configAt || Date.now() - rt.configAt > 300000) {
          try {
            const config = await readGatewayConfig(entry);
            if (this.stopped || !this.store.entries.includes(entry)) return;
            rt.mqtt = publicMqtt(config);
            rt.configAt = Date.now();
            rt.configError = null;
            if (entry.monitoringMode !== 'off' && !rt.monitor.client) rt.monitor.start(config);
          } catch (error) {
            rt.configError = error.message;
          }
        }
      } catch (error) {
        rt.connected = false;
        rt.error = error.message;
      }
    })().finally(() => {
      rt.pending = null;
    });
    return rt.pending;
  }
  async details(id, force = false) {
    const entry = this.entry(id);
    if (entry.mode === 'mqtt') return { ...this.publicEntry(entry), mqttDevices: this.mqttDevices(entry) };
    const rt = this.runtime(entry);
    if (!rt.lastSuccess || force) await this.refresh(entry, force);
    if (!rt.detailsPending && (force || Date.now() - rt.detailsAt > 15000)) {
      rt.detailsPending = (async () => {
        const errors = [];
        // Sequential requests avoid occupying the ESP32's HTTP task in parallel.
        if (rt.info?.services?.includes('zigbee')) {
          try {
            rt.coordinator = await requestGateway(entry, '/api/zigbee');
          } catch (error) {
            errors.push(error.message);
          }
          try {
            const devices = await requestGateway(entry, '/api/zigbee/devices');
            if (!Array.isArray(devices)) throw new GatewayError('Неизвестный формат списка устройств');
            rt.devices = devices;
          } catch (error) {
            errors.push(error.message);
          }
          try {
            const join = await requestGateway(entry, '/api/zigbee/join');
            rt.joinUntil = Date.now() + Math.max(0, Math.min(254, Number(join.duration) || 0)) * 1000;
          } catch {
            /* older firmware may not report remaining time */
          }
        }
        rt.detailsError = errors.join('; ') || null;
        rt.detailsAt = Date.now();
      })().finally(() => {
        rt.detailsPending = null;
      });
    }
    await rt.detailsPending;
    return {
      ...this.publicEntry(entry),
      devices: rt.devices,
      mqttDevices: this.mqttDevices(entry),
      coordinator: rt.coordinator,
      joinUntil: rt.joinUntil,
      detailsAt: rt.detailsAt,
      detailsError: rt.detailsError,
      configError: rt.configError,
    };
  }
  mqttDevices(entry) {
    const prefix = entry.mqttPrefix || this.runtimes.get(entry.id)?.mqtt?.prefix;
    if (!prefix) return [];
    const local = this.runtimes.get(entry.id)?.monitor.catalog?.devices(prefix) || [];
    const remote = this.mqttDiscovery?.catalog?.devices(prefix) || [];
    const devices = new Map(local.map((d) => [d.id, d]));
    for (const device of remote) devices.set(device.id, device);
    const result = [...devices.values()];
    return this.homeAssistant ? this.homeAssistant.enrichDevices(result) : result;
  }
  async haObjects(id) {
    const entry = this.entry(id);
    const prefix = entry.mqttPrefix || this.runtimes.get(id)?.mqtt?.prefix;
    if (!prefix)
      return { objects: [], warnings: ['MQTT-префикс контроллера ещё не известен.'], updatedAt: null };
    if (!this.homeAssistant) return { objects: [], warnings: ['HA API недоступен.'], updatedAt: null };
    return this.homeAssistant.objects(prefix, this.mqttDevices(entry));
  }
  async join(id, duration) {
    if (!Number.isInteger(duration) || duration < 0 || duration > 254)
      throw new GatewayError('Длительность сопряжения: 0–254 секунды', 'validation');
    const entry = this.httpEntry(id);
    const rt = this.runtime(entry);
    const result = await requestGateway(entry, '/api/zigbee/join', { form: { duration: String(duration) } });
    rt.joinUntil = Date.now() + duration * 1000;
    return { ...result, joinUntil: rt.joinUntil };
  }
  async configureMqtt(id, input) {
    const entry = this.httpEntry(id);
    const form = validateMqttForm(input);
    const result = await requestGateway(entry, '/api/config/set', { form });
    const rt = this.runtime(entry);
    rt.monitor.stop();
    await this.refresh(entry, true);
    return { success: true, needReboot: result.need_reboot === true, mqtt: rt.mqtt };
  }
  async monitor(id, enabled) {
    if (typeof enabled !== 'boolean')
      throw new GatewayError('Некорректный параметр мониторинга', 'validation');
    const entry = this.httpEntry(id);
    const rt = this.runtime(entry);
    if (enabled) rt.monitor.start(await readGatewayConfig(entry));
    else rt.monitor.stop();
    entry.monitoring = enabled;
    entry.monitoringMode = enabled ? 'on' : 'off';
    await this.store.save();
    return { ...rt.monitor.status };
  }
  events(id) {
    const entry = this.httpEntry(id);
    const events = this.runtime(entry).events;
    events.touch();
    return events.snapshot();
  }
  clearEvents(id) {
    const events = this.runtime(this.httpEntry(id)).events;
    if (events.cacheStatus === 'loading')
      throw new GatewayError('Дождитесь загрузки кэша лога', 'validation');
    return events.clear();
  }
  async openEvents(id) {
    const monitor = this.runtime(this.httpEntry(id)).events;
    await monitor.open();
    return monitor.snapshot();
  }
  remove(id) {
    return this.mutate(() => this.removeGateway(id));
  }
  async removeGateway(id) {
    this.entry(id);
    const before = [...this.store.entries];
    this.store.entries = this.store.entries.filter((e) => e.id !== id);
    try {
      await this.store.save();
    } catch (error) {
      this.store.entries = before;
      throw error;
    }
    const rt = this.runtimes.get(id);
    rt?.monitor.stop();
    rt?.events.close();
    this.runtimes.delete(id);
  }
  start() {
    this.stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const entry of [...this.store.entries]) {
          if (this.stopped) break;
          if (this.store.entries.includes(entry)) await this.refresh(entry);
        }
      } finally {
        busy = false;
      }
    };
    void tick();
    this.timer = setInterval(tick, this.pollInterval * 1000);
    this.timer.unref();
  }
  close() {
    this.stopped = true;
    this.homeAssistant?.close();
    clearInterval(this.timer);
    for (const rt of this.runtimes.values()) {
      rt.monitor.stop();
      rt.events.close();
    }
  }
}
