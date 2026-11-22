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

// Локальная диагностика открытия включается только адресом popup.html?diag=1.
// Она считает длительность этапов и объём данных, но не пишет имена эмоутов,
// адреса картинок и прочее содержимое хранилища.
const popupDiag = (() => {
  if (!new URLSearchParams(location.search).has('diag')) return null;
  const data = {
    renderRuns: 0,
    gridRenders: 0,
    stages: {},
    counts: {},
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
  };
  try {
    if (
      window.PerformanceObserver &&
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.includes('longtask')
    ) {
      const observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          data.longTasks.count++;
          data.longTasks.totalMs += e.duration;
          data.longTasks.maxMs = Math.max(data.longTasks.maxMs, e.duration);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    }
  } catch {
    // longtask есть не во всех браузерах — остальные счётчики работают и без него
  }
  window.__vk7tvPopupDiag = data;
  return data;
})();

const diagStart = () => (popupDiag ? performance.now() : 0);
function diagTime(key, started) {
  if (!popupDiag || !started) return;
  const ms = performance.now() - started;
  const s = (popupDiag.stages[key] = popupDiag.stages[key] || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
  s.count++;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
  s.lastMs = ms;
}

async function render() {
  if (popupDiag) popupDiag.renderRuns++;
  const tRender = diagStart();
  const tLoad = diagStart();
  const { settings: sync, groups, missing } = await VK7TV.load();
  diagTime('load', tLoad);
  const tLocal = diagStart();
  const local = await chrome.storage.local.get({ docsDiagnostics: false });
  diagTime('localSettings', tLocal);
  if (popupDiag) {
    let entries = 0;
    for (const g of groups) entries += Object.keys(g.emotes).length;
    popupDiag.counts.sets = sync.sets.length;
    popupDiag.counts.groups = groups.length;
    popupDiag.counts.entries = entries;
  }

  $('#enabled').checked = sync.enabled;
  $('#useGlobal').checked = sync.useGlobal;
  $('#widgetOn').checked = sync.widget;
  $('#suggestOn').checked = sync.suggest;
  $('#autocompleteOn').checked = sync.autocomplete;
  $('#everywhere').checked = sync.everywhere;
  $('#docsDiagnostics').checked = !!local.docsDiagnostics;
  $('#globalCount').textContent = `(${Object.keys(DEFAULT_EMOTES).length})`;

  const setList = $('#setList');
  setList.innerHTML = '';
  const tSets = diagStart();
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
  diagTime('setList', tSets);

  const customList = $('#customList');
  unobserveAll(observedCustomImgs);
  clearLoadedSources(customList);
  customList.innerHTML = '';
  if (popupDiag) popupDiag.counts.customImagesWithSrc = 0;
  const tCustom = diagStart();
  const customImgs = [];
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
    // Раздел «Свои» по умолчанию закрыт: грузим картинки, когда он откроется.
    setDeferredSrc(img, em.u, observedCustomImgs);
    customImgs.push(img);
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
  observeDeferred(observedCustomImgs, customImgs);
  diagTime('customList', tCustom);

  // Наборы, у которых нет эмоутов, — отдельная строка: без неё непонятно,
  // почему набор в списке есть, а в сетке его эмоутов нет.
  const note = $('#gridNote');
  note.textContent = missing
    ? `Наборов без эмоутов: ${missing} — нажми «↻ Обновить наборы»`
    : '';
  note.style.display = missing ? '' : 'none';

  // Настройки и список наборов уже на экране. Плоскую карту всех эмоутов
  // собираем только когда раздел «Все эмоуты» действительно нужен: иначе
  // открытие попапа сразу создаёт десятки тысяч имён и картинок.
  setGridGroups(groups);
  diagTime('render', tRender);
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
// В DOM попапа одновременно находится одна страница карточек. При десятках
// наборов плоская карта — это десятки тысяч имён, и создавать под каждое <img>
// нельзя: браузер синхронно строит DOM и загружает анимированные картинки даже
// за пределами видимой части. Страницы заменяют друг друга, поэтому объём
// карточек и одновременно загружаемых изображений остаётся ограниченным.
const PAGE_SIZE = 200;
const cellWidth = (em) => Math.round(GRID_PX * VK7TV.displayRatio(em));

let gridGroups = [];
let gridEmotes = null; // плоская карта; null — раздел ещё ни разу не открывали
let gridView = null; // отфильтрованный и отсортированный список текущего поиска
let gridPage = 0;
let gridStarted = false;
let gridStarter = null;
let searchTimer = null;
const observedGridImgs = new Set();
const observedCustomImgs = new Set();
let imgObserver = null;

function unobserveAll(images) {
  if (imgObserver) {
    for (const img of images) imgObserver.unobserve(img);
  }
  images.clear();
}

// Снятие src до удаления карточки останавливает загрузку, которую уже
// запустила предыдущая страница или предыдущий поисковый запрос.
function clearLoadedSources(container) {
  for (const img of container.querySelectorAll('img[src]')) img.removeAttribute('src');
}

// Один observer на попап: он же обслуживает сетку, он же — картинки «Своих».
// src назначается с запасом в 160px, только когда карточка подходит к
// видимой области; у закрытого <details> пересечения нет вовсе.
function ensureImgObserver() {
  if (imgObserver || typeof IntersectionObserver !== 'function') return imgObserver;
  imgObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        imgObserver.unobserve(img);
        observedGridImgs.delete(img);
        observedCustomImgs.delete(img);
        // карточку могли убрать, пока браузер собирал очередь пересечений
        if (!img.isConnected) continue;
        const src = img.dataset.src;
        if (!src) continue;
        delete img.dataset.src;
        img.src = src;
        if (popupDiag) {
          if (img.parentElement && img.parentElement.id === 'grid') popupDiag.counts.lastImagesWithSrc++;
          else popupDiag.counts.customImagesWithSrc = (popupDiag.counts.customImagesWithSrc || 0) + 1;
        }
      }
    },
    { rootMargin: '160px 0px' }
  );
  return imgObserver;
}

