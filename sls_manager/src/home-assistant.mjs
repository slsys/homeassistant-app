import WebSocket from 'ws';
import { readYamlObjects } from './ha-yaml.mjs';
import { topicBelongs } from './discovery-catalog.mjs';

const clean = (value, size = 300) => (typeof value === 'string' ? value.slice(0, size) : '');
const deviceUrl = (id) => '/config/devices/device/' + encodeURIComponent(id);
const entityUrl = (id) => '/config/entities?more-info-entity-id=' + encodeURIComponent(id);
const entityKind = (id) =>
  ['automation', 'script', 'scene', 'group'].includes(id.split('.')[0]) ? id.split('.')[0] : 'entity';
async function batches(items, callback, width = 4) {
  const results = [];
  for (let i = 0; i < items.length; i += width)
    results.push(...(await Promise.all(items.slice(i, i + width).map(callback))));
  return results;
}

export class HomeAssistant {
  constructor() {
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.devices = [];
    this.entities = [];
    this.states = new Map();
    this.areas = new Map();
    this.yaml = { objects: [], warnings: [] };
    this.updatedAt = 0;
    this.error = null;
    this.relatedCache = new Map();
  }
  async connect() {
    if (this.closed) throw new Error('closed');
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) return;
    if (this.connecting) return this.connecting;
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) throw new Error('HA API доступен при запуске внутри Home Assistant');
    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket('ws://supervisor/core/websocket', {
        handshakeTimeout: 8000,
        maxPayload: 32 * 1024 * 1024,
      });
      this.socket = socket;
      this.authenticated = false;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('HA API: время ожидания истекло'));
      }, 10000);
      const fail = () => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.authenticated = false;
        reject(new Error('Нет доступа к HA API. Проверьте разрешение homeassistant_api и состояние HA.'));
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('HA API: соединение закрыто'));
        }
        this.pending.clear();
      };
      socket.on('error', () => {
        fail();
        socket.terminate();
      });
      socket.on('close', fail);
      socket.on('message', (payload) => {
        let message;
        try {
          message = JSON.parse(payload.toString());
        } catch {
          return;
        }
        if (message.type === 'auth_required')
          socket.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (message.type === 'auth_ok') {
          clearTimeout(timer);
          this.authenticated = true;
          resolve();
        } else if (message.type === 'auth_invalid') {
          fail();
          socket.terminate();
        } else if (message.type === 'result') {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.success) request.resolve(message.result);
          else request.reject(new Error('HA API: команда недоступна (' + request.type + ')'));
        }
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  async call(type, parameters = {}) {
    await this.connect();
    if (this.pending.size >= 32) throw new Error('HA API занят');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('HA API: время ожидания истекло'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer, type });
      this.socket.send(JSON.stringify({ ...parameters, id, type }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('HA API: ошибка отправки'));
        }
      });
    });
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const [devices, entities, areas, states] = await Promise.all([
          this.call('config/device_registry/list'),
          this.call('config/entity_registry/list'),
          this.call('config/area_registry/list'),
          this.call('get_states'),
        ]);
        if (![devices, entities, areas, states].every(Array.isArray))
          throw new Error('Неизвестный ответ HA API');
        this.devices = devices;
        this.entities = entities;
        this.areas = new Map(areas.map((a) => [a.area_id, a.name]));
        this.states = new Map(states.map((s) => [s.entity_id, s]));
        if (!this.registryAt || Date.now() - this.registryAt > 60000) {
          this.yaml = await readYamlObjects();
          this.registryAt = Date.now();
          for (const [key, value] of this.relatedCache) if (!value.promise) this.relatedCache.delete(key);
        }
        this.updatedAt = Date.now();
        this.error = null;
      } catch (error) {
        this.error = error.message;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  start() {
    if (!process.env.SUPERVISOR_TOKEN) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30000).unref();
  }
  metadata(prefix) {
    const device = this.devices.find((d) =>
      (d.identifiers || []).some(([domain, id]) => domain === 'mqtt' && id === prefix),
    );
    return {
      deviceId: device?.id || null,
      area: device ? this.areas.get(device.area_id) || null : null,
      url: device ? deviceUrl(device.id) : null,
      updatedAt: this.updatedAt || null,
      error: this.error,
    };
  }
  enrichDevices(devices) {
    return devices.map((device) => {
      const registered = this.devices.find((d) =>
        (d.identifiers || []).some(([domain, id]) => domain === 'mqtt' && device.identifiers.includes(id)),
      );
      return {
        ...device,
        name: registered?.name_by_user || registered?.name || device.name,
        haDeviceId: registered?.id || null,
        haUrl: registered ? deviceUrl(registered.id) : null,
        area: registered ? this.areas.get(registered.area_id) || null : null,
        entities: device.entities.map((entity) => {
          const matches = this.entities.filter(
            (e) =>
              e.platform === 'mqtt' &&
              e.unique_id === entity.uniqueId &&
              e.entity_id.startsWith(entity.domain + '.') &&
              (!registered || e.device_id === registered.id),
          );
          const entry = matches.length === 1 ? matches[0] : null;
          const state = entry && this.states.get(entry.entity_id);
          return {
            ...entity,
            entityId: entry?.entity_id || null,
            haUrl: entry ? entityUrl(entry.entity_id) : null,
            name: state?.attributes?.friendly_name || entry?.name || entity.name,
            value: state ? clean(String(state.state), 2000) : entity.value,
            unit: state?.attributes?.unit_of_measurement || entity.unit,
            valueSource: state ? 'HA' : 'MQTT',
            stateUpdatedAt: state ? Date.parse(state.last_updated) : null,
            disabled: Boolean(entry?.disabled_by),
          };
        }),
      };
    });
  }
  matchYaml(config) {
    const candidates = this.entities.filter((e) => e.entity_id.startsWith(config.domain + '.'));
    if (config.uniqueId) {
      const matched = candidates.filter((e) => e.unique_id === config.uniqueId || e.unique_id === config.id);
      if (matched.length === 1) return matched[0].entity_id;
    }
    if (
      config.entityId &&
      (this.states.has(config.entityId) || candidates.some((e) => e.entity_id === config.entityId))
    )
      return config.entityId;
    if (config.id) {
      const matched = [...this.states.values()].filter(
        (s) => s.entity_id.startsWith(config.domain + '.') && String(s.attributes?.id) === config.id,
      );
      if (matched.length === 1) return matched[0].entity_id;
      const registered = candidates.filter((e) => e.unique_id === config.id);
      if (registered.length === 1) return registered[0].entity_id;
    }
    if (config.name) {
      const matched = [...this.states.values()].filter(
        (s) => s.entity_id.startsWith(config.domain + '.') && s.attributes?.friendly_name === config.name,
      );
      if (matched.length === 1) return matched[0].entity_id;
    }
    return null;
  }
  async objects(prefix, discoveryDevices = []) {
    if (!this.updatedAt || Date.now() - this.updatedAt > 30000) await this.refresh();
    if (!this.updatedAt) return { objects: [], warnings: [this.error || 'Ожидаем HA API'], updatedAt: null };
    const cached = this.relatedCache.get(prefix);
    if (cached && Date.now() - cached.at < 60000) return this.materialize(cached);
    if (cached?.promise) return cached.promise;
    const promise = this.buildObjects(prefix, discoveryDevices)
      .then((result) => {
        this.relatedCache.set(prefix, result);
        return this.materialize(result);
      })
      .catch((error) => {
        this.relatedCache.delete(prefix);
        return { objects: [], warnings: [error.message], updatedAt: this.updatedAt };
      });
    this.relatedCache.set(prefix, { promise });
    return promise;
  }
  async buildObjects(prefix, discoveryDevices) {
    const warnings = [...this.yaml.warnings];
    const deadline = Date.now() + 15000;
    const withinBudget = () => {
      if (Date.now() < deadline && !this.closed) return true;
      warnings.push('Обход связей занял слишком много времени; показаны полученные связи.');
      return false;
    };
    const rows = new Map();
    const controller = this.metadata(prefix);
    const deviceIds = new Set(controller.deviceId ? [controller.deviceId] : []);
    for (const device of discoveryDevices) if (device.haDeviceId) deviceIds.add(device.haDeviceId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const device of this.devices)
        if (!deviceIds.has(device.id) && deviceIds.has(device.via_device_id || device.parent_device_id)) {
          deviceIds.add(device.id);
          changed = true;
        }
    }
    const discovered = new Map(
      discoveryDevices.flatMap((d) => d.entities.filter((e) => e.entityId).map((e) => [e.entityId, e])),
    );
    const yaml = this.yaml.objects
      .map((config) => ({ ...config, entityId: this.matchYaml(config) }))
      .filter((c) => c.entityId);
    const yamlById = new Map(yaml.map((c) => [c.entityId, c]));
    const addEntity = (id, relation, source = null) => {
      if (rows.has(id)) return false;
      if (!this.states.has(id) && !this.entities.some((e) => e.entity_id === id)) return false;
      const config = yamlById.get(id);
      rows.set(id, {
        id,
        kind: entityKind(id),
        source: source || (discovered.has(id) ? 'Discovery' : config ? 'YAML' : 'HA'),
        relation,
        file: config?.file || null,
      });
      return true;
    };
    for (const id of deviceIds) {
      const device = this.devices.find((d) => d.id === id);
      if (device)
        rows.set('device:' + id, {
          id,
          kind: 'device',
          source: 'HA',
          relation: id === controller.deviceId ? 'MQTT-контроллер' : 'Устройство контроллера',
        });
    }
    // Runtime MQTT subscriptions also identify manually configured entities on registered devices.
    const runtimeDiscovery = new Map();
    await batches([...deviceIds], async (device_id) => {
      if (!withinBudget()) return;
      try {
        const debug = await this.call('mqtt/device/debug_info', { device_id });
        for (const entity of debug?.entities || []) {
          const topic = (entity.subscriptions || []).find((s) => topicBelongs(s.topic, prefix))?.topic;
          const discoveryTopic = entity.discovery_data?.topic;
          if (discoveryTopic) runtimeDiscovery.set(entity.entity_id, discoveryTopic);
          if (topic)
            addEntity(
              entity.entity_id,
              'MQTT-подписка · ' + topic,
              discoveryTopic ? 'Discovery' : yamlById.has(entity.entity_id) ? 'YAML' : 'HA',
            );
        }
      } catch {
        warnings.push('Диагностика MQTT в HA недоступна для части устройств.');
      }
    });
    for (const entry of this.entities)
      if (deviceIds.has(entry.device_id))
        addEntity(
          entry.entity_id,
          'Устройство HA → контроллер',
          runtimeDiscovery.has(entry.entity_id) ? 'Discovery' : null,
        );
    for (const [id, entry] of discovered) addEntity(id, 'Discovery · ' + entry.stateTopic, 'Discovery');
    for (const config of yaml) {
      const topic = config.topics.find((t) => topicBelongs(t, prefix));
      if (topic) addEntity(config.entityId, 'MQTT-топик · ' + topic, 'YAML');
      else if (config.devices.some((id) => deviceIds.has(id)))
        addEntity(config.entityId, 'device_id контроллера или его устройства', 'YAML');
    }
    // HA's own relation search finds UI automations, scripts and scenes, including
    // objects without discovery. Only dependent types are included, not siblings.
    const seeds = [...deviceIds]
      .map((id) => ['device', id])
      .concat([...rows.values()].filter((r) => r.kind !== 'device').map((r) => ['entity', r.id]));
    const searched = new Set();
    for (let round = 0; round < 8 && seeds.length; round++) {
      const current = seeds.splice(0).filter(([type, id]) => !searched.has(type + ':' + id));
      if (searched.size + current.length > 1024) {
        warnings.push('Достигнут предел обхода связей HA (1024 объекта).');
        break;
      }
      await batches(current, async ([type, id]) => {
        if (!withinBudget()) return;
        searched.add(type + ':' + id);
        try {
          const related = await this.call('search/related', {
            item_type: type,
            item_id: id,
            include_disabled_entities: true,
          });
          for (const kind of ['automation', 'script', 'scene', 'group'])
            for (const target of related?.[kind] || [])
              if (addEntity(target, 'HA: ссылка на ' + id)) seeds.push(['entity', target]);
        } catch {
          warnings.push('Часть связей HA недоступна.');
        }
      });
      let more = true;
      while (more) {
        more = false;
        for (const config of yaml) {
          const reference = config.references.find((id) => rows.has(id) && id !== config.entityId);
          if (reference && addEntity(config.entityId, 'YAML: ссылка на ' + reference, 'YAML')) {
            more = true;
            seeds.push(['entity', config.entityId]);
          }
        }
      }
    }
    if (seeds.length) warnings.push('Глубина связей превышает 8 уровней; показана доступная часть.');
    return { rows: [...rows.values()], warnings: [...new Set(warnings)], at: Date.now() };
  }
  materialize(result) {
    return {
      updatedAt: this.updatedAt,
      warnings: [
        ...new Set([
          ...result.warnings,
          ...(this.error ? [this.error + ' Показаны последние доступные данные.'] : []),
        ]),
      ],
      note: 'Связи: реестры HA, Discovery, MQTT-топики и явные ссылки в YAML. Динамически вычисляемые ссылки в шаблонах могут быть не определены.',
      objects: result.rows.map((row) => {
        if (row.kind === 'device') {
          const device = this.devices.find((d) => d.id === row.id);
          return {
            ...row,
            name: device?.name_by_user || device?.name || row.id,
            area: this.areas.get(device?.area_id) || null,
            value: device?.model || '—',
            url: deviceUrl(row.id),
          };
        }
        const entry = this.entities.find((e) => e.entity_id === row.id);
        const state = this.states.get(row.id);
        const device = this.devices.find((d) => d.id === entry?.device_id);
        let url = entityUrl(row.id);
        if (row.kind === 'automation' && state?.attributes?.id)
          url = '/config/automation/edit/' + encodeURIComponent(state.attributes.id);
        if (row.kind === 'script') url = '/config/script/edit/' + encodeURIComponent(row.id.slice(7));
        if (row.kind === 'scene' && state?.attributes?.id)
          url = '/config/scene/edit/' + encodeURIComponent(state.attributes.id);
        return {
          ...row,
          name: state?.attributes?.friendly_name || entry?.name || entry?.original_name || row.id,
          area: this.areas.get(entry?.area_id || device?.area_id) || null,
          value: entry?.disabled_by
            ? 'Отключена'
            : state
              ? clean(String(state.state), 1000) +
                (state.attributes?.unit_of_measurement ? ' ' + state.attributes.unit_of_measurement : '')
              : 'Нет состояния',
          url,
        };
      }),
    };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.socket?.terminate();
  }
}
