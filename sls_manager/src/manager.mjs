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
import { RebootTracker } from './reboot.mjs';
import { UdpLog, UDP_DEFAULTS, validateUdpConfig, unicastIPv4 } from './udp-log.mjs';
import { UdpSender } from './udp-sender.mjs';
import { OFFLINE_TIMEOUT } from './controller-cache.mjs';

export class Manager {
  constructor(store, discovery, { pollInterval = 60, mqttDiscovery = null, homeAssistant = null, cache = null } = {}) {
    this.store = store;
    this.discovery = discovery;
    this.mqttDiscovery = mqttDiscovery;
    this.homeAssistant = homeAssistant;
    this.pollInterval = pollInterval;
    this.runtimes = new Map();
    this.cache = cache;
    this.startedAt = Date.now();
    for (const entry of store.entries) if (entry.mode !== 'mqtt') this.runtime(entry);
    discovery.restore?.(cache?.data.local || []);
    mqttDiscovery?.restore?.([
      ...(cache?.data.mqtt || []),
      ...store.entries.filter((entry) => entry.mode === 'mqtt' && entry.mqttSnapshot)
        .map((entry) => ({ ...entry.mqttSnapshot, mqttPrefix: entry.mqttPrefix })),
    ]);
    this.syncTrackedDiscovery();
    this.reboots = new RebootTracker();
    this.mutations = Promise.resolve();
    this.stopped = false;
    this.udpLog = new UdpLog(store.directory, { reservedPort: discovery.options?.multicast_port || 8881 });
    this.udpSender = new UdpSender(this.udpLog);
  }
  syncTrackedDiscovery() {
    this.discovery.tracked = new Set(this.store.entries.map((entry) => entry.discoveryId).filter(Boolean));
    if (this.mqttDiscovery) {
      this.mqttDiscovery.tracked = new Set(this.store.entries.map((entry) =>
        entry.mqttPrefix || this.runtimes.get(entry.id)?.mqtt?.prefix ||
        this.cache?.data.http.find((item) => item.id === entry.id && item.address === entry.address)?.mqtt?.prefix,
      ).filter(Boolean));
      for (const prefix of this.mqttDiscovery.tracked) this.mqttDiscovery.watchPrefix?.(prefix);
    }
  }
  async saveCache() {
    if (!this.cache) return;
    this.syncTrackedDiscovery();
    try {
      await this.cache.save({
        local: this.discovery.list(),
        mqtt: this.mqttDiscovery?.list() || [],
        http: this.store.entries.filter((entry) => entry.mode !== 'mqtt').map((entry) => {
          const rt = this.runtime(entry);
          return { ...rt, id: entry.id, address: entry.address, lastDataAt: this.rawEntry(entry).lastDataAt };
        }),
      });
    } catch (error) {
      console.error('Controller cache:', error.code || error.message);
    }
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
        match.availability = match.online ? 'online'
          : match.availability === 'unknown' || remote.availability === 'unknown' ? 'unknown' : 'offline';
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
  rebootSamples(entry) {
    const rt = this.runtimes.get(entry.id);
    const { local, remote } = this.observation(entry);
    return [
      { source: 'HTTP', uptime: rt?.uptime, at: rt?.confirmed ? rt.uptimeAt : null },
      { source: 'LocalLink', uptime: local?.uptime, at: this.discovery.restored?.has(local?.id) ? null : local?.lastSeen },
      { source: 'MQTT HA', uptime: remote?.liveUptime, at: remote?.liveUptimeAt },
      { source: 'MQTT', uptime: rt?.monitor.status.liveUptime, at: rt?.monitor.status.liveUptimeAt },
    ].filter((s) => Number.isFinite(s.uptime) && s.uptime >= 0 && Number.isFinite(s.at) && s.at > 0);
  }
  rebootStatus(entry) {
    return this.reboots.observe(entry.id, this.rebootSamples(entry));
  }
  async checkReboots() {
    if (this.checkingReboots || this.stopped) return;
    this.checkingReboots = true;
    try {
      for (const entry of [...this.store.entries]) {
        const status = this.rebootStatus(entry);
        if (this.stopped) break;
        if (!status?.pending || entry.mode === 'mqtt') continue;
        const rt = this.runtime(entry);
        if (
          rt.pending ||
          rt.detailsPending ||
          Date.now() - (rt.rebootPollAt || 0) < (status.delayed ? 60000 : 5000)
        )
          continue;
        rt.rebootPollAt = Date.now();
        // Reuse the regular request guard; never send another reboot command.
        await this.refresh(entry);
        this.rebootStatus(entry);
      }
    } finally {
      this.checkingReboots = false;
    }
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
    if (this.rebootStatus(entry)?.pending)
      throw new GatewayError('Ожидаем подтверждения предыдущей перезагрузки', 'validation');
    if (!['auto', 'http', 'mqtt'].includes(transport))
      throw new GatewayError('Неизвестный способ перезагрузки', 'validation');
    const rt = this.runtimes.get(id);
    if (transport === 'auto')
      transport = this.rebootTransports(entry)[0] || (entry.mode === 'mqtt' ? 'mqtt' : 'http');
    if (transport === 'http') this.httpEntry(id);
    else if (!this.rebootTransports(entry).includes('mqtt'))
      throw new GatewayError('Контроллер недоступен через MQTT', 'validation');
    const record = this.reboots.begin(id, transport, this.rebootSamples(entry));
    if (!record) throw new GatewayError('Перезагрузка уже выполняется', 'validation');
    try {
      if (transport === 'http') await requestGateway(entry, '/api/reboot', { form: {} });
      else {
        const { remote } = this.observation(entry);
        const viaHa = remote?.online && this.mqttDiscovery?.client?.connected;
        await publishReboot(
          viaHa ? this.mqttDiscovery.client : rt?.monitor.client,
          viaHa ? remote.mqttPrefix : rt?.mqtt?.prefix,
        );
      }
    } catch (error) {
      if (error.code !== 'mqtt_uncertain') this.reboots.remove(id);
      throw error;
    }
    return { success: true, transport, reboot: this.rebootStatus(entry) };
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
      await this.udpLog.track(this.udpEntry(entry));
      this.syncTrackedDiscovery();
      return this.publicEntry(entry);
    });
  }
  runtime(entry) {
    if (!this.runtimes.has(entry.id)) {
      const cached = this.cache?.data.http.find((item) => item.id === entry.id && item.address === entry.address);
      this.runtimes.set(entry.id, {
        error: null,
        lastSuccess: null,
        info: null,
        uptime: null,
        uptimeAt: null,
        mqtt: null,
        devices: [],
        coordinator: null,
        ...cached,
        confirmed: false,
        connected: null,
        detailsAt: 0,
        joinUntil: 0,
        monitor: new MqttMonitor(),
        events: new EventMonitor(entry),
      });
    }
    return this.runtimes.get(entry.id);
  }
  publicEntry(entry) {
    const result = this.rawEntry(entry);
    result.reboot = this.rebootStatus(entry);
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
      const observed = { ...entry.mqttSnapshot, ...Object.fromEntries(Object.entries(live || {})
        .filter(([, value]) => value !== null && value !== undefined && value !== '')) };
      const availability = local?.online || live?.online ? 'online'
        : live?.availability || (Date.now() - this.startedAt < OFFLINE_TIMEOUT ? 'unknown' : 'offline');
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
        connected: availability === 'unknown' ? null : availability === 'online',
        availability,
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
        monitor: this.mqttDiscovery?.monitor(entry.mqttPrefix) || { connected: false },
        devices: [],
        error: null,
      };
    }
    const rt = this.runtime(entry);
    const observed = this.discovery.devices.get(entry.discoveryId);
    const uptime = observed && observed.lastSeen > (rt.uptimeAt || 0) ? observed.uptime : rt.uptime;
    const connected = rt.connected === true || local?.online || remote?.online ? true
      : !rt.confirmed && Date.now() - this.startedAt < OFFLINE_TIMEOUT ? null : false;
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
      connected,
      availability: connected === null ? 'unknown' : connected ? 'online' : 'offline',
      error: rt.error,
      lastSuccess: rt.lastSuccess,
      lastDataAt:
        Math.max(
          rt.lastSuccess || 0,
          rt.lastDataAt || 0,
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
      monitor: this.monitorStatus(entry),
      deviceCount: rt.coordinator?.device_count ?? null,
    };
  }
  monitorStatus(entry) {
    if (this.mqttDiscovery?.mode !== 'homeassistant') {
      const status = this.runtime(entry).monitor.status;
      const fresh = Date.now() - (status.liveUptimeAt || 0) < 180000;
      const availability = !status.connected ? 'unknown'
        : status.bridgeState === 'offline' ? 'offline'
          : fresh ? 'online' : 'unknown';
      return { ...status, mode: 'direct', availability };
    }
    const prefix = entry.mqttPrefix || this.runtimes.get(entry.id)?.mqtt?.prefix;
    const status = this.mqttDiscovery.monitor(prefix);
    if (entry.monitoringMode === 'off')
      return { ...status, connected: false, ready: false, error: null, message: 'Диагностика выключена' };
    return status;
  }
  state() {
    return {
      version: '0.1.15',
      sidebarInstallation: this.sidebarInstallation || null,
      cacheError: this.cache?.error || null,
      discovery: {
        ...this.discovery.snapshot(),
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
      ...(old?.udpLog ? { udpLog: old.udpLog } : {}),
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
    await this.udpLog.track(this.udpEntry(entry));
    await this.refresh(entry, true);
    this.syncTrackedDiscovery();
    return this.publicEntry(entry);
  }
  async refresh(entry, forceConfig = false) {
    if (entry.mode === 'mqtt') return;
    const rt = this.runtime(entry);
    if (rt.pending) return rt.pending;
    rt.pending = (async () => {
      try {
        let uptimeAt = Date.now();
        const info = await requestGateway(entry, '/api/info');
        if (this.stopped || !this.store.entries.includes(entry)) return;
        if (!info || typeof info.version !== 'string' || typeof info.board !== 'string')
          throw new GatewayError('Неизвестный ответ SLS', 'protocol');
        rt.info = { ...rt.info, ...Object.fromEntries(Object.entries(info)
          .filter(([, value]) => value !== null && value !== undefined && value !== '')) };
        rt.connected = true;
        rt.confirmed = true;
        rt.lastSuccess = Date.now();
        rt.error = null;
        // /api/info does not include uptime on current firmware.
        let uptime = info.uptime;
        if (!Number.isFinite(uptime) || uptime < 0) {
          try {
            uptimeAt = Date.now();
            uptime = (await requestGateway(entry, '/api/time')).uptime;
          } catch {
            uptime = null;
          }
        }
        if (this.stopped || !this.store.entries.includes(entry)) return;
        if (Number.isFinite(uptime) && uptime >= 0) {
          rt.uptime = uptime;
          rt.uptimeAt = uptimeAt;
        }
        if (forceConfig || !rt.configAt || Date.now() - rt.configAt > 300000) {
          try {
            const config = await readGatewayConfig(entry);
            if (this.stopped || !this.store.entries.includes(entry)) return;
            rt.mqtt = publicMqtt(config);
            rt.configAt = Date.now();
            rt.configError = null;
            this.mqttDiscovery?.watchPrefix(rt.mqtt.prefix);
            this.mqttDiscovery?.watchDiscoveryPrefix(rt.mqtt.discoveryPrefix);
            if (this.mqttDiscovery?.mode !== 'homeassistant' && entry.monitoringMode !== 'off' && !rt.monitor.client)
              rt.monitor.start(config);
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
    if (!rt.confirmed || force) await this.refresh(entry, force);
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
    const result = [...devices.values()].sort((a, b) => Number(b.controller) - Number(a.controller));
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
    if (enabled) {
      const config = await readGatewayConfig(entry);
      rt.mqtt = publicMqtt(config);
      this.mqttDiscovery?.watchPrefix(rt.mqtt.prefix);
      this.mqttDiscovery?.watchDiscoveryPrefix(rt.mqtt.discoveryPrefix);
      if (this.mqttDiscovery?.mode !== 'homeassistant') rt.monitor.start(config);
    } else rt.monitor.stop();
    entry.monitoring = enabled;
    entry.monitoringMode = enabled ? 'on' : 'off';
    await this.store.save();
    return this.monitorStatus(entry);
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
  udpEntry(entry) {
    const { local, remote } = this.observation(entry);
    const source = entry.udpLog?.source || [
      entry.address ? new URL(entry.address).hostname : null,
      local?.address, remote?.address, entry.mqttSnapshot?.address,
    ].find(unicastIPv4) || '';
    return {
      ...entry,
      name: entry.mode === 'mqtt' ? remote?.name || entry.name : entry.name,
      udpLog: { ...UDP_DEFAULTS, ...entry.udpLog, source },
    };
  }
  async syncUdpReceivers() {
    for (const entry of this.store.entries) {
      if (this.stopped) break;
      await this.udpLog.track(this.udpEntry(entry));
    }
  }
  async udpStatus(id) {
    await this.udpReady;
    const entry = this.entry(id);
    const result = await this.udpLog.snapshot(id);
    result.sender = this.udpSender.status.get(id) || null;
    result.httpAvailable = entry.mode !== 'mqtt';
    return result;
  }
  configureUdp(id, input) {
    return this.mutate(async () => {
      const entry = this.entry(id);
      const config = validateUdpConfig(input, this.udpLog.reservedPort);
      this.udpLog.assertAvailable(id, config);
      const previous = entry.udpLog;
      entry.udpLog = config;
      try { await this.store.save(); }
      catch (error) { entry.udpLog = previous; throw error; }
      await this.udpLog.configure(id, config, this.udpEntry(entry).name);
      return this.udpStatus(id);
    });
  }
  udpSenderAction(id, body) {
    return this.mutate(() => {
      const entry = this.httpEntry(id);
      if (body.action === 'inspect') return this.udpSender.inspect(entry);
      if (body.action === 'preview') return this.udpSender.preview(entry, body);
      if (body.action === 'apply') return this.udpSender.apply(entry, body.token);
      throw new GatewayError('Неизвестная операция настройки UDP', 'validation');
    });
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
      await this.udpLog.remove(id);
    } catch (error) {
      this.store.entries = before;
      await this.store.save();
      throw error;
    }
    this.udpSender.remove(id);
    const rt = this.runtimes.get(id);
    rt?.monitor.stop();
    rt?.events.close();
    this.runtimes.delete(id);
    this.reboots.remove(id);
    this.syncTrackedDiscovery();
    await this.saveCache();
  }
  start() {
    this.stopped = false;
    this.cacheTimer = setInterval(() => void this.saveCache(), 15000).unref();
    this.udpReady = this.mutate(() => this.udpLog.start(this.store.entries.map(entry => this.udpEntry(entry))));
    void this.udpReady.catch(error => console.error('UDP log startup:', error.code || error.message));
    // MQTT may provide an address after startup. Refresh receivers without opening the UI.
    this.udpTimer = setInterval(() => {
      if (this.syncingUdp) return;
      this.syncingUdp = true;
      void this.mutate(() => this.syncUdpReceivers())
        .catch(error => console.error('UDP log configuration:', error.code || error.message))
        .finally(() => { this.syncingUdp = false; });
    }, 5000).unref();
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
    this.rebootTimer = setInterval(() => void this.checkReboots(), 5000).unref();
  }
  close() {
    this.stopped = true;
    this.homeAssistant?.close();
    clearInterval(this.timer);
    clearInterval(this.rebootTimer);
    clearInterval(this.udpTimer);
    clearInterval(this.cacheTimer);
    for (const rt of this.runtimes.values()) {
      rt.monitor.stop();
      rt.events.close();
    }
    return Promise.all([this.udpLog.close(), this.saveCache()]);
  }
}