function setDeferredSrc(img, url, bucket) {
  img.dataset.src = url;
  bucket.add(img);
}

function observeDeferred(bucket, images) {
  const observer = ensureImgObserver();
  if (!observer) {
    // браузер без IntersectionObserver: назначаем src сразу для текущей порции
    for (const img of images) {
      if (!img.dataset.src) continue;
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
    bucket.clear();
    return;
  }
  for (const img of images) observer.observe(img);
}

function countGridData(map) {
  if (!popupDiag) return;
  let aliases = 0;
  const urls = new Set();
  for (const v of map.values()) {
    if (v.a) aliases++;
    urls.add(v.u);
  }
  popupDiag.counts.names = map.size;
  popupDiag.counts.aliases = aliases;
  popupDiag.counts.urls = urls.size;
}

// --- отложенный запуск раздела «Все эмоуты» ---
// Список наборов и настройки должны появиться сразу. Карту эмоутов собираем,
// когда раздел подходит к видимой части попапа (или при поиске).
function watchGridStart() {
  if (gridStarted || gridStarter) return;
  const section = $('#gridSection') || $('#grid');
  if (!section || typeof IntersectionObserver !== 'function') {
    startGrid();
    return;
  }
  gridStarter = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) startGrid();
    },
    { rootMargin: '180px 0px' }
  );
  gridStarter.observe(section);
}

function startGrid() {
  if (gridStarted) return;
  gridStarted = true;
  if (gridStarter) {
    gridStarter.disconnect();
    gridStarter = null;
  }
  if (!gridEmotes) {
    const tFlatten = diagStart();
    gridEmotes = VK7TV.flatten(gridGroups);
    diagTime('flatten', tFlatten);
    countGridData(gridEmotes);
  }
  gridView = null;
  renderGrid();
}

function setGridGroups(groups) {
  gridGroups = groups;
  if (!gridStarted) {
    watchGridStart();
    return;
  }
  const tFlatten = diagStart();
  gridEmotes = VK7TV.flatten(groups);
  diagTime('flatten', tFlatten);
  countGridData(gridEmotes);
  gridView = null;
  renderGrid();
}

function buildGridView() {
  const query = $('#search').value.trim().toLowerCase();
  const map = gridEmotes || new Map();
  const tPrepare = diagStart();
  const items = [];
  for (const item of map) {
    // поиск идёт по всей карте, а не по уже показанной странице
    if (!query || item[0].toLowerCase().includes(query)) items.push(item);
  }
  // Порядок и место под картинку — как в поповере: от узких к широким,
  // ширина ячейки известна заранее по пропорциям, поэтому сетка не скачет,
  // пока грузятся картинки. При поиске порядок не меняем: там важнее,
  // в каком порядке имена совпали.
  if (!query) items.sort((a, b) => cellWidth(a[1]) - cellWidth(b[1]));
  diagTime('gridPrepare', tPrepare);
  gridView = { query, items };
  return gridView;
}

