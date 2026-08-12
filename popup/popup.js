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

// Настройки, разделы и правила коллизий читает emotes.js — тот же самый
// код, что работает в чате и в поповере. Иначе список «Все эмоуты»
// расходился бы с тем, что реально рендерится на странице.
const normEmote = VK7TV.normEmote;
const usable = VK7TV.usable;

async function render() {
  const { settings: sync, groups, missing } = await VK7TV.load();

  $('#enabled').checked = sync.enabled;
  $('#useGlobal').checked = sync.useGlobal;
  $('#widgetOn').checked = sync.widget;
  $('#suggestOn').checked = sync.suggest;
  $('#everywhere').checked = sync.everywhere;
  $('#globalCount').textContent = `(${Object.keys(DEFAULT_EMOTES).length})`;

  const setList = $('#setList');
  setList.innerHTML = '';
  for (const s of sync.sets) {
    const li = document.createElement('li');
    // Порядок наборов — это и порядок разделов в пикере, и приоритет:
    // при коллизии кодов голое имя достаётся набору выше по списку.
    // Строку можно перетащить, поэтому у неё есть id набора.
    li.draggable = true;
    li.dataset.setId = s.id;
    li.title = 'Перетащи, чтобы поменять наборы местами';
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
  for (const [n, v] of Object.entries(sync.customEmotes)) {
    const em = normEmote(v);
    if (!usable(em)) continue;
    const li = document.createElement('li');
    // Полное имя с id — то, что уезжает в сообщение и работает у собеседника.
    // В ячейку сетки такая строка не влезает, поэтому живёт в подсказке;
    // эмоут не с 7TV помечен пунктиром (класс local).
    li.title = em.id
      ? `Полное имя: ${n}_${em.id} — по нему эмоут увидит собеседник с расширением`
      : `${n} — картинка не с 7TV: у собеседника останется текстом`;
    if (!em.id) li.className = 'local';
    const img = document.createElement('img');
    img.src = em.u;
    img.alt = n;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = n;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Удалить эмоут';
    del.addEventListener('click', async () => {
      const { customEmotes } = await chrome.storage.sync.get({ customEmotes: {} });
      delete customEmotes[n];
      await chrome.storage.sync.set({ customEmotes });
      render();
    });
    li.append(img, name, del);
    customList.appendChild(li);
  }

  // Наборы, у которых нет эмоутов, — отдельная строка: без неё непонятно,
  // почему набор в списке есть, а в сетке его эмоутов нет.
  const note = $('#gridNote');
  note.textContent = missing
    ? `Наборов без эмоутов: ${missing} — нажми «↻ Обновить наборы»`
    : '';
  note.style.display = missing ? '' : 'none';

  renderGrid(VK7TV.flatten(groups));
}

// --- перетаскивание наборов в списке ---
// Строки короткие и стоят стопкой, поэтому хватает штатного drag and drop:
// тащим строку, соседи расступаются, на отпускании пишем новый порядок.

let dragRow = null;

$('#setList').addEventListener('dragstart', (e) => {
  dragRow = e.target.closest('li');
  if (!dragRow) return;
  dragRow.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // без данных Firefox не начинает перетаскивание вовсе
  e.dataTransfer.setData('text/plain', dragRow.dataset.setId || '');
});

$('#setList').addEventListener('dragover', (e) => {
  if (!dragRow) return;
  e.preventDefault();
  const over = e.target.closest('li');
  if (!over || over === dragRow) return;
  const r = over.getBoundingClientRect();
  const before = e.clientY < r.top + r.height / 2;
  over.parentNode.insertBefore(dragRow, before ? over : over.nextSibling);
});

$('#setList').addEventListener('drop', (e) => e.preventDefault());

$('#setList').addEventListener('dragend', async () => {
  if (!dragRow) return;
  dragRow.classList.remove('dragging');
  dragRow = null;
  const ids = [...$('#setList').children].map((li) => li.dataset.setId);
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const byId = new Map(sets.map((s) => [s.id, s]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  if (next.length !== sets.length) return render(); // список разошёлся — перерисуем
  await chrome.storage.sync.set({ sets: next });
  render();
});

// высота ячейки в сетке — та же, что в popup.css; пропорции ограничены,
// иначе растяжка 10:1 вылезает за попап (см. displayRatio в emotes.js)
const GRID_PX = 28;
const cellWidth = (em) => Math.round(GRID_PX * VK7TV.displayRatio(em));

let gridEmotes = new Map();
function renderGrid(map) {
  gridEmotes = map;
  const query = $('#search').value.trim().toLowerCase();
  const grid = $('#grid');
  grid.innerHTML = '';
  let shown = 0;
  // Порядок и место под картинку — как в поповере: от узких к широким,
  // ширина ячейки известна заранее по пропорциям, поэтому сетка не скачет,
  // пока грузятся картинки. При поиске порядок не меняем: там важнее,
  // в каком порядке имена совпали.
  const items = [...map];
  if (!query) items.sort((a, b) => cellWidth(a[1]) - cellWidth(b[1]));
  for (const [name, v] of items) {
    if (query && !name.toLowerCase().includes(query)) continue;
    const img = document.createElement('img');
    img.src = v.u;
    if (v.r) img.style.aspectRatio = String(VK7TV.displayRatio(v));
    else img.style.minWidth = GRID_PX + 'px';
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

$('#everywhere').addEventListener('change', (e) => {
  chrome.storage.sync.set({ everywhere: e.target.checked });
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

// Длинный список имён в строке статуса не читается — показываем три и число
// остальных.
const listNames = (a) => (a.length > 3 ? `${a.slice(0, 3).join(', ')} и ещё ${a.length - 3}` : a.join(', '));

// Что на самом деле вышло из обновления наборов. Раньше здесь всегда было
// «наборы обновлены»: ошибки по каждому набору оставались в фоне, и человек
// не понимал, почему эмоутов нет.
function refreshOutcome(resp) {
  if (!resp) return { ok: false, text: 'Фоновый скрипт не ответил — попробуй ещё раз' };
  if (resp.error) return { ok: false, text: resp.error };
  const failed = resp.failed || [];
  const stale = resp.stale || [];
  if (failed.length) {
    return { ok: false, text: `Эмоуты не скачались: ${listNames(failed)} — ${resp.cause}` };
  }
  if (stale.length) {
    // эмоуты есть, но старые: набор показываем из кэша
    return { ok: true, text: `Обновлено, кроме: ${listNames(stale)} — ${resp.cause}` };
  }
  return { ok: true, text: '' };
}

$('#refreshSets').addEventListener('click', async () => {
  const status = $('#setStatus');
  status.classList.remove('error');
  status.textContent = 'Обновляю…';
  // по кнопке — принудительно, иначе сеть не трогается и кэш остаётся как есть
  const out = refreshOutcome(await sendMessage({ type: 'refresh-sets', force: true }));
  status.classList.toggle('error', !out.ok);
  status.textContent = out.text || 'Наборы обновлены';
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
  everywhere: false,
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
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error('Файл повреждён или это не JSON — выбери файл, сохранённый кнопкой «Сохранить в файл»');
    }
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
      everywhere:
        'everywhere' in data
          ? data.everywhere === true
          : 'messengerOnly' in data
            ? data.messengerOnly !== true
            : false,
      sets: merged,
      customEmotes: { ...cur.customEmotes, ...(data.customEmotes || {}) },
      favorites: [...new Set([...cur.favorites, ...favorites])],
    });
    status.textContent = `Восстановлено наборов: ${merged.length}. Качаю эмоуты…`;
    render();
    const out = refreshOutcome(await sendMessage({ type: 'refresh-sets' }));
    if (!out.ok) throw new Error(out.text);
    status.textContent = out.text || 'Готово, эмоуты загружены';
    render();
  } catch (err) {
    status.classList.add('error');
    // Переполнение хранилища браузер отдаёт как «QUOTA_BYTES_PER_ITEM quota
    // exceeded» — тут это самая вероятная неудача записи, объясняем словами.
    const msg = String((err && err.message) || err);
    status.textContent = /QUOTA_BYTES|quota exceeded/i.test(msg)
      ? 'Настройки не поместились в хранилище браузера — в файле слишком много своих эмоутов или наборов'
      : msg;
  }
});

$('#addCustom').addEventListener('click', async () => {
  const name = $('#customName').value.trim();
  const url = $('#customUrl').value.trim();
  const status = $('#customStatus');
  status.classList.remove('error');
  status.textContent = 'Добавляю…';
  // разбор ссылки и запрос к 7TV — в фоновом скрипте, там же остальные ошибки
  const resp = await sendMessage({ type: 'add-custom', input: url, name });
  if (!resp || resp.error) {
    status.classList.add('error');
    status.textContent = (resp && resp.error) || 'Не получилось добавить эмоут';
    return;
  }
  status.textContent = resp.id
    ? `Добавлен «${resp.full}» — собеседник с расширением увидит его как картинку`
    : `Добавлен «${resp.name}» — работает только у тебя`;
  $('#customName').value = '';
  $('#customUrl').value = '';
  render();
});

$('#search').addEventListener('input', () => renderGrid(gridEmotes));

$('#version').textContent = 'версия ' + chrome.runtime.getManifest().version;

render();
