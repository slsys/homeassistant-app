'use strict';
window.slsUdp = (() => {
  let app,
    selected,
    snapshot,
    inspection,
    busyLoad,
    paused = false,
    cleared = 0,
    file = null,
    fileText = '',
    generation = 0,
    senderBusy = false;
  let frozenLines = [];
  const $ = (selector) => document.querySelector(selector);
  const size = (value) =>
    (value / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' МиБ';
  const fileCount = (value) =>
    `${value} ${value % 100 >= 11 && value % 100 <= 14 ? 'файлов' : value % 10 === 1 ? 'файл' : value % 10 >= 2 && value % 10 <= 4 ? 'файла' : 'файлов'}`;
  const time = (value) => (value ? new Date(value).toLocaleString('ru-RU') : '—');
  function node(tag, text, className = '') {
    const result = document.createElement(tag);
    result.textContent = text;
    result.className = className;
    return result;
  }
  function endpoint(suffix = '') {
    return 'gateways/' + selected + '/udp' + suffix;
  }
  function current(id, revision) {
    return selected === id && generation === revision && app.state.selected === id;
  }
  function showError(text) {
    $('#udp-error').textContent = text || '';
    $('#udp-error').hidden = !text;
  }
  async function action(button, task) {
    button.disabled = true;
    try {
      await task();
    } catch (error) {
      app.toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
  function fields() {
    const form = $('#udp-config');
    return {
      enabled: form.elements.enabled.checked,
      source: form.elements.source.value.trim(),
      host: form.elements.host.value.trim(),
      port: Number(form.elements.port.value),
      sizeMiB: Number(form.elements.sizeMiB.value),
      count: Number(form.elements.count.value),
    };
  }
  function renderSettings() {
    if (!snapshot) return;
    if (!app.state.udpDirty) {
      const form = $('#udp-config');
      for (const key of ['source', 'host', 'port', 'sizeMiB', 'count'])
        form.elements[key].value = snapshot.config[key];
      form.elements.enabled.checked = snapshot.config.enabled;
    }
    $('#udp-limit').textContent =
      `Сохранено: ${fileCount(snapshot.files.length)} · ${size(snapshot.totalBytes)}. Предел: ${size(fields().sizeMiB * fields().count * 1048576)}.`;
    $('#udp-status').textContent = !snapshot.config.enabled
      ? 'Запись выключена'
      : !snapshot.listening
        ? 'Приёмник недоступен'
        : snapshot.lastReceived
          ? 'Приёмник работает · последняя строка ' + time(snapshot.lastReceived)
          : 'Приёмник работает · ожидаем сообщения';
    $('#udp-write-status').textContent = snapshot.lastWritten
      ? 'Записано: ' + time(snapshot.lastWritten)
      : 'Записанных сообщений в этой сессии пока нет';
    $('#udp-sender-status').textContent = snapshot.sender
      ? `${snapshot.sender.message} · ${time(snapshot.sender.at)}`
      : 'Текущее состояние отправки не проверено';
    $('#udp-http-note').hidden = snapshot.httpAvailable;
    for (const button of document.querySelectorAll('[data-sender]'))
      button.disabled = !snapshot.httpAvailable || senderBusy;
    showError(
      [snapshot.error, snapshot.dropped ? `Не записано пакетов: ${snapshot.dropped}` : '']
        .filter(Boolean)
        .join('. '),
    );
  }
  function renderFiles() {
    if (!snapshot) return;
    const body = $('#udp-files-body'),
      oldTop = $('#log-files-panel').scrollTop;
    body.replaceChildren();
    $('#udp-files-summary').textContent =
      `${fileCount(snapshot.files.length)} · ${size(snapshot.totalBytes)}`;
    for (const entry of snapshot.files) {
      const row = document.createElement('tr'),
        title = document.createElement('td'),
        controls = document.createElement('td');
      const view = node('button', entry.name, 'link-button udp-filename');
      view.onclick = () =>
        action(view, async () => {
          const id = selected,
            revision = generation;
          const result = await app.api(endpoint('/file?name=' + encodeURIComponent(entry.name)));
          if (!current(id, revision)) return;
          file = entry;
          fileText = result.text;
          $('#udp-preview-note').textContent = result.truncated
            ? 'Показан конец файла, до 256 КиБ. Полный файл доступен для скачивания.'
            : 'Просмотр сохранённого файла';
          changeView('udp');
        });
      title.append(view);
      const download = node('a', 'Скачать');
      download.href = new URL(
        'api/' + endpoint('/file?download=1&name=' + encodeURIComponent(entry.name)),
        app.apiBase,
      ).href;
      download.download = entry.name;
      const remove = node('button', 'Удалить', 'danger-text');
      remove.disabled = entry.active;
      remove.onclick = () =>
        action(remove, async () => {
          const id = selected;
          if (
            !(await app.confirm('Удалить файл?', entry.name + ' будет удалён без восстановления.'))
          )
            return;
          await app.api('gateways/' + id + '/udp/file', { name: entry.name }, 'DELETE');
          await refresh();
        });
      controls.append(download, document.createTextNode(' '), remove);
      row.append(
        title,
        node('td', time(entry.start) + ' — ' + time(entry.end)),
        node('td', size(entry.size)),
        node('td', entry.active ? 'Записывается' : 'Завершён'),
        controls,
      );
      body.append(row);
    }
    if (!snapshot.files.length) {
      const row = document.createElement('tr'),
        cell = node('td', 'Файлов лога пока нет');
      cell.colSpan = 5;
      row.append(cell);
      body.append(row);
    }
    $('#log-files-panel').scrollTop = oldTop;
  }
  function renderLines() {
    if (!snapshot) return;
    const container = $('#udp-lines'),
      filter = $('#udp-search').value.toLowerCase();
    const bottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    const top = container.scrollTop,
      left = container.scrollLeft;
    const rows = file
      ? fileText.split(/\r?\n/)
      : (paused ? frozenLines : snapshot.lines)
          .filter((line) => line.id > cleared)
          .map((line) => line.text);
    const visible = rows.filter((text) => text.toLowerCase().includes(filter));
    container.replaceChildren(...visible.map((text) => node('div', text, 'udp-line')));
    if (!visible.length) container.append(node('p', 'Нет строк для отображения', 'muted'));
    container.scrollTop = bottom ? container.scrollHeight : top;
    container.scrollLeft = left;
    $('#udp-view-title').textContent = file ? file.name : 'UDP-лог · последние 500 сообщений';
    $('#udp-live').hidden = !file;
    $('#udp-pause').hidden = Boolean(file);
    $('#udp-clear').disabled = Boolean(file);
    if (!file)
      $('#udp-preview-note').textContent = 'Пауза и очистка экрана не останавливают запись в файл.';
  }
  async function refresh() {
    if (!selected || app.state.tab !== 'events' || busyLoad) return;
    const request = {},
      id = selected,
      revision = generation;
    busyLoad = request;
    try {
      const result = await app.api(endpoint());
      if (!current(id, revision)) return;
      if (snapshot && snapshot.sessionId !== result.sessionId) {
        cleared = 0;
        frozenLines = [];
      }
      snapshot = result;
      app.preserveScroll(() => {
        renderSettings();
        renderFiles();
        renderLines();
      });
    } catch (error) {
      if (current(id, revision)) showError(error.message);
    } finally {
      if (busyLoad === request) busyLoad = null;
    }
  }
  function inspectionView(result) {
    inspection = result;
    const container = $('#udp-init-result');
    container.replaceChildren();
    container.append(
      node(
        'p',
        result.exists ? 'init.lua проверен · ' + time(result.checkedAt) : 'init.lua отсутствует',
      ),
    );
    for (const call of result.calls)
      container.append(node('pre', `Строка ${call.line}: ${call.text}`, 'udp-code'));
    if (!result.calls.length) container.append(node('p', 'Прямые вызовы UDP-лога не найдены.'));
    if (!result.safe) container.append(node('p', result.reason, 'notice warning'));
  }
  async function sender(button, mode) {
    const id = selected,
      revision = generation;
    if (mode === 'inspect') {
      const result = await app.api(endpoint('/sender'), { action: 'inspect' });
      if (current(id, revision)) inspectionView(result);
      return;
    }
    const enabled = mode === 'enable',
      config = fields();
    const persistent = $('#udp-persistent').checked;
    if (enabled && app.state.udpDirty)
      throw new Error(
        'Сначала сохраните настройки записи, чтобы адрес и порт приёмника совпадали с настройкой отправки.',
      );
    const plan = await app.api(endpoint('/sender'), {
      action: 'preview',
      enabled,
      persistent,
      host: config.host,
      port: config.port,
    });
    if (!current(id, revision)) return;
    const dialog = $('#udp-plan');
    $('#udp-plan-title').textContent = plan.message;
    $('#udp-plan-command').textContent = plan.command;
    $('#udp-plan-diff').hidden = !plan.persistent;
    $('#udp-plan-before').textContent = plan.before || '(пусто)';
    $('#udp-plan-after').textContent = plan.after || '(пусто)';
    $('#udp-plan-backup').textContent = plan.changed
      ? 'Будет сохранена резервная копия. Остальное содержимое init.lua сохраняется.'
      : 'init.lua не изменяется.';
    dialog.returnValue = '';
    const accepted = new Promise((resolve) =>
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }),
    );
    dialog.showModal();
    if (!(await accepted) || !current(id, revision)) return;
    const result = await app.api(endpoint('/sender'), { action: 'apply', token: plan.token });
    if (!current(id, revision)) return;
    $('#udp-init-result').replaceChildren();
    inspection = null;
    app.toast(result.message);
    await refresh();
  }
  function changeView(view, record = true) {
    if (!['ws', 'udp', 'files', 'settings'].includes(view)) view = 'ws';
    const remote = app.state.data?.gateways.find((entry) => entry.id === selected)?.mode === 'mqtt';
    if (remote && view === 'ws') view = 'udp';
    const changed = app.state.logView !== view;
    app.state.logView = view;
    for (const button of document.querySelectorAll('[data-log-view]')) {
      button.setAttribute('aria-selected', String(button.dataset.logView === view));
      button.disabled = remote && button.dataset.logView === 'ws';
    }
    for (const name of ['ws', 'udp', 'files', 'settings'])
      $('#log-' + name + '-panel').hidden = name !== view;
    if (changed) app.state.eventView++;
    if (record) app.route(selected, 'events');
    if (view === 'ws' && changed) app.openWs();
    renderLines();
    void refresh();
  }
  function activate() {
    if (app.state.selected !== selected) {
      selected = app.state.selected;
      generation++;
      snapshot = null;
      inspection = null;
      busyLoad = null;
      paused = false;
      cleared = 0;
      file = null;
      fileText = '';
      $('#udp-pause').textContent = 'Пауза';
      $('#udp-search').value = '';
      $('#udp-init-result').replaceChildren();
      $('#udp-lines').replaceChildren();
      $('#udp-files-body').replaceChildren();
      $('#udp-config').reset();
      showError(null);
      $('#udp-status').textContent = 'Загрузка…';
      $('#udp-write-status').textContent = '';
      $('#udp-sender-status').textContent = '';
      $('#udp-limit').textContent = '';
      for (const button of document.querySelectorAll('[data-sender]')) button.disabled = true;
    }
    changeView(app.state.logView || 'ws', false);
  }
  function init(context) {
    app = context;
    $('#udp-workspace').innerHTML = `
      <div id="udp-error" class="notice danger" role="alert" hidden></div>
      <section id="log-udp-panel" class="panel" role="tabpanel" aria-labelledby="log-udp-tab" hidden>
        <div class="section-title"><h2 id="udp-view-title">UDP-лог</h2><input id="udp-search" type="search" aria-label="Фильтр UDP-лога" placeholder="Фильтр лога…"><button id="udp-live" hidden>К текущему логу</button><button id="udp-pause">Пауза</button><button id="udp-clear">Очистить экран</button></div>
        <div id="udp-lines" class="events udp-lines"></div><div id="udp-preview-note" class="panel-foot"></div>
      </section>
      <section id="log-files-panel" class="panel" role="tabpanel" aria-labelledby="log-files-tab" hidden>
        <div class="section-title"><h2>Файлы лога</h2><span id="udp-files-summary"></span></div>
        <div class="table-wrap"><table><thead><tr><th>Файл</th><th>Период записи</th><th>Размер</th><th>Состояние</th><th></th></tr></thead><tbody id="udp-files-body"></tbody></table></div>
      </section>
      <section id="log-settings-panel" class="panel" role="tabpanel" aria-labelledby="log-settings-tab" hidden>
        <form id="udp-config">
          <div class="section-title"><h2>Фоновая запись UDP</h2><label class="udp-check"><input type="checkbox" name="enabled">Включена</label></div>
          <p id="udp-status" role="status"></p><p id="udp-write-status" class="small muted"></p>
          <div class="form-grid"><label>IPv4 контроллера<input name="source" required maxlength="15" autocomplete="off"></label><label>UDP-порт приёма<input name="port" type="number" min="1" max="65535" value="5514" required></label></div>
          <h3>Файлы лога</h3><div class="form-grid"><label>Размер файла, МиБ<input name="sizeMiB" type="number" min="1" max="1024" value="10" required></label><label>Количество файлов<input name="count" type="number" min="1" max="1000" value="20" required></label></div>
          <p id="udp-limit" class="small muted"></p>
          <h3>Отправка с контроллера</h3><label>IPv4 получателя (HA)<input name="host" maxlength="15" autocomplete="off"></label>
          <p id="udp-sender-status" class="small muted"></p><p id="udp-http-note" class="notice" hidden>Для настройки отправки подключите HTTP-доступ к контроллеру. Уже настроенный UDP-лог принимается без HTTP.</p>
          <label class="udp-check"><input type="checkbox" id="udp-persistent" checked>Также изменить автозапуск в init.lua</label>
          <div class="udp-actions"><button type="button" data-sender="inspect">Проверить init.lua</button><button type="button" data-sender="enable">Настроить и включить</button><button type="button" data-sender="disable">Выключить отправку</button></div>
          <div id="udp-init-result"></div>
          <p class="small muted">Запись работает при закрытой странице. При удалении контроллера удаляется весь его архив.</p>
          <div class="form-footer"><span id="udp-save-status" class="small muted"></span><button type="submit" class="primary">Сохранить настройки записи</button></div>
        </form>
      </section>`;
    const dialog = document.createElement('dialog');
    dialog.id = 'udp-plan';
    dialog.innerHTML = `<form method="dialog"><h2 id="udp-plan-title"></h2><pre id="udp-plan-command" class="udp-code"></pre><p id="udp-plan-backup"></p><div id="udp-plan-diff"><h3>Сейчас</h3><pre id="udp-plan-before" class="udp-code"></pre><h3>После изменения</h3><pre id="udp-plan-after" class="udp-code"></pre></div><div class="form-footer"><button value="cancel">Отмена</button><button value="ok" class="primary">Применить на контроллере</button></div></form>`;
    document.body.append(dialog);
    for (const button of document.querySelectorAll('[data-log-view]'))
      button.onclick = () => changeView(button.dataset.logView);
    for (const button of document.querySelectorAll('[data-sender]'))
      button.onclick = () =>
        action(button, async () => {
          senderBusy = true;
          renderSettings();
          try {
            await sender(button, button.dataset.sender);
          } finally {
            senderBusy = false;
            renderSettings();
          }
        });
    $('#udp-config').oninput = () => {
      app.state.udpDirty = true;
      $('#udp-save-status').textContent = 'Есть несохранённые изменения';
      renderSettings();
    };
    $('#udp-config').onsubmit = (event) => {
      event.preventDefault();
      const id = selected,
        revision = generation;
      void action(event.currentTarget.querySelector('[type=submit]'), async () => {
        const config = fields();
        if (
          snapshot &&
          config.count < snapshot.files.length &&
          !(await app.confirm(
            'Уменьшить архив?',
            'Старые файлы сверх нового предела будут удалены.',
          ))
        )
          return;
        const result = await app.api('gateways/' + id + '/udp', config);
        if (!current(id, revision)) return;
        snapshot = result;
        app.state.udpDirty = false;
        $('#udp-save-status').textContent = 'Сохранено';
        renderSettings();
        renderFiles();
      });
    };
    $('#udp-search').oninput = renderLines;
    $('#udp-pause').onclick = () => {
      paused = !paused;
      if (paused) frozenLines = [...(snapshot?.lines || [])];
      $('#udp-pause').textContent = paused ? 'Продолжить' : 'Пауза';
      renderLines();
    };
    $('#udp-clear').onclick = () => {
      cleared = snapshot?.sequence || 0;
      $('#udp-lines').replaceChildren();
      renderLines();
    };
    $('#udp-live').onclick = () => {
      file = null;
      paused = false;
      $('#udp-pause').textContent = 'Пауза';
      renderLines();
    };
    setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
  }
  return { init, activate, refresh };
})();
