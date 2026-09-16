import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { parseDocument } from 'yaml';

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const mapping = (value) => value && typeof value === 'object' && !Array.isArray(value);
const tags = [
  '!include',
  '!include_dir_list',
  '!include_dir_named',
  '!include_dir_merge_list',
  '!include_dir_merge_named',
  '!secret',
  '!env_var',
].map((tag) => ({ tag, resolve: (value) => ({ yamlTag: tag, value }) }));

// Read only files reachable from configuration.yaml. Never resolve secrets or execute templates.
export async function readYamlObjects(directory = '/homeassistant') {
  const warnings = new Set();
  const objects = [];
  let root;
  try {
    root = await realpath(directory);
  } catch {
    return { objects, warnings: ['Конфигурация YAML недоступна. Показаны связи, полученные от HA.'] };
  }
  let count = 0,
    bytes = 0;
  async function load(file, parents = []) {
    if (parents.length >= 20 || ++count > 512) throw new Error('limit');
    const path = await realpath(file);
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
      throw new Error('path');
    if (parents.includes(path)) throw new Error('cycle');
    const size = (await stat(path)).size;
    bytes += size;
    if (size > 2097152 || bytes > 16777216) throw new Error('limit');
    const doc = parseDocument(await readFile(path, 'utf8'), { customTags: tags, strict: true });
    if (doc.errors.length) throw new Error('yaml');
    async function unpack(value) {
      if (value?.yamlTag) {
        if (['!secret', '!env_var'].includes(value.yamlTag)) return null;
        const target = resolve(dirname(path), String(value.value));
        if (value.yamlTag === '!include') return load(target, [...parents, path]);
        const checked = await realpath(target);
        const relDir = relative(root, checked);
        if (isAbsolute(relDir) || relDir.startsWith('..')) throw new Error('path');
        const files = [];
        async function walk(folder) {
          if (files.length > 512) throw new Error('limit');
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
            const name = resolve(folder, entry.name);
            if (entry.isDirectory()) await walk(name);
            else if (/\.ya?ml$/i.test(entry.name)) files.push(name);
          }
        }
        await walk(checked);
        const items = [];
        for (const name of files.sort()) items.push([name, await load(name, [...parents, path])]);
        if (value.yamlTag === '!include_dir_list') return items.map(([, item]) => item);
        if (value.yamlTag === '!include_dir_merge_list') return items.flatMap(([, item]) => list(item));
        const merged = Object.create(null);
        for (const [name, item] of items) {
          if (value.yamlTag === '!include_dir_named') merged[basename(name).replace(/\.ya?ml$/i, '')] = item;
          else if (mapping(item)) Object.assign(merged, item);
        }
        return merged;
      }
      if (Array.isArray(value)) return Promise.all(value.map(unpack));
      if (mapping(value)) {
        const result = Object.create(null);
        for (const [key, item] of Object.entries(value)) {
          try {
            result[key] = await unpack(item);
          } catch {
            warnings.add('Некоторые включения YAML недоступны или превышают ограничения чтения.');
            result[key] = null;
          }
        }
        Object.defineProperty(result, '_yamlFile', { value: rel.replaceAll('\\', '/') });
        return result;
      }
      return value;
    }
    return unpack(doc.toJS({ maxAliasCount: 100 }));
  }
  function describe(config, domain, key = null, context = []) {
    if (!mapping(config)) return;
    const topics = new Set(),
      references = new Set(),
      devices = new Set(),
      areas = new Set();
    function scan(value, field = '', depth = 0) {
      if (depth > 30) return;
      if (typeof value === 'string') {
        if (field.endsWith('_topic') || field === 'topic') topics.add(value);
        if (field === 'device_id') devices.add(value);
        if (field === 'area_id') areas.add(value);
        for (const match of value.matchAll(/\b([a-z_]+\.[a-z0-9_]+)\b/g)) references.add(match[1]);
        for (const match of value.matchAll(/\bstates\.([a-z_]+\.[a-z0-9_]+)\b/g)) references.add(match[1]);
      } else if (Array.isArray(value)) value.forEach((v) => scan(v, field, depth + 1));
      else if (mapping(value))
        for (const [k, v] of Object.entries(value)) {
          if (/password|secret|token|credential|api_key/i.test(k)) continue;
          scan(v, k, depth + 1);
        }
    }
    scan(config);
    context.forEach((value) => scan(value));
    objects.push({
      domain,
      uniqueId: config.unique_id == null ? null : String(config.unique_id),
      id: config.id == null ? null : String(config.id),
      entityId:
        config.default_entity_id || (key && ['script', 'group'].includes(domain) ? domain + '.' + key : null),
      name: config.name || config.friendly_name || config.alias || null,
      topics: [...topics],
      references: [...references],
      devices: [...devices],
      areas: [...areas],
      file: config._yamlFile || 'configuration.yaml',
    });
  }
  function collect(config) {
    if (!mapping(config)) return;
    for (const [fullDomain, value] of Object.entries(config)) {
      const domain = fullDomain.split(' ')[0];
      if (domain === 'mqtt') {
        for (const block of list(value))
          if (mapping(block))
            for (const [kind, entries] of Object.entries(block))
              for (const entry of list(entries)) describe(entry, kind);
      } else if (domain === 'template') {
        for (const block of list(value))
          if (mapping(block))
            for (const [kind, entries] of Object.entries(block))
              if (!['trigger', 'triggers', 'action', 'actions'].includes(kind))
                for (const entry of list(entries))
                  describe(entry, kind, null, [block.trigger, block.triggers, block.action, block.actions]);
      } else if (['script', 'group'].includes(domain) && mapping(value)) {
        for (const [key, entry] of Object.entries(value)) describe(entry, domain, key);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry?.sensors && mapping(entry.sensors))
            for (const [key, sensor] of Object.entries(entry.sensors))
              describe({ ...sensor, default_entity_id: domain + '.' + key }, domain);
          else describe(entry, domain);
        }
      }
    }
    for (const item of Object.values(config.homeassistant?.packages || {})) collect(item);
  }
  try {
    collect(await load(resolve(root, 'configuration.yaml')));
  } catch {
    warnings.add('Не вся YAML-конфигурация прочитана: проверьте синтаксис, включения и доступ к файлам.');
  }
  return { objects: objects.slice(0, 20000), warnings: [...warnings] };
}