function renderGrid() {
  if (!gridStarted) return;
  const tRender = diagStart();
  if (popupDiag) popupDiag.gridRenders++;
  const query = $('#search').value.trim().toLowerCase();
  if (!gridView || gridView.query !== query) buildGridView();
  const items = gridView.items;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (gridPage >= pages) gridPage = pages - 1;
  if (gridPage < 0) gridPage = 0;
  const start = gridPage * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);

  const grid = $('#grid');
  unobserveAll(observedGridImgs);
  clearLoadedSources(grid);
  grid.innerHTML = '';
  if (popupDiag) {
    popupDiag.counts.lastQuery = query.length;
    popupDiag.counts.lastTotal = total;
    popupDiag.counts.lastCards = 0;
    popupDiag.counts.lastImagesWithSrc = 0;
  }
  const tDom = diagStart();
  const fragment = document.createDocumentFragment();
  const newImgs = [];
  for (const [name, v] of slice) {
    const img = document.createElement('img');
    if (v.r) img.style.aspectRatio = String(VK7TV.displayRatio(v));
    else img.style.minWidth = GRID_PX + 'px';
    img.alt = name;
    img.title = name;
    img.loading = 'lazy';
    setDeferredSrc(img, v.u, observedGridImgs);
    fragment.appendChild(img);
    newImgs.push(img);
  }
  grid.appendChild(fragment);
  observeDeferred(observedGridImgs, newImgs);
  diagTime('gridDom', tDom);

  const shown = slice.length;
  $('#totalCount').textContent = query ? `(${total} из ${gridEmotes.size})` : `(${gridEmotes.size})`;
  const pageInfo = $('#gridPage');
  if (pageInfo) pageInfo.textContent = total ? `${start + 1}–${start + shown} из ${total}` : '0 из 0';
  const prev = $('#gridPrev');
  const next = $('#gridNext');
  const nav = $('#gridPages');
  if (prev) prev.disabled = gridPage <= 0;
  if (next) next.disabled = gridPage >= pages - 1;
  if (nav) nav.hidden = total <= PAGE_SIZE;

  if (popupDiag) {
    popupDiag.counts.lastCards = grid.children.length;
    diagTime('gridRender', tRender);
    console.info('[VK7TV popup diag]', JSON.stringify(popupDiag));
  }
}

function goGridPage(delta) {
  if (!gridStarted) return;
  gridPage += delta;
  renderGrid();
}

$('#gridPrev')?.addEventListener('click', () => goGridPage(-1));
$('#gridNext')?.addEventListener('click', () => goGridPage(1));

// Один обработчик на всю сетку вместо отдельного замыкания на каждую
// картинку: при пересборке страницы старые обработчики не накапливаются.
$('#grid').addEventListener('click', (e) => {
  const img = e.target.closest ? e.target.closest('img') : null;
  if (!img || img.parentElement !== $('#grid')) return;
  const name = img.alt;
  navigator.clipboard.writeText(name);
  toast(`«${name}» скопировано`);
});

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

$('#autocompleteOn').addEventListener('change', (e) => {
  chrome.storage.sync.set({ autocomplete: e.target.checked });
});

$('#everywhere').addEventListener('change', (e) => {
  chrome.storage.sync.set({ everywhere: e.target.checked });
});

$('#docsDiagnostics').addEventListener('change', (e) => {
  chrome.storage.local.set({ docsDiagnostics: e.target.checked });
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
  autocomplete: true,
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
      autocomplete: data.autocomplete !== false,
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

// Быстрый ввод не должен перерисовывать сетку на каждую букву: старый таймер
// отменяется, поэтому устаревший запрос не заменит новые результаты.
$('#search').addEventListener('input', () => {
  if (!gridStarted) {
    startGrid();
    return;
  }
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    gridPage = 0;
    gridView = null;
    renderGrid();
  }, 120);
});

// Попап закрывают — снимаем observers и отложенные задачи, чтобы следующее
// открытие начинало с чистого состояния.
window.addEventListener('pagehide', () => {
  clearTimeout(searchTimer);
  searchTimer = null;
  clearTimeout(toastTimer);
  if (gridStarter) {
    gridStarter.disconnect();
    gridStarter = null;
  }
  if (imgObserver) {
    imgObserver.disconnect();
    imgObserver = null;
  }
  observedGridImgs.clear();
  observedCustomImgs.clear();
});

$('#version').textContent = 'версия ' + chrome.runtime.getManifest().version;

render();
