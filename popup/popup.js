// VK7TV — попап: управление наборами и просмотр всех активных эмоутов.

const $ = (sel) => document.querySelector(sel);

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1500);
}

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function getState() {
  const sync = await chrome.storage.sync.get({
    enabled: true,
    useGlobal: true,
    widget: true,
    sets: [],
    customEmotes: {},
  });
  const local = await chrome.storage.local.get({ setEmotes: {}, globalEmotes: null });
  return { sync, local };
}

// значение эмоута: {u: url, z: zero-width}; старый кэш и «свои» — просто строка
const normEmote = (v) => (typeof v === 'string' ? { u: v, z: 0 } : v);

function activeEmotes({ sync, local }) {
  const map = new Map();
  if (sync.useGlobal) {
    const g =
      local.globalEmotes && Object.keys(local.globalEmotes).length
        ? local.globalEmotes
        : DEFAULT_EMOTES;
    for (const [n, v] of Object.entries(g)) map.set(n, normEmote(v));
  }
  for (const s of sync.sets) {
    const m = local.setEmotes[s.id];
    if (m) for (const [n, v] of Object.entries(m)) map.set(n, normEmote(v));
  }
  for (const [n, v] of Object.entries(sync.customEmotes)) map.set(n, normEmote(v));
  return map;
}

async function render() {
  const state = await getState();
  const { sync } = state;

  $('#enabled').checked = sync.enabled;
  $('#useGlobal').checked = sync.useGlobal;
  $('#widgetOn').checked = sync.widget;
  $('#globalCount').textContent = `(${Object.keys(DEFAULT_EMOTES).length})`;

  const setList = $('#setList');
  setList.innerHTML = '';
  for (const s of sync.sets) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    name.title = s.id;
    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent = s.count;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Удалить набор';
    del.addEventListener('click', async () => {
      await sendMessage({ type: 'remove-set', id: s.id });
      render();
    });
    li.append(name, count, del);
    setList.appendChild(li);
  }

  const customList = $('#customList');
  customList.innerHTML = '';
  for (const [n, u] of Object.entries(sync.customEmotes)) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = u;
    img.alt = n;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = n;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      const { customEmotes } = await chrome.storage.sync.get({ customEmotes: {} });
      delete customEmotes[n];
      await chrome.storage.sync.set({ customEmotes });
      render();
    });
    li.append(img, name, del);
    customList.appendChild(li);
  }

  renderGrid(activeEmotes(state));
}

let gridEmotes = new Map();
function renderGrid(map) {
  gridEmotes = map;
  const query = $('#search').value.trim().toLowerCase();
  const grid = $('#grid');
  grid.innerHTML = '';
  let shown = 0;
  for (const [name, v] of map) {
    if (query && !name.toLowerCase().includes(query)) continue;
    const img = document.createElement('img');
    img.src = v.u;
    img.alt = name;
    img.title = name;
    img.loading = 'lazy';
    img.addEventListener('click', () => {
      navigator.clipboard.writeText(name);
      toast(`«${name}» скопировано`);
    });
    grid.appendChild(img);
    shown++;
  }
  $('#totalCount').textContent = query ? `(${shown} из ${map.size})` : `(${map.size})`;
}

$('#enabled').addEventListener('change', (e) => {
  chrome.storage.sync.set({ enabled: e.target.checked });
});

$('#useGlobal').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ useGlobal: e.target.checked });
  render();
});

$('#widgetOn').addEventListener('change', (e) => {
  chrome.storage.sync.set({ widget: e.target.checked });
});

$('#addSet').addEventListener('click', async () => {
  const input = $('#setInput').value.trim();
  if (!input) return;
  const status = $('#setStatus');
  status.classList.remove('error');
  status.textContent = 'Загружаю…';
  const resp = await sendMessage({ type: 'add-set', input });
  if (resp && resp.error) {
    status.classList.add('error');
    status.textContent = resp.error;
    return;
  }
  status.textContent = `Добавлен «${resp.name}» — ${resp.count} эмоутов`;
  $('#setInput').value = '';
  render();
});

$('#refreshSets').addEventListener('click', async () => {
  const status = $('#setStatus');
  status.classList.remove('error');
  status.textContent = 'Обновляю…';
  await sendMessage({ type: 'refresh-sets' });
  status.textContent = 'Наборы обновлены';
  render();
});

$('#addCustom').addEventListener('click', async () => {
  const name = $('#customName').value.trim();
  const url = $('#customUrl').value.trim();
  const status = $('#customStatus');
  status.classList.remove('error');
  status.textContent = '';
  if (!name || /\s/.test(name)) {
    status.classList.add('error');
    status.textContent = 'Имя — одно слово без пробелов';
    return;
  }
  if (!/^https?:\/\//.test(url)) {
    status.classList.add('error');
    status.textContent = 'Ссылка должна начинаться с http(s)://';
    return;
  }
  const { customEmotes } = await chrome.storage.sync.get({ customEmotes: {} });
  customEmotes[name] = url;
  await chrome.storage.sync.set({ customEmotes });
  $('#customName').value = '';
  $('#customUrl').value = '';
  render();
});

$('#search').addEventListener('input', () => renderGrid(gridEmotes));

render();
