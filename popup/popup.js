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
    suggest: true,
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
  // эмоуты набора показываем под полным именем — с постфиксом набора,
  // ровно в таком виде их вставляет пикер на странице
  for (const s of sync.sets) {
    const m = local.setEmotes[s.id];
    if (!m) continue;
    for (const [n, v] of Object.entries(m)) {
      map.set(s.slug ? `${n}_${s.slug}` : n, normEmote(v));
    }
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
  $('#suggestOn').checked = sync.suggest;
  $('#globalCount').textContent = `(${Object.keys(DEFAULT_EMOTES).length})`;

  const setList = $('#setList');
  setList.innerHTML = '';
  for (const s of sync.sets) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    name.title = s.id;
    // постфикс, который приписывается к именам эмоутов этого набора
    const slug = document.createElement('span');
    slug.className = 'muted';
    slug.textContent = s.slug ? '_' + s.slug : '';
    slug.title = 'Постфикс: эмоуты набора работают и как имя_постфикс';
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
    li.append(name, slug, count, del);
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

$('#suggestOn').addEventListener('change', (e) => {
  chrome.storage.sync.set({ suggest: e.target.checked });
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
  // по кнопке — принудительно, иначе сеть не трогается и кэш остаётся как есть
  await sendMessage({ type: 'refresh-sets', force: true });
  status.textContent = 'Наборы обновлены';
  render();
});

// --- резервная копия настроек ---
// Браузер стирает хранилище расширения при удалении, поэтому наборы
// и свои эмоуты можно выгрузить в файл и вернуть после переустановки.
// Эмоуты наборов в файл не кладём — они качаются из API по id набора.

const BACKUP_DEFAULTS = {
  enabled: true,
  useGlobal: true,
  widget: true,
  suggest: true,
  sets: [],
  customEmotes: {},
  favorites: [],
};

$('#exportSettings').addEventListener('click', async () => {
  const sync = await chrome.storage.sync.get(BACKUP_DEFAULTS);
  const data = { app: 'vk7tv', version: chrome.runtime.getManifest().version, ...sync };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vk7tv-backup.json';
  document.body.appendChild(a); // Chrome не скачивает по клику вне документа
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  $('#backupStatus').classList.remove('error');
  $('#backupStatus').textContent =
    `Сохранено: наборов ${sync.sets.length}, своих эмоутов ${Object.keys(sync.customEmotes).length}` +
    `, избранных ${sync.favorites.length}`;
});

$('#importSettings').addEventListener('click', () => $('#importFile').click());

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const status = $('#backupStatus');
  status.classList.remove('error');
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'vk7tv' || !Array.isArray(data.sets)) {
      throw new Error('Это не файл настроек VK7TV');
    }
    const cur = await chrome.storage.sync.get({ sets: [], customEmotes: {}, favorites: [] });
    const sets = data.sets.filter((s) => s && s.id);
    const merged = cur.sets.filter((s) => !sets.some((x) => x.id === s.id)).concat(sets);
    const favorites = Array.isArray(data.favorites) ? data.favorites : [];
    await chrome.storage.sync.set({
      enabled: data.enabled !== false,
      useGlobal: data.useGlobal !== false,
      widget: data.widget !== false,
      suggest: data.suggest !== false,
      sets: merged,
      customEmotes: { ...cur.customEmotes, ...(data.customEmotes || {}) },
      favorites: [...new Set([...cur.favorites, ...favorites])],
      // набор по умолчанию не должен вернуться поверх восстановленного списка
      seeded: true,
    });
    status.textContent = `Восстановлено наборов: ${merged.length}. Качаю эмоуты…`;
    render();
    const resp = await sendMessage({ type: 'refresh-sets' });
    if (resp && resp.error) throw new Error(resp.error);
    status.textContent = 'Готово, эмоуты загружены';
    render();
  } catch (err) {
    status.classList.add('error');
    status.textContent = String((err && err.message) || err);
  }
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
