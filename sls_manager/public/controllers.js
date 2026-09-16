'use strict';
window.slsViews = (() => {
  let view = 'blocks',
    deviceId = null,
    detailId = null,
    haData = null,
    haBusy = null,
    haAt = 0;
  let kind = 'all',
    page = 0;
  try {
    if (localStorage.getItem('sls-controller-view') === 'table') view = 'table';
  } catch {}
  const kinds = {
    all: 'Все',
    device: 'Устройства',
    entity: 'Сущности',
    automation: 'Автоматизации',
    script: 'Скрипты',
    scene: 'Сцены',
    group: 'Группы',
  };

  const sorts = {
    saved: { key: 'name', direction: 1 },
    visible: { key: 'name', direction: 1 },
    entities: { key: 'name', direction: 1 },
    objects: { key: 'name', direction: 1 },
  };
  const compare = (a, b) =>
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a ?? '').localeCompare(String(b ?? ''), 'ru', { numeric: true, sensitivity: 'base' });
  function sorted(items, group, value, availability = false) {
    const sort = sorts[group];
    return [...items].sort((a, b) => {
      if (availability && Boolean(a.online) !== Boolean(b.online))
        return Number(Boolean(b.online)) - Number(Boolean(a.online));
      const av = value(a, sort.key),
        bv = value(b, sort.key);
      const missingA = av == null || av === '' || av === '—',
        missingB = bv == null || bv === '' || bv === '—';
      if (missingA !== missingB) return Number(missingA) - Number(missingB);
      return compare(av, bv) * sort.direction || compare(a.name, b.name);
    });
  }
  function sortableHead(row, columns, group, render) {
    const sort = sorts[group];
    for (const [label, key] of columns) {
      const th = el('th');
      if (!key) th.textContent = label;
      else {
        const selected = sort.key === key;
        th.setAttribute('aria-sort', selected ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none');
        const button = el(
          'button',
          'sort-heading',
          label + (selected ? (sort.direction === 1 ? ' ↑' : ' ↓') : ''),
        );
        button.title = 'Сортировать: ' + label;
        button.onclick = () => {
          sort.direction = selected ? -sort.direction : 1;
          sort.key = key;
          page = 0;
          render();
        };
        th.append(button);
      }
      row.append(th);
    }
  }
  function controllerValue(c, key) {
    if (key === 'area') return c.ha?.area || '';
    if (key === 'uptime') return c.raw.uptime;
    if (key === 'source') return [c.ll ? 'LocalLink' : '', c.mqtt ? 'MQTT' : ''].filter(Boolean).join(' ');
    if (key === 'ip' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(c.ip))
      return c.ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
    return c[key];
  }
  function haLink(url, label = 'MQTT ↗', className = 'mqtt-shortcut') {
    if (typeof url !== 'string' || !url.startsWith('/config/')) {
      const button = el('button', className, label);
      button.disabled = true;
      button.title = 'Соответствующее устройство ещё не найдено в реестре HA';
      return button;
    }
    const link = el('a', className, label);
    link.href = url;
    link.target = '_top';
    link.title = label.startsWith('MQTT')
      ? 'Открыть соответствующее устройство MQTT в HA'
      : 'Открыть объект в HA';
    const entityId = new URL(url, location.origin).searchParams.get('more-info-entity-id');
    if (entityId)
      link.onclick = (event) => {
        try {
          const ha = window.parent.document.querySelector('home-assistant');
          if (!ha) return;
          event.preventDefault();
          ha.dispatchEvent(
            new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }),
          );
        } catch {
          /* A direct HA link remains usable outside the same-origin frame. */
        }
      };
    return link;
  }
  function area(ha) {
    return ha?.area || (ha?.deviceId ? 'Не назначено' : '—');
  }
  function controller(g, saved) {
    let address = saved ? g.webAddress || g.address : g.address ? 'http://' + g.address : null;
    let host = '';
    try {
      host = new URL(address).hostname;
    } catch {}
    const observed = g.observed || {};
    // Hostnames remain searchable; only numeric addresses belong in the IP column.
    const ipCandidate = observed.address || (saved ? host : g.address);
    const ip =
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ipCandidate || '') || String(ipCandidate || '').includes(':')
        ? ipCandidate
        : '';
    if (ip && address) {
      try {
        const target = new URL(address);
        target.hostname = ip;
        address = target.href;
      } catch {}
    }
    const ll = saved ? g.localLink : (g.source || '').includes('LocalLink');
    const mqtt = saved ? g.mode === 'mqtt' || g.mqtt?.enabled : (g.source || '').includes('MQTT');
    return {
      raw: g,
      saved,
      address,
      host,
      ip,
      ll,
      mqtt,
      name: g.name || 'SLS',
      board: g.info?.board || g.board || observed.board || 'SLS',
      version: g.info?.version || g.version || observed.version || '—',
      mac:
        [g.mac, g.discoveryId, observed.mac, saved ? observed.id : g.source !== 'MQTT' ? g.id : ''].find(
          (value) => /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value || ''),
        ) || '',
      online: saved ? g.connected : g.online,
      last: saved ? g.lastDataAt : g.lastSeen,
      ha: g.ha,
    };
  }
  function matches(c, query) {
    const values = [
      c.name,
      c.host,
      c.ip,
      c.version,
      c.mac,
      c.raw.mqttPrefix,
      c.raw.mqtt?.prefix,
      c.raw.info?.hostname,
      c.raw.observed?.name,
      c.ll || c.raw.discoveryId ? 'LocalLink LL' : '',
      c.mqtt ? 'MQTT' : '',
    ]
      .join(' ')
      .toLowerCase();
    return query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .every(
        (term) =>
          values.includes(term) ||
          (term.replace(/[:-]/g, '').length >= 6 &&
            c.mac.replace(/[:-]/g, '').toLowerCase().includes(term.replace(/[:-]/g, ''))),
      );
  }
  function sources(c) {
    const node = el('div', 'source-stack');
    if (c.ll) node.append(badge('LocalLink', 'success'));
    if (c.mqtt) node.append(haLink(c.ha?.url, 'MQTT ↗', 'mqtt-inline'));
    if (!node.childNodes.length) node.append(el('span', 'muted', '—'));
    return node;
  }
  function actions(c, compact = false) {
    const node = el('div', 'card-actions');
    if (!c.saved) {
      const add = el('button', '', 'Добавить');
      add.onclick = () => (c.raw.source === 'MQTT' ? trackMqtt(c.raw, add) : openConnect(c.raw));
      node.append(add);
      return node;
    }
    const reboot = el('button', 'reboot-control', compact ? '↻' : 'Перезагрузить');
    reboot.title = 'Перезагрузить ' + c.name;
    reboot.setAttribute('aria-label', reboot.title);
    reboot.disabled = !c.raw.rebootTransports?.length;
    reboot.onclick = () => rebootGateway(c.raw, reboot);
    const remove = el('button', 'remove-control', '×');
    remove.title = 'Убрать ' + c.name + ' из отслеживания';
    remove.setAttribute('aria-label', remove.title);
    remove.onclick = () => forgetGateway(c.raw, remove);
    node.append(reboot, remove);
    return node;
  }
  function nameNode(c) {
    const node = el(c.saved ? 'button' : 'span', 'gateway-open');
    node.append(connectionDot(c.online), el('strong', '', c.name));
    if (c.saved) node.onclick = () => selectGateway(c.raw.id);
    return node;
  }
  function renderTable(items, group) {
    const wrap = el('div', 'controller-table-wrap');
    const table = el('table', 'controller-table');
    const head = el('thead'),
      row = el('tr'),
      body = el('tbody');
    sortableHead(
      row,
      [
        ['Имя', 'name'],
        ['Пространство', 'area'],
        ['Контроллер', 'board'],
        ['IP', 'ip'],
        ['MAC', 'mac'],
        ['Прошивка', 'version'],
        ['Аптайм', 'uptime'],
        ['Источник', 'source'],
        ['', null],
      ],
      group,
      renderOverview,
    );
    head.append(row);
    for (const c of items) {
      const tr = el('tr'),
        name = el('td', 'col-name');
      name.append(nameNode(c), el('small', '', ago(c.last)));
      const ip = el('td', 'mono');
      ip.append(c.ip ? webLink(c.address, c.ip) : el('span', '', '—'));
      const source = el('td', 'col-source');
      source.append(sources(c));
      const buttons = el('td', 'row-actions');
      buttons.append(actions(c, true));
      tr.append(
        name,
        el('td', 'col-area', area(c.ha)),
        el('td', 'col-board', c.board),
        ip,
        el('td', 'mono', c.mac || '—'),
        el('td', 'mono', c.version),
        el('td', 'mono', uptime(c.raw.uptime)),
        source,
        buttons,
      );
      body.append(tr);
    }
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }
  function renderBlock(c) {
    const card = el('article', 'gateway-card');
    const name = el('div', 'name-block'),
      line = el('div', 'gateway-title');
    line.append(nameNode(c));
    if (c.ll) line.append(badge('LocalLink', 'success'));
    if (c.mqtt) line.append(haLink(c.ha?.url, 'MQTT ↗', 'mqtt-inline'));
    name.append(line, el('div', 'name-meta', area(c.ha) + ' · Данные: ' + ago(c.last)));
    const address = el('div', 'compact-field address');
    address.append(
      c.ip ? webLink(c.address, c.ip) : el('span', '', '—'),
      el('small', 'card-uptime', uptime(c.raw.uptime)),
    );
    const model = el('div', 'card-model');
    model.append(el('span', '', c.board), el('small', '', c.version));
    card.append(name, address, model, actions(c));
    return card;
  }
  function overview(gateways, discovery) {
    const savedScroll = $('#gateway-cards .controller-table-wrap')?.scrollLeft || 0;
    const visibleScroll = $('#discovered-list .controller-table-wrap')?.scrollLeft || 0;
    const saved = gateways.map((g) => controller(g, true));
    const found = discovery.devices
      .filter((g) => !g.trackedId)
      .map((g) => controller(g, false))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const filteredSaved = sorted(
      saved.filter((c) => matches(c, $('#saved-filter').value)),
      'saved',
      controllerValue,
      true,
    );
    const filteredFound = sorted(
      found.filter((c) => matches(c, $('#visible-filter').value)),
      'visible',
      controllerValue,
      true,
    );
    $('#saved-caption').textContent =
      filteredSaved.length === saved.length
        ? String(saved.length)
        : filteredSaved.length + ' / ' + saved.length;
    $('#visible-caption').textContent =
      filteredFound.length === found.length
        ? String(found.length)
        : filteredFound.length + ' / ' + found.length;
    $('#gateway-cards').classList.toggle('table-view', view === 'table');
    $('#gateway-cards').replaceChildren(
      ...(filteredSaved.length
        ? view === 'table'
          ? [renderTable(filteredSaved, 'saved')]
          : filteredSaved.map(renderBlock)
        : [
            empty(
              saved.length ? 'Ничего не найдено' : 'Подключите первый контроллер',
              saved.length ? 'Измените фильтр.' : 'Выберите SLS в списке видимых контроллеров.',
            ),
          ]),
    );
    $('#discovered-list').replaceChildren(
      filteredFound.length
        ? renderTable(filteredFound, 'visible')
        : empty(
            found.length
              ? 'Ничего не найдено'
              : discovery.devices.length
                ? 'Все найденные контроллеры добавлены'
                : 'Ожидаем объявления SLS',
            found.length ? 'Измените фильтр.' : 'Обнаружение через LocalLink и брокер MQTT HA.',
          ),
    );
    if ($('#gateway-cards .controller-table-wrap'))
      $('#gateway-cards .controller-table-wrap').scrollLeft = savedScroll;
    if ($('#discovered-list .controller-table-wrap'))
      $('#discovered-list .controller-table-wrap').scrollLeft = visibleScroll;
    for (const button of document.querySelectorAll('[data-controller-view]')) {
      const selected = view === button.dataset.controllerView;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }
  function reset(id) {
    if (id === detailId) return;
    detailId = id;
    deviceId = null;
    haData = null;
    haAt = 0;
    haBusy = null;
    page = 0;
    kind = 'all';
    $('#ha-filter').value = '';
    $('#ha-source').value = 'all';
    $('#mqtt-device-filter').value = '';
    $('#mqtt-device-list').replaceChildren();
    $('#mqtt-device-select').replaceChildren();
    $('#mqtt-device-detail').replaceChildren();
    $('#ha-kinds').replaceChildren();
    $('#ha-pages').replaceChildren();
    $('#ha-count').textContent = '';
    $('#ha-note').textContent = '';
    showNotice('#ha-warning', null);
    $('#ha-objects').replaceChildren(empty('Объекты HA', 'Откройте вкладку для загрузки.'));
  }
  function mqttDevices() {
    const g = state.detail;
    if (!g) return;
    const query = $('#mqtt-device-filter').value.toLowerCase().trim();
    const devices = (g.mqttDevices || []).filter((d) =>
      [d.name, d.model, d.manufacturer, d.area, ...d.identifiers].join(' ').toLowerCase().includes(query),
    );
    if (!devices.some((d) => d.id === deviceId)) deviceId = devices[0]?.id || null;
    $('#mqtt-device-count').textContent = devices.length + ' / ' + (g.mqttDevices?.length || 0);
    const list = $('#mqtt-device-list'),
      select = $('#mqtt-device-select'),
      detail = $('#mqtt-device-detail');
    const scroll = list.scrollTop;
    const scrollLeft = detail.querySelector('.entity-table-wrap')?.scrollLeft || 0;
    const topicsOpen = Boolean(detail.querySelector('.mqtt-details')?.open);
    list.replaceChildren();
    select.replaceChildren();
    detail.replaceChildren();
    for (const device of devices) {
      const row = el('div', 'device-list-row'),
        button = el('button', 'device-list-item' + (device.id === deviceId ? ' active' : ''));
      button.setAttribute('aria-pressed', String(device.id === deviceId));
      button.append(
        el('strong', '', device.name),
        el(
          'small',
          '',
          [device.model || device.manufacturer, device.entities.length + ' сущн.']
            .filter(Boolean)
            .join(' · '),
        ),
      );
      button.onclick = () => {
        deviceId = device.id;
        mqttDevices();
      };
      row.append(button, haLink(device.haUrl, '↗', 'device-mqtt-link'));
      list.append(row);
      const option = el('option', '', device.name);
      option.value = device.id;
      option.selected = device.id === deviceId;
      select.append(option);
    }
    list.scrollTop = scroll;
    const device = devices.find((d) => d.id === deviceId);
    if (!device) {
      detail.append(
        empty(
          query ? 'Ничего не найдено' : 'Ожидаем MQTT Discovery',
          query ? 'Измените фильтр.' : 'Устройства появятся после получения их объявлений от брокера.',
        ),
      );
      return;
    }
    const header = el('div', 'device-detail-head'),
      title = el('div');
    title.append(
      el('h2', '', device.name),
      el('p', 'muted', [device.manufacturer, device.model].filter(Boolean).join(' · ')),
    );
    header.append(title, haLink(device.haUrl));
    const facts = el('div', 'device-facts');
    for (const [label, value] of [
      ['Пространство', device.area || (device.haDeviceId ? 'Не назначено' : '—')],
      ['Прошивка', device.version || '—'],
      ['Идентификатор', device.identifiers.join(', ')],
    ]) {
      const item = el('div');
      item.append(el('small', '', label), el('span', '', value));
      facts.append(item);
    }
    const table = el('table', 'entity-table'),
      thead = el('thead'),
      head = el('tr'),
      tbody = el('tbody');
    sortableHead(
      head,
      [
        ['Сущность', 'name'],
        ['Тип', 'domain'],
        ['Значение', 'value'],
        ['Данные', 'receivedAt'],
        ['', null],
      ],
      'entities',
      mqttDevices,
    );
    thead.append(head);
    for (const entity of sorted(device.entities, 'entities', (e, key) =>
      key === 'receivedAt' ? e.receivedAt || e.stateUpdatedAt : e[key],
    )) {
      const row = el('tr'),
        name = el('td'),
        value = el('td'),
        received = el('td'),
        link = el('td');
      name.append(
        el('span', '', entity.name),
        el('small', 'mono', entity.entityId || entity.uniqueId || 'Не найдена в HA'),
      );
      value.append(
        el(
          'strong',
          '',
          entity.disabled
            ? 'Отключена'
            : entity.value == null
              ? '—'
              : entity.value + (entity.unit ? ' ' + entity.unit : ''),
        ),
      );
      value.append(el('small', '', entity.valueSource === 'HA' ? 'Состояние HA' : 'MQTT'));
      received.append(
        el('span', '', ago(entity.receivedAt || entity.stateUpdatedAt)),
        el(
          'small',
          '',
          entity.receivedAt
            ? entity.retained
              ? 'Сохранённое (retained)'
              : 'Новое сообщение'
            : entity.stateUpdatedAt
              ? 'Обновление состояния HA'
              : 'Сообщение не получено',
        ),
      );
      if (entity.haUrl) link.append(haLink(entity.haUrl, '↗', 'object-open'));
      row.append(name, el('td', 'muted', entity.domain), value, received, link);
      tbody.append(row);
    }
    table.append(thead, tbody);
    const tableWrap = el('div', 'entity-table-wrap');
    tableWrap.append(table);
    const topics = el('details', 'mqtt-details');
    topics.append(el('summary', '', 'Топики MQTT'));
    const dl = el('dl');
    for (const topic of [...new Set(device.entities.map((e) => e.stateTopic).filter(Boolean))])
      dl.append(el('dt', '', 'Состояние'), el('dd', '', topic));
    for (const topic of [...new Set(device.entities.map((e) => e.discoveryTopic))])
      dl.append(el('dt', '', 'Discovery'), el('dd', '', topic));
    topics.append(dl);
    topics.open = topicsOpen;
    detail.append(
      header,
      facts,
      tableWrap,
      topics,
      el(
        'p',
        'reading-note',
        'Retained — сохранённое сообщение брокера. Оно не подтверждает текущую доступность устройства.',
      ),
    );
    tableWrap.scrollLeft = scrollLeft;
  }
  function detail() {
    const g = state.detail;
    if (!g) return;
    reset(g.id);
    showNotice(
      '#mqtt-view-warning',
      (g.mqttCatalogLimited
        ? 'Достигнут предел каталога Discovery (4096 сущностей); список может быть неполным.'
        : null) ||
        g.ha?.error ||
        (!g.monitor?.connected
          ? 'Нет связи с MQTT-брокером. Показаны последние доступные объявления и состояния.'
          : null),
    );
    $('#detail-ha').replaceChildren(
      el('span', 'area-pill', 'Пространство: ' + area(g.ha)),
      haLink(g.ha?.url),
    );
    $('#detail-reboot').disabled = !g.rebootTransports?.length;
    $('#mqtt-workspace-panel').hidden = !(
      (g.mode === 'mqtt' && state.tab === 'devices') ||
      state.tab === 'mqtt'
    );
    if (!$('#mqtt-workspace-panel').hidden) mqttDevices();
    if (state.tab === 'ha') void loadHa();
  }
  async function loadHa() {
    const id = state.selected;
    if (!id || state.tab !== 'ha' || haBusy || Date.now() - haAt < 15000) return;
    reset(id);
    const request = {};
    haBusy = request;
    haAt = Date.now();
    if (!haData)
      $('#ha-objects').replaceChildren(empty('Загружаем объекты HA', 'Читаем реестры и связи контроллера.'));
    try {
      const result = await api('gateways/' + id + '/ha');
      if (state.selected !== id || haBusy !== request) return;
      haData = result;
      haAt = Date.now();
      renderHa();
    } catch (error) {
      if (state.selected === id && haBusy === request) {
        showNotice('#ha-warning', error.message);
        if (!haData)
          $('#ha-objects').replaceChildren(
            empty('Объекты HA недоступны', 'Повторное чтение произойдёт автоматически.'),
          );
      }
    } finally {
      if (haBusy === request) haBusy = null;
    }
  }
  function renderHa() {
    if (!haData) return;
    showNotice('#ha-warning', (haData.warnings || []).join(' '));
    $('#ha-note').textContent = haData.note || '';
    const scrollLeft = $('#ha-objects').scrollLeft;
    const all = haData.objects || [];
    const query = $('#ha-filter').value.toLowerCase().trim(),
      source = $('#ha-source').value;
    const filtered = sorted(
      all.filter(
        (o) =>
          (kind === 'all' || kind === o.kind) &&
          (source === 'all' || source === o.source) &&
          [o.id, o.name, o.area, o.source, o.relation, o.value].join(' ').toLowerCase().includes(query),
      ),
      'objects',
      (o, key) => o[key],
    );
    const count = Math.max(1, Math.ceil(filtered.length / 20));
    page = Math.min(page, count - 1);
    $('#ha-kinds').replaceChildren();
    for (const [key, label] of Object.entries(kinds)) {
      const total = key === 'all' ? all.length : all.filter((o) => o.kind === key).length;
      if (!total && key !== 'all') continue;
      const button = el('button', key === kind ? 'selected' : '', label + ' ' + total);
      button.setAttribute('aria-pressed', String(key === kind));
      button.onclick = () => {
        kind = key;
        page = 0;
        renderHa();
      };
      $('#ha-kinds').append(button);
    }
    const table = el('table', 'ha-table'),
      head = el('thead'),
      heading = el('tr'),
      body = el('tbody');
    sortableHead(
      heading,
      [
        ['Имя', 'name'],
        ['Тип', 'kind'],
        ['Пространство', 'area'],
        ['Создано', 'source'],
        ['Связь с контроллером', 'relation'],
        ['Состояние', 'value'],
        ['', null],
      ],
      'objects',
      renderHa,
    );
    head.append(heading);
    for (const object of filtered.slice(page * 20, page * 20 + 20)) {
      const row = el('tr'),
        name = el('td'),
        origin = el('td'),
        relation = el('td'),
        link = el('td');
      name.append(el('strong', '', object.name), el('small', 'mono', object.id));
      origin.append(badge(object.source));
      if (object.file) origin.append(el('small', '', object.file));
      relation.append(el('span', '', object.relation));
      link.append(haLink(object.url, 'Открыть ↗', 'object-open'));
      row.append(
        name,
        el('td', '', kinds[object.kind] || object.kind),
        el('td', '', object.area || '—'),
        origin,
        relation,
        el('td', '', object.value),
        link,
      );
      body.append(row);
    }
    table.append(head, body);
    $('#ha-objects').replaceChildren(
      filtered.length
        ? table
        : empty(
            'Объекты не найдены',
            all.length ? 'Измените фильтр.' : 'Связи с этим MQTT-префиксом пока не найдены.',
          ),
    );
    $('#ha-objects').scrollLeft = scrollLeft;
    $('#ha-count').textContent =
      filtered.length + ' из ' + all.length + ' · данные HA: ' + ago(haData.updatedAt);
    $('#ha-pages').replaceChildren();
    for (let i = 0; i < count; i++) {
      if (count > 9 && i !== 0 && i !== count - 1 && Math.abs(i - page) > 2) continue;
      const button = el('button', i === page ? 'selected' : '', String(i + 1));
      button.setAttribute('aria-label', 'Страница ' + (i + 1));
      button.onclick = () => {
        page = i;
        renderHa();
      };
      $('#ha-pages').append(button);
    }
  }
  function tabChanged() {
    $('#mqtt-workspace-panel').hidden = !(
      state.tab === 'mqtt' ||
      (state.tab === 'devices' && state.detail?.mode === 'mqtt')
    );
    if (state.detail) detail();
    if (state.tab === 'ha') void loadHa();
  }
  function init() {
    for (const id of ['saved-filter', 'visible-filter']) $('#' + id).oninput = renderOverview;
    for (const button of document.querySelectorAll('[data-controller-view]'))
      button.onclick = () => {
        view = button.dataset.controllerView;
        try {
          localStorage.setItem('sls-controller-view', view);
        } catch {}
        renderOverview();
      };
    $('#mqtt-device-filter').oninput = mqttDevices;
    $('#mqtt-device-select').onchange = (event) => {
      deviceId = event.target.value;
      mqttDevices();
    };
    $('#ha-filter').oninput = () => {
      page = 0;
      renderHa();
    };
    $('#ha-source').onchange = () => {
      page = 0;
      renderHa();
    };
    $('#detail-reboot').onclick = (event) => rebootGateway(state.detail, event.currentTarget);
  }
  return { init, overview, detail, reset, tabChanged, haLink };
})();
