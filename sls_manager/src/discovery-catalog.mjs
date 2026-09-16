// Bounded, read-only projection of MQTT Discovery and last reported values.
const string = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '');
const components = new Set([
  'alarm_control_panel',
  'binary_sensor',
  'button',
  'camera',
  'climate',
  'cover',
  'device_tracker',
  'device_automation',
  'event',
  'fan',
  'humidifier',
  'image',
  'lawn_mower',
  'light',
  'lock',
  'notify',
  'number',
  'scene',
  'select',
  'sensor',
  'siren',
  'switch',
  'tag',
  'text',
  'update',
  'vacuum',
  'valve',
  'water_heater',
]);
const array = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const expand = (value, base) =>
  typeof value === 'string' && value.length <= 500
    ? value.replace(/^~(?=\/|$)|(?<=\/)~$/g, () => string(base))
    : '';
export function topicBelongs(topic, prefix) {
  return Boolean(prefix && typeof topic === 'string' && (topic === prefix || topic.startsWith(prefix + '/')));
}
export class DiscoveryCatalog {
  constructor() {
    this.configs = new Map();
    this.messages = new Map();
    this.topics = new Set();
    this.limited = false;
  }
  clear() {
    this.configs.clear();
    this.messages.clear();
    this.topics.clear();
    this.limited = false;
  }
  ingest(topic, payload, { retain = false } = {}, now = Date.now()) {
    if (topic.length > 500 || payload.length > 65536) return;
    if (this.topics.has(topic)) {
      this.messages.set(topic, {
        payload: payload.toString().slice(0, 8192),
        retained: Boolean(retain),
        receivedAt: now,
      });
    }
    if (!topic.endsWith('/config')) return;
    if (!payload.length) {
      this.configs.delete(topic);
      this.reindex();
      return;
    }
    let config;
    try {
      config = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!config || typeof config !== 'object') return;
    const shared = config.device || config.dev || {};
    const deviceComponents = config.components || config.cmps;
    const parts =
      deviceComponents && typeof deviceComponents === 'object' && !Array.isArray(deviceComponents)
        ? Object.entries(deviceComponents)
            .slice(0, 256)
            .map(([id, part]) => ({ ...config, ...part, device: shared, componentId: id }))
        : [config];
    const entries = parts.flatMap((part) => {
      const device = part.device || part.dev;
      if (!device || typeof device !== 'object') return [];
      const identifiers = array(device.identifiers || device.ids)
        .filter((v) => typeof v === 'string')
        .map((v) => v.slice(0, 300))
        .slice(0, 8);
      const stateTopic = expand(part.state_topic || part.stat_t, part['~']);
      const commandTopic = expand(part.command_topic || part.cmd_t, part['~']);
      const availabilityTopic = expand(
        part.availability_topic ||
          part.avty_t ||
          array(part.availability || part.avty)[0]?.topic ||
          array(part.availability || part.avty)[0]?.t,
        part['~'],
      );
      if (!identifiers.length || !(stateTopic || commandTopic || availabilityTopic)) return [];
      return [
        {
          key: topic + (part.componentId ? '#' + part.componentId : ''),
          discoveryTopic: topic,
          identifiers,
          deviceName: string(device.name),
          manufacturer: string(device.manufacturer || device.mf),
          model: string(device.model || device.mdl),
          version: string(device.sw_version || device.sw),
          via: string(device.via_device),
          uniqueId: string(part.unique_id || part.uniq_id),
          name: string(part.name) || string(part.object_id || part.obj_id) || topic.split('/').at(-2),
          domain:
            string(part.platform || part.p) ||
            topic
              .split('/')
              .slice(1, -2)
              .find((part) => components.has(part)) ||
            'sensor',
          stateTopic,
          commandTopic,
          availabilityTopic,
          valueTemplate: string(part.value_template || part.val_tpl, 1000),
          unit: string(part.unit_of_measurement || part.unit_of_meas, 30),
        },
      ];
    });
    if (!entries.length) {
      this.configs.delete(topic);
      this.reindex();
      return;
    }
    const total = [...this.configs.entries()].reduce(
      (n, [key, value]) => n + (key === topic ? 0 : value.length),
      0,
    );
    if (total + entries.length > 4096) {
      this.limited = true;
      return;
    }
    this.configs.set(topic, entries);
    this.reindex();
  }
  reindex() {
    this.topics = new Set(
      [...this.configs.values()]
        .flat()
        .map((e) => e.stateTopic)
        .filter(Boolean)
        .slice(0, 8192),
    );
    for (const topic of this.messages.keys()) if (!this.topics.has(topic)) this.messages.delete(topic);
  }
  entries(prefix) {
    return [...this.configs.values()]
      .flat()
      .filter(
        (e) =>
          e.via === prefix ||
          e.identifiers.includes(prefix) ||
          [e.stateTopic, e.commandTopic].some((t) => topicBelongs(t, prefix)),
      );
  }
  devices(prefix) {
    const devices = new Map();
    for (const entry of this.entries(prefix)) {
      const id = JSON.stringify([...entry.identifiers].sort());
      if (!devices.has(id))
        devices.set(id, {
          id,
          name: entry.deviceName || entry.identifiers[0],
          identifiers: entry.identifiers,
          manufacturer: entry.manufacturer,
          model: entry.model,
          version: entry.version,
          controller: entry.identifiers.includes(prefix),
          entities: [],
        });
      const message = this.messages.get(entry.stateTopic);
      let value = null;
      if (message) {
        if (!entry.valueTemplate) value = message.payload;
        else {
          // Recognize simple property access only; never execute broker templates.
          const match = entry.valueTemplate.match(
            /^\s*{{\s*value_json((?:\.[A-Za-z_][\w]*|\[['"][^'"]+['"]\])+)\s*}}\s*$/,
          );
          if (match) {
            try {
              let data = JSON.parse(message.payload);
              const keys = [...match[1].matchAll(/\.([A-Za-z_]\w*)|\[['"]([^'"]+)['"]\]/g)].map(
                (m) => m[1] || m[2],
              );
              for (const key of keys) data = data && Object.hasOwn(data, key) ? data[key] : undefined;
              if (data !== undefined) value = typeof data === 'object' ? JSON.stringify(data) : String(data);
            } catch {
              /* HA state is preferred when a template cannot be read locally. */
            }
          }
        }
      }
      devices.get(id).entities.push({
        id: entry.key,
        name: entry.name,
        uniqueId: entry.uniqueId,
        domain: entry.domain,
        discoveryTopic: entry.discoveryTopic,
        stateTopic: entry.stateTopic,
        unit: entry.unit,
        value,
        retained: message?.retained ?? null,
        receivedAt: message?.receivedAt || null,
      });
    }
    return [...devices.values()];
  }
}
