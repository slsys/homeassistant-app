'use strict';
const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const state = {
  data: null,
  selected: null,
  detail: null,
  tab: 'devices',
  editId: null,
  discoveryId: null,
  mqttDirty: false,
  events: [],
  polling: false,
  detailBusy: false,
  eventBusy: null,
  eventView: 0,
  switching: 0,
};
const apiBase = new URL('./', window.location.href);
async function api(path, body, method = 'POST') {
  const response = await fetch(
    new URL(`api/${path}`, apiBase),
    body === undefined
      ? { cache: 'no-store' }
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-SLS-Request': '1' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = error ? 'error' : '';
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.hidden = true), 5500);
}
function badge(text, mode = '') {
  return el('span', `badge ${mode}`, text);
}
function connectionDot(connected) {
  const dot = el('span', 'status-dot' + (connected ? '' : ' off'));
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', connected ? 'На связи' : 'Нет связи');
  dot.title = connected ? 'На связи' : 'Нет связи';
  return dot;
}
function showNotice(selector, message) {
  const node = $(selector);
  node.textContent = message || '';
  node.hidden = !message;
}
function ago(time) {
  if (!time) return 'ещё нет данных';
  const sec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  return sec < 60
    ? `${sec} с назад`
    : sec < 3600
      ? `${Math.floor(sec / 60)} мин назад`
      : `${Math.floor(sec / 3600)} ч назад`;
}
function bytes(value) {
  return typeof value === 'number' ? `${Math.round(value / 1024)} КБ` : '—';
}
function uptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return (
    (days ? days + ' д ' : '') +
    (days || hours ? hours + ' ч ' : '') +
    (days || hours || minutes ? minutes + ' мин' : total + ' с')
  );
}
async function busy(button, action) {
  const disabled = button.disabled;
  button.disabled = true;
  try {
    return await action();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = disabled;
  }
}
function confirmAction(title, message, transports = []) {
  return new Promise((resolve) => {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = message;
    $('#reboot-transport-field').hidden = !transports.length;
    $('#reboot-transport').replaceChildren(
      ...transports.map((value) => {
        const option = el('option', '', value.toUpperCase());
        option.value = value;
        return option;
      }),
    );
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}
function empty(title, description) {
  const node = el('div', 'empty-state');
  node.append(el('h3', '', title), el('p', '', description));
  return node;
}

function field(label, value, className = '') {
  const node = el('div', 'compact-field ' + className);
  node.append(el('small', '', label), el('span', '', value));
  return node;
}
function webLink(address, label) {
  if (!address) return el('span', '', label || '—');
  let url;
  try {
    url = new URL(address);
  } catch {
    return el('span', '', label || '—');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return el('span', '', label || '—');
  const link = el('a', 'web-link', label || url.host);
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Веб-интерфейс контроллера · открывается из сети вашего браузера';
  return link;
}
async function trackMqtt(device, button) {
  await busy(button, async () => {
    await api('mqtt-tracking', { prefix: device.mqttPrefix });
    await poll();
    toast('Контроллер добавлен в отслеживание MQTT');
  });
}
async function forgetGateway(gateway, button) {
  if (!gateway) return;
  if (
    !(await confirmAction(
      'Убрать ' + gateway.name + ' из отслеживания?',
      'Сохранённый доступ будет удалён. Настройки контроллера и сущности в HA сохранятся. Контроллер останется в списке видимых.',
    ))
  )
    return;
  await busy(button, async () => {
    await api('gateways/' + gateway.id, {}, 'DELETE');
    if (state.selected === gateway.id) {
      state.mqttDirty = false;
      $('#overview-nav').click();
    }
    await poll();
    toast('Контроллер удалён из отслеживания');
  });
}
function renderOverview() {
  if (!state.data) return;
  const { gateways, discovery } = state.data;
  showNotice('#sidebar-installation', state.data.sidebarInstallation?.message);
  $('#page-title').textContent = state.selected
    ? gateways.find((g) => g.id === state.selected)?.name || 'Контроллер'
    : 'Контроллеры SLS';
  $('#mqtt-discovery-status').textContent = discovery.mqtt?.connected
    ? 'MQTT HA подключён'
    : discovery.mqtt?.error || 'MQTT HA: подключение…';
  $('#saved-count').textContent = gateways.length;
  $('#found-stat').textContent = discovery.devices.filter((d) => d.online).length;
  $('#connected-stat').replaceChildren(
    document.createTextNode(`${gateways.filter((g) => g.connected).length} `),
    el('em', '', `/ ${gateways.length}`),
  );
  const mqttGateways = gateways.filter((g) => g.mqtt?.enabled);
  const mqttKnown = mqttGateways.filter(
    (g) => g.monitor.connected && ['online', 'offline'].includes(g.monitor.bridgeState),
  );
  const mqttOnline = new Set([
    ...mqttKnown.filter((g) => g.monitor.bridgeState === 'online').map((g) => g.mqtt.prefix),
    ...discovery.devices.filter((d) => d.mqttPrefix && d.mqttOnline).map((d) => d.mqttPrefix),
  ]).size;
  $('#mqtt-stat').textContent = mqttOnline;
  $('#mqtt-stat-caption').textContent = mqttGateways.length
    ? 'По bridge/state · не проверено: ' + (mqttGateways.length - mqttKnown.length)
    : 'Найдены через брокер HA';
  $('#saved-caption').textContent = gateways.length
    ? `Всего: ${gateways.length}`
    : 'Нет подключённых контроллеров';
  showNotice('#discovery-error', discovery.error);
  $('#gateway-nav').replaceChildren();
  $('#gateway-cards').replaceChildren();
  for (const gateway of gateways) {
    const nav = el('button', `nav-item${gateway.id === state.selected ? ' active' : ''}`);
    nav.append(connectionDot(gateway.connected), document.createTextNode(gateway.name));
    nav.onclick = () => selectGateway(gateway.id);
    $('#gateway-nav').append(nav);
    const card = el('article', 'gateway-card');
    const title = el('button', 'gateway-open');
    title.append(connectionDot(gateway.connected), el('strong', '', gateway.name));
    if (gateway.localLink) title.append(badge('LocalLink', 'success'));
    title.onclick = () => selectGateway(gateway.id);
    const address = el('div', 'compact-field address');
    address.append(
      webLink(
        gateway.webAddress || gateway.address,
        gateway.webAddress || gateway.address ? undefined : 'MQTT',
      ),
      el('small', 'card-uptime', uptime(gateway.uptime)),
      el('small', 'card-last-data', 'Данные: ' + ago(gateway.lastDataAt)),
    );
    address.title = 'Адрес, время работы и последние данные';
    const model = field(
      gateway.info?.board || gateway.observed?.board || 'SLS',
      gateway.info?.version || gateway.observed?.version || 'Версия неизвестна',
      'card-model',
    );
    const actions = el('div', 'card-actions');
    const reboot = el('button', 'reboot-control', 'Перезагрузить');
    reboot.disabled = !gateway.rebootTransports?.length;
    reboot.setAttribute('aria-label', 'Перезагрузить ' + gateway.name);
    reboot.onclick = () => rebootGateway(gateway, reboot);
    const remove = el('button', 'remove-control', '×');
    remove.title = 'Удалить из отслеживания';
    remove.setAttribute('aria-label', 'Удалить из отслеживания ' + gateway.name);
    remove.onclick = () => forgetGateway(gateway, remove);
    actions.append(reboot);
    if (gateway.mode === 'mqtt') title.append(el('small', 'badge', 'MQTT'));
    actions.append(remove);
    card.append(title, address, model, actions);
    $('#gateway-cards').append(card);
  }
  if (!gateways.length) {
    const node = empty(
      'Подключите первый контроллер',
      'Выберите найденный SLS в списке видимых контроллеров ниже.',
    );
    $('#gateway-cards').append(node);
  }
  $('#discovered-list').replaceChildren();
  const discovered = discovery.devices
    .filter((d) => !d.trackedId)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (discovered.length) {
    const table = el('table', 'discovery-table');
    const head = el('thead');
    const heading = el('tr');
    const labels = ['Контроллер', 'Тип платы', 'IP', 'MAC', 'Прошивка', 'Аптайм', 'Источник', ''];
    for (const label of labels) heading.append(el('th', '', label));
    head.append(heading);
    const body = el('tbody');
    for (const device of discovered) {
      const row = el('tr');
      const values = [
        device.name || 'SLS',
        device.board || 'Неизвестная плата',
        device.address || '—',
        device.mac || (device.source === 'MQTT' ? '—' : device.id),
        device.version || '—',
        uptime(device.uptime),
        device.source || 'LocalLink',
      ];
      values.forEach((value, i) => {
        const cell = el('td', i >= 2 ? 'mono' : '', value);
        cell.dataset.label = labels[i];
        if (i === 2 && device.address) cell.replaceChildren(webLink('http://' + device.address));
        if (i === 0) {
          const dot = connectionDot(device.online);
          dot.title = device.online
            ? 'Есть свежие данные: ' + device.source
            : 'Нет связи или нет свежих данных';
          cell.prepend(dot);
          cell.append(
            el('small', '', (device.online ? '' : 'Нет свежих объявлений · ') + ago(device.lastSeen)),
          );
        }
        row.append(cell);
      });
      const cell = el('td', 'discovery-actions');
      const button = el('button', '', 'Добавить');
      button.onclick = () => (device.source === 'MQTT' ? trackMqtt(device, button) : openConnect(device));
      cell.append(button);
      row.append(cell);
      body.append(row);
    }
    table.append(head, body);
    $('#discovered-list').append(table);
  }
  if (!discovered.length) {
    const node = el('div', 'empty-discovery');
    node.append(
      el('span', 'orbit', '◎'),
      el(
        'div',
        '',
        discovery.devices.length ? 'Все найденные контроллеры добавлены' : 'Ожидаем объявления SLS',
      ),
      el(
        'p',
        '',
        'Оставьте приложение открытым примерно на минуту. LocalLink должен быть включён на контроллере.',
      ),
    );
    $('#discovered-list').append(node);
  }
  $('#overview-nav').classList.toggle('active', !state.selected);
}
async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    state.data = await api('state');
    showNotice('#connection-error', null);
    renderOverview();
  } catch (error) {
    showNotice('#connection-error', `Нет связи с SLS. ${error.message}`);
  } finally {
    state.polling = false;
  }
}

function openConnect(device, entry) {
  const form = $('#connect-form');
  form.reset();
  state.editId = entry?.id || null;
  state.discoveryId = device?.id || entry?.discoveryId || null;
  form.elements.name.value = entry?.name || device?.name || '';
  form.elements.address.value = entry?.address || entry?.webAddress || device?.address || '';
  $('#connect-title').textContent = entry ? 'Настройки доступа' : 'Добавить контроллер';
  $('#credentials-help').textContent = entry
    ? 'Пустые поля сохраняют текущий доступ. При смене адреса введите данные доступа повторно.'
    : 'Если авторизация на SLS отключена, оставьте данные доступа пустыми.';
  showNotice('#connect-error', null);
  $('#connect-dialog').showModal();
  form.elements.name.focus();
}
for (const selector of ['#close-dialog', '#cancel-connect'])
  $(selector).onclick = () => $('#connect-dialog').close();
$('#connect-dialog').addEventListener('close', () => {
  $('#connect-form').reset();
});
$('#connect-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('#connect-submit');
  button.disabled = true;
  showNotice('#connect-error', null);
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.discoveryId = state.discoveryId;
  try {
    const result = await api(state.editId ? `gateways/${state.editId}` : 'gateways', values);
    $('#connect-dialog').close();
    toast('Контроллер подключён');
    await poll();
    await selectGateway(result.id);
  } catch (error) {
    showNotice('#connect-error', error.message);
  } finally {
    button.disabled = false;
  }
};

async function showOverview(record = true, skipConfirm = false) {
  if (
    !skipConfirm &&
    state.mqttDirty &&
    !(await confirmAction('Покинуть настройки?', 'Несохранённые настройки MQTT будут потеряны.'))
  )
    return false;
  state.mqttDirty = false;
  state.selected = null;
  state.detail = null;
  state.switching++;
  $('#overview').hidden = false;
  $('#gateway-view').hidden = true;
  $('#page-title').textContent = 'Контроллеры SLS';
  if (record) commitRoute(null, 'devices');
  renderOverview();
  return true;
}
$('#overview-nav').onclick = () => showOverview();
$('.brand').onclick = (event) => {
  event.preventDefault();
  void showOverview();
};
async function selectGateway(id, { record = true, tab = 'devices', skipConfirm = false } = {}) {
  if (
    !skipConfirm &&
    state.mqttDirty &&
    state.selected &&
    state.selected !== id &&
    !(await confirmAction('Покинуть настройки?', 'Несохранённые настройки MQTT будут потеряны.'))
  )
    return;
  if (state.data && !state.data.gateways.some((g) => g.id === id)) {
    await showOverview(false, true);
    commitRoute(null, 'devices', true);
    return;
  }
  if (state.selected === id) {
    showTab(tab, record);
    return;
  }
  state.selected = id;
  state.detail = null;
  state.mqttDirty = false;
  state.switching++;
  $('#overview').hidden = true;
  $('#gateway-view').hidden = false;
  const entry = state.data?.gateways.find((g) => g.id === id);
  $('#page-title').textContent = entry?.name || 'Контроллер';
  $('#detail-subtitle').textContent = 'Загрузка состояния…';
  $('#devices-list').replaceChildren(empty('Загружаем устройства', 'Получаем состояние контроллера.'));
  $('#gateway-summary').replaceChildren();
  if (state.data?.gateways.find((g) => g.id === id)?.mode === 'mqtt') tab = 'devices';
  state.tab = null;
  showTab(tab, false);
  if (record) commitRoute(id, tab);
  renderOverview();
  await loadDetail(true);
}
async function loadDetail(force = false) {
  if (!state.selected) return;
  const id = state.selected;
  const switching = state.switching;
  if (state.detailBusy && !force) return;
  state.detailBusy = true;
  try {
    const data = await api(`gateways/${id}${force ? '/refresh' : ''}`, force ? {} : undefined);
    if (id !== state.selected || switching !== state.switching) return;
    state.detail = data;
    renderDetail();
  } catch (error) {
    if (id === state.selected) showNotice('#gateway-error', error.message);
  } finally {
    state.detailBusy = false;
  }
}
function renderDetail() {
  const g = state.detail;
  if (!g) return;
  $('#page-title').textContent = g.name;
  $('#detail-subtitle').textContent =
    `${g.webAddress ? new URL(g.webAddress).host : g.mqtt?.prefix || '—'} · ${g.info?.board || 'SLS'} · последнее чтение ${ago(g.lastSuccess)}`;
  const remote = g.mode === 'mqtt';
  $('.tabs').hidden = remote;
  $('#mqtt-only').hidden = !remote;
  $('#edit-gateway').textContent = remote ? 'Подключить HTTP-доступ' : 'Настройки доступа';
  document.querySelectorAll('.tab-content').forEach((node) => {
    node.hidden = remote || node.id !== 'tab-' + state.tab;
  });
  if (remote)
    $('#mqtt-only-description').textContent =
      'Префикс: ' + g.mqtt.prefix + ' · ' + (g.connected ? 'есть свежие данные' : 'нет свежих данных');
  showNotice('#gateway-error', g.error || g.detailsError || g.configError);
  showNotice(
    '#address-warning',
    g.addressChanged
      ? `LocalLink сообщил новый адрес: ${g.observed.address}. Проверьте его и обновите адрес в настройках доступа. Сохранённый токен автоматически не пересылается.`
      : null,
  );
  $('#gateway-summary').replaceChildren();
  const values = [
    ['Связь с контроллером', g.connected ? 'Подключён' : 'Нет связи'],
    ['Прошивка', g.info?.version || '—'],
    remote ? ['Аптайм', uptime(g.uptime)] : ['Zigbee-канал', g.coordinator?.coordinator?.channel ?? '—'],
    ['Свободная память', 'RAM ' + bytes(g.info?.mem_heap_free), 'PSRAM ' + bytes(g.info?.mem_psram_free)],
  ];
  for (const [label, value, extra] of values) {
    const node = el('div', 'summary-cell');
    node.append(el('span', '', label), el('strong', '', value));
    if (extra) node.append(el('small', 'memory-extra', extra));
    $('#gateway-summary').append(node);
  }
  $('.pairing').hidden = !g.info?.services?.includes('zigbee');
  if (remote) return;
  renderDevices();
  renderPairing();
  renderChecks();
  if (!state.mqttDirty && g.mqtt) {
    const form = $('#mqtt-form');
    for (const name of ['server', 'port', 'username', 'prefix', 'discoveryPrefix'])
      form.elements[name].value = g.mqtt[name];
    for (const name of ['enabled', 'discovery']) form.elements[name].checked = g.mqtt[name];
  }
}
function renderDevices() {
  const g = state.detail;
  if (!g) return;
  const filter = $('#device-search').value.toLowerCase();
  const devices = (g.devices || []).filter((d) =>
    `${d.friendly_name} ${d.ModelId} ${d.ieeeAddr}`.toLowerCase().includes(filter),
  );
  $('#devices-title').textContent = `Zigbee-устройства · ${g.devices?.length || 0}`;
  const container = $('#devices-list');
  container.replaceChildren();
  if (!devices.length)
    return container.append(
      empty(
        filter ? 'Ничего не найдено' : 'Пока нет Zigbee-устройств',
        filter
          ? 'Попробуйте другое имя или модель.'
          : g.info?.services?.includes('zigbee')
            ? 'Добавьте устройство через сопряжение. Если шлюз работает в режиме Bridge, его Zigbee API может быть недоступен.'
            : 'Этот контроллер не объявил службу Zigbee.',
      ),
    );
  const table = el('table');
  const thead = el('thead');
  const row = el('tr');
  for (const label of ['Устройство', 'Модель', 'Состояние', 'Последнее сообщение'])
    row.append(el('th', '', label));
  thead.append(row);
  const tbody = el('tbody');
  for (const d of devices) {
    const tr = el('tr');
    const name = el('td');
    name.append(
      el('strong', '', d.friendly_name || d.ieeeAddr || d.nwkAddr),
      el('small', '', d.ieeeAddr || d.nwkAddr),
    );
    const model = el('td');
    model.append(
      el('strong', '', d.ModelId || 'Не определена'),
      el('small', '', d.ManufName || d.type || ''),
    );
    const status = el('td');
    const text = Object.entries(d.st || {})
      .filter(([key]) => !['last_seen', 'trSeqNum'].includes(key))
      .slice(0, 5)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' · ');
    status.append(el('span', 'state-values', text || `Интервью: ${d.Interview?.State ?? '—'}`));
    tr.append(name, model, status, el('td', '', ago(Number(d.last_seen) * 1000)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  container.append(table);
}
$('#device-search').oninput = renderDevices;
function renderPairing() {
  if (!state.detail) return;
  const seconds = Math.max(0, Math.ceil((state.detail.joinUntil - Date.now()) / 1000));
  $('#join-button').textContent = seconds ? `Закрыть сеть · ${seconds} с` : 'Открыть сеть';
  $('#join-duration').hidden = seconds > 0;
  $('#pairing-description').textContent = seconds
    ? 'Сеть открыта. Переведите новое устройство в режим сопряжения.'
    : 'Откройте сеть, затем переведите устройство в режим сопряжения.';
}
$('#join-button').onclick = (event) =>
  busy(event.currentTarget, async () => {
    const duration = state.detail.joinUntil > Date.now() ? 0 : Number($('#join-duration').value);
    const result = await api(`gateways/${state.selected}/join`, { duration });
    state.detail.joinUntil = result.joinUntil;
    renderPairing();
    toast(duration ? 'Сеть открыта для сопряжения' : 'Сопряжение остановлено');
  });
$('#refresh-gateway').onclick = (event) => busy(event.currentTarget, () => loadDetail(true));
$('#edit-gateway').onclick = () => state.detail && openConnect(null, state.detail);
function showTab(tab, record = true) {
  if (!['devices', 'integration', 'events'].includes(tab)) tab = 'devices';
  const changed = state.tab !== tab;
  if (changed) state.eventView++;
  state.tab = tab;
  if (record && state.selected) commitRoute(state.selected, tab);
  for (const button of document.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  for (const name of ['devices', 'integration', 'events']) $(`#tab-${name}`).hidden = name !== tab;
  if (tab === 'events' && changed) {
    state.events = [];
    $('#events-cache-status').textContent = 'Загрузка кэша лога…';
    $('#events-status').textContent = 'Открываем лог…';
    showNotice('#events-error', null);
    renderEvents();
    void loadEvents(true);
  }
}
for (const button of document.querySelectorAll('[data-tab]'))
  button.onclick = () => showTab(button.dataset.tab);
function renderChecks() {
  const g = state.detail;
  if (!g) return;
  $('#mqtt-checks').replaceChildren();
  const monitor = g.monitor;
  const rows = [
    [
      g.mqtt?.enabled ? 'Включён' : 'Выключен',
      g.mqtt?.enabled ? 'success' : 'warning',
      'MQTT на SLS',
      g.mqtt?.server ? `${g.mqtt.server}:${g.mqtt.port}` : 'Брокер не указан',
    ],
    [
      g.mqtt?.discovery ? 'Включено' : 'Выключено',
      g.mqtt?.discovery ? 'success' : 'warning',
      'Автодобавление в HA',
      `Префикс: ${g.mqtt?.discoveryPrefix || 'homeassistant'}`,
    ],
    [
      monitor.connected ? 'Подключён' : g.monitoring ? 'Нет связи' : 'Не проверен',
      monitor.connected ? 'success' : 'warning',
      'Менеджер → брокер',
      monitor.error ||
        (g.monitoring
          ? `Живое сообщение: ${ago(monitor.lastMessage)}`
          : 'Включите диагностику для проверки брокера'),
    ],
    [
      `Discovery: ${monitor.connected ? monitor.discoveryCount : '—'}`,
      monitor.discoveryCount ? 'success' : '',
      'Объявления шлюза',
      `Состояние bridge: ${monitor.bridgeState ?? 'не получено'}${monitor.bridgeStateRetained ? ' (сохранённое)' : ''}`,
    ],
  ];
  for (const [value, mode, title, description] of rows) {
    const node = el('div', 'check');
    node.append(badge(value, mode), el('h3', '', title), el('p', '', description));
    $('#mqtt-checks').append(node);
  }
  $('#monitor-button').textContent = g.monitoring ? 'Остановить диагностику' : 'Включить диагностику';
}
$('#monitor-button').onclick = (event) =>
  busy(event.currentTarget, async () => {
    await api(`gateways/${state.selected}/monitor`, { enabled: !state.detail.monitoring });
    await loadDetail();
    toast('Настройки диагностики сохранены');
  });
$('#mqtt-form').oninput = () => (state.mqttDirty = true);
$('#mqtt-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (
    !(await confirmAction(
      'Сохранить настройки в SLS?',
      'Изменения будут записаны в контроллер. Может потребоваться его перезагрузка.',
    ))
  )
    return;
  await busy(form.querySelector('[type=submit]'), async () => {
    const values = Object.fromEntries(new FormData(form));
    values.port = Number(values.port);
    for (const name of ['enabled', 'discovery', 'clearPassword']) values[name] = form.elements[name].checked;
    const result = await api(`gateways/${state.selected}/mqtt`, values);
    state.mqttDirty = false;
    form.elements.password.value = '';
    form.elements.clearPassword.checked = false;
    $('#mqtt-result').textContent = result.needReboot
      ? 'Сохранено. Перезагрузите SLS для применения.'
      : 'Настройки сохранены.';
    await loadDetail();
    toast('Настройки MQTT записаны в SLS');
  });
};
async function rebootGateway(gateway, button) {
  if (!gateway) return;
  if (
    await confirmAction(
      'Перезагрузить ' + gateway.name + '?',
      'Связь с SLS и его устройствами временно прервётся.',
      gateway.rebootTransports || [],
    )
  )
    await busy(button, async () => {
      const result = await api('gateways/' + gateway.id + '/reboot', {
        transport: $('#reboot-transport').value || 'auto',
      });
      toast('Команда перезагрузки отправлена через ' + result.transport.toUpperCase());
    });
}
$('#reboot-button').onclick = (event) => rebootGateway(state.detail, event.currentTarget);
$('#forget-button').onclick = (event) => forgetGateway(state.detail, event.currentTarget);
$('#clear-log').onclick = async (event) => {
  const id = state.selected;
  const switching = state.switching;
  // Invalidate an in-flight snapshot so it cannot put cleared lines back.
  state.eventView++;
  await busy(event.currentTarget, async () => {
    const result = await api('gateways/' + id + '/events', {}, 'DELETE');
    if (state.selected !== id || state.switching !== switching) return;
    state.events = result.events;
    $('#events-status').textContent = 'Лог очищен · ожидание новых строк через 80/ws';
    renderEvents();
    toast('Лог очищен. Новые строки продолжат поступать.');
  });
};
async function loadEvents(open = false) {
  if (!state.selected || state.tab !== 'events' || (state.eventBusy && !open)) return;
  const request = {};
  state.eventBusy = request;
  const id = state.selected;
  const view = state.eventView;
  const switching = state.switching;
  const current = () =>
    id === state.selected &&
    state.tab === 'events' &&
    view === state.eventView &&
    switching === state.switching;
  try {
    const result = await api(`gateways/${id}/events`, open ? {} : undefined);
    if (!current()) return;
    state.events = result.events;
    $('#events-cache-status').textContent =
      result.cacheStatus === 'ready'
        ? 'Кэш лога загружен при открытии'
        : result.cacheStatus === 'loading'
          ? 'Загрузка кэша лога…'
          : result.cacheStatus === 'error'
            ? 'Кэш лога недоступен'
            : 'Кэш ещё не загружен';
    showNotice('#events-error', [result.error, result.cacheError].filter(Boolean).join(' '));
    $('#events-status').textContent =
      {
        idle: 'Ожидание подключения',
        connecting: 'Подключение…',
        ws: result.lastMessage
          ? '80/ws · строк: ' + result.liveCount + ' · последняя ' + ago(result.lastMessage)
          : '80/ws подключён, строки лога ещё не получены',
        error: 'Ошибка подключения. Проверьте доступ к WebSocket.',
        reconnecting: 'Восстанавливаем соединение…',
      }[result.status] || result.status;
    renderEvents();
  } catch (error) {
    if (current()) $('#events-status').textContent = error.message;
  } finally {
    if (state.eventBusy === request) state.eventBusy = null;
  }
}
function renderEvents() {
  const container = $('#events-list');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  const scrollLeft = container.scrollLeft;
  const filter = $('#event-search').value.toLowerCase();
  const events = state.events.filter((e) => e.category === 'log' && e.message.toLowerCase().includes(filter));
  const renderedIds = events.map((event) => event.id).join(',');
  if (container.dataset.renderedIds === renderedIds) return;
  container.dataset.renderedIds = renderedIds;
  container.replaceChildren();
  for (const event of events) {
    const row = el('div', 'event-line');
    row.append(
      el('time', '', window.slsLogTime(event)),
      el('span', 'event-category', event.source === 'cache' ? 'кэш' : event.category),
      el('span', 'event-message', event.message.replace(/\r\n?|\n/g, ' ↵ ')),
    );
    container.append(row);
  }
  if (!events.length) container.append(el('p', 'muted', 'Ожидание новых сообщений лога…'));
  if (atBottom) container.scrollTop = container.scrollHeight;
  container.scrollLeft = scrollLeft;
}
$('#event-search').oninput = renderEvents;
function readRoute() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get('controller');
  const tab = params.get('tab') || 'devices';
  return {
    id: id && /^[a-zA-Z0-9-]+$/.test(id) ? id : null,
    tab: ['devices', 'integration', 'events'].includes(tab) ? tab : 'devices',
  };
}
let routeIndex = Number.isInteger(history.state?.slsIndex) ? history.state.slsIndex : 0;
let restoringRoute = false;
let routeGeneration = 0;
function commitRoute(id, tab, replace = false) {
  const url = new URL(location.href);
  const params = new URLSearchParams();
  if (id) {
    params.set('controller', id);
    params.set('tab', tab);
  }
  url.hash = params.toString();
  if (!replace && url.href === location.href) return;
  if (!replace) routeIndex++;
  history[replace ? 'replaceState' : 'pushState']({ ...history.state, slsIndex: routeIndex }, '', url);
}
window.addEventListener('popstate', async (event) => {
  if (restoringRoute) {
    restoringRoute = false;
    return;
  }
  const generation = ++routeGeneration;
  const route = readRoute();
  const nextIndex = Number.isInteger(event.state?.slsIndex) ? event.state.slsIndex : 0;
  if (state.mqttDirty && route.id !== state.selected) {
    const leave = await confirmAction('Покинуть настройки?', 'Несохранённые настройки MQTT будут потеряны.');
    if (generation !== routeGeneration) return;
    if (!leave) {
      const delta = routeIndex - nextIndex;
      if (delta) {
        restoringRoute = true;
        history.go(delta);
      } else commitRoute(state.selected, state.tab, true);
      return;
    }
  }
  routeIndex = nextIndex;
  if (route.id) await selectGateway(route.id, { tab: route.tab, record: false, skipConfirm: true });
  else await showOverview(false, true);
});
async function startPage() {
  await poll();
  const route = readRoute();
  commitRoute(route.id, route.tab, true);
  if (route.id) await selectGateway(route.id, { tab: route.tab, record: false, skipConfirm: true });
}
void startPage();
setInterval(() => {
  if (!document.hidden) void poll();
}, 10000);
setInterval(() => {
  if (!document.hidden && state.selected) void loadDetail();
}, 15000);
setInterval(() => {
  if (!document.hidden) void loadEvents();
}, 4000);
setInterval(renderPairing, 1000);
window.addEventListener('beforeunload', (event) => {
  if (state.mqttDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
