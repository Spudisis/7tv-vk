// VK7TV — виджет-пикер эмоутов на странице ВК.
// Круглая кнопка в углу; клик раскрывает поповер с поиском по всем
// подключённым наборам (сгруппированы по сетам) и полосой избранного
// сверху. Кнопку можно таскать за неё саму или за шапку поповера — они
// двигаются вместе, позиция запоминается. Клик по эмоуту вставляет его
// имя в последнее активное поле ввода ВК; если поля нет — копирует имя
// в буфер.

(() => {
  if (window.top !== window) return; // только в основном фрейме

  const WIDGET_SIZE = 46;

  let widget = null;
  let picker = null;
  let searchInput = null;
  let body = null;
  let foot = null;
  let favBox = null;
  let favGrid = null;
  let favEmpty = null;
  let open = false;
  let groups = [];
  let favorites = []; // полные имена, порядок добавления
  let favSet = new Set();
  let emoteIndex = new Map(); // полное имя -> url, чтобы найти картинку избранного
  let lastInput = null;
  let lastRange = null;
  let flashTimer = null;

  // --- последнее поле ввода ВК: куда вставлять эмоут ---

  function isOurs(el) {
    return !!el.closest('.vk7tv-picker, .vk7tv-widget');
  }

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el instanceof Element && el.isContentEditable && !isOurs(el)) lastInput = el;
  });

  document.addEventListener('selectionchange', () => {
    if (!lastInput) return;
    const sel = window.getSelection();
    if (sel.rangeCount && lastInput.contains(sel.anchorNode)) {
      lastRange = sel.getRangeAt(0).cloneRange();
    }
  });

  // если пользователь ещё не кликал в поле ввода — ищем видимый
  // contenteditable на странице; инпут сообщения обычно ниже всех
  function findMessageInput() {
    let best = null;
    let bestBottom = -1;
    for (const el of document.querySelectorAll('[contenteditable="true"]')) {
      if (isOurs(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.top >= window.innerHeight || r.bottom <= 0) continue;
      if (r.bottom > bestBottom) {
        best = el;
        bestBottom = r.bottom;
      }
    }
    return best;
  }

  function insertEmote(name) {
    let target = lastInput && lastInput.isConnected ? lastInput : null;
    if (!target) {
      target = findMessageInput();
      lastRange = null;
    }
    if (target) {
      target.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      if (lastRange && target.contains(lastRange.startContainer)) {
        sel.addRange(lastRange);
      } else {
        const r = document.createRange();
        r.selectNodeContents(target);
        r.collapse(false);
        sel.addRange(r);
      }
      document.execCommand('insertText', false, name + ' ');
      flash(`${name} — вставлено`);
    } else {
      navigator.clipboard.writeText(name);
      flash(`${name} — скопировано, поле ввода не найдено`);
    }
  }

  function flash(text) {
    foot.textContent = text;
    foot.classList.add('vk7tv-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      foot.classList.remove('vk7tv-flash');
      foot.textContent = FOOT_HINT;
    }, 1800);
  }

  const FOOT_HINT = 'Клик по эмоуту — вставить в сообщение';

  // --- данные ---

  async function loadGroups() {
    const sync = await chrome.storage.sync.get({
      enabled: true,
      useGlobal: true,
      sets: [],
      customEmotes: {},
      favorites: [],
      widget: true,
    });
    const local = await chrome.storage.local.get({ setEmotes: {}, globalEmotes: null });
    groups = [];
    if (sync.useGlobal) {
      const g =
        local.globalEmotes && Object.keys(local.globalEmotes).length
          ? local.globalEmotes
          : DEFAULT_EMOTES;
      groups.push({ title: 'Глобальные 7TV', emotes: g });
    }
    for (const s of sync.sets) {
      const m = local.setEmotes[s.id];
      // suffix — постфикс набора: пикер всегда вставляет имя с ним
      if (m && Object.keys(m).length) groups.push({ title: s.name, emotes: m, suffix: s.slug || '' });
    }
    if (Object.keys(sync.customEmotes).length) {
      groups.push({ title: 'Свои', emotes: sync.customEmotes });
    }
    // избранное хранит только имена — картинку берём из этого индекса,
    // а эмоуты удалённого набора просто перестают показываться
    emoteIndex = new Map();
    for (const g of groups) {
      for (const [name, v] of Object.entries(g.emotes)) {
        emoteIndex.set(fullName(g, name), typeof v === 'string' ? v : v.u);
      }
    }
    setFavorites(sync.favorites);
    return sync.enabled && sync.widget;
  }

  // вставляем всегда полное имя с постфиксом — так эмоут не спутается
  // с одноимённым из другого набора и с обычным словом
  const fullName = (g, name) => (g.suffix ? `${name}_${g.suffix}` : name);

  function setFavorites(list) {
    favorites = Array.isArray(list) ? list : [];
    favSet = new Set(favorites);
  }

  async function toggleFav(name) {
    const next = favSet.has(name) ? favorites.filter((n) => n !== name) : favorites.concat(name);
    setFavorites(next);
    renderFavorites();
    syncStars();
    await chrome.storage.sync.set({ favorites: next });
  }

  // --- DOM ---

  function buildUi() {
    widget = document.createElement('div');
    widget.className = 'vk7tv-widget';
    widget.textContent = '7TV';
    widget.title = 'VK7TV: эмоуты (можно перетаскивать)';

    picker = document.createElement('div');
    picker.className = 'vk7tv-picker';

    const head = document.createElement('div');
    head.className = 'vk7tv-picker-head';
    const title = document.createElement('span');
    title.textContent = 'Эмоуты';
    const gh = document.createElement('a');
    gh.className = 'vk7tv-picker-gh';
    gh.textContent = 'GitHub';
    gh.href = 'https://github.com/Spudisis/7tv-vk';
    gh.target = '_blank';
    gh.rel = 'noopener';
    gh.title = 'VK7TV на GitHub';
    const close = document.createElement('span');
    close.className = 'vk7tv-picker-close';
    close.textContent = '✕';
    close.addEventListener('click', () => setOpen(false));
    head.append(title, gh, close);

    searchInput = document.createElement('input');
    searchInput.className = 'vk7tv-picker-search';
    searchInput.type = 'text';
    searchInput.placeholder = 'Поиск эмоута…';
    searchInput.addEventListener('input', applyFilter);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    });

    // избранное живёт над прокруткой, поэтому всегда на виду
    favBox = document.createElement('div');
    favBox.className = 'vk7tv-picker-fav';
    const favTitle = document.createElement('div');
    favTitle.className = 'vk7tv-picker-fav-title';
    favTitle.textContent = 'Избранное';
    favGrid = document.createElement('div');
    favGrid.className = 'vk7tv-picker-grid';
    favEmpty = document.createElement('div');
    favEmpty.className = 'vk7tv-picker-fav-empty';
    favEmpty.textContent = 'Наведи на эмоут и нажми ☆ — он закрепится здесь';
    favBox.append(favTitle, favGrid, favEmpty);

    body = document.createElement('div');
    body.className = 'vk7tv-picker-body';

    foot = document.createElement('div');
    foot.className = 'vk7tv-picker-foot';
    foot.textContent = FOOT_HINT;

    picker.append(head, searchInput, favBox, body, foot);
    document.body.append(widget, picker);

    makeDraggable(widget, true);
    makeDraggable(head, false);
    sizeObserver.observe(picker);
  }

  // ячейка сетки: картинка + кнопка «в избранное» в правом верхнем углу
  function makeCell(name, url) {
    const cell = document.createElement('span');
    cell.className = 'vk7tv-picker-cell';
    cell.dataset.name = name;

    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    img.title = name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('click', () => insertEmote(name));
    // CSP ВК режет cdn.7tv.app — перезагружаем через фоновый скрипт (blob:)
    img.addEventListener('error', () => {
      if (img.dataset.fb) return cell.remove();
      img.dataset.fb = '1';
      const st = window.__vk7tv;
      if (!st || !st.resolveEmote) return cell.remove();
      st.resolveEmote(url).then((u) => {
        if (!u) return cell.remove();
        img.src = u;
        // запоминаем рабочий blob: — копия в избранном не пойдёт за ним заново
        if (emoteIndex.get(name) === url) emoteIndex.set(name, u);
      });
    });

    const star = document.createElement('button');
    star.className = 'vk7tv-fav';
    star.type = 'button';
    setStar(star, favSet.has(name));
    star.addEventListener('pointerdown', (e) => e.preventDefault()); // не забираем фокус у поля ВК
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(name);
    });

    cell.append(img, star);
    return cell;
  }

  function setStar(btn, on) {
    btn.textContent = on ? '★' : '☆';
    btn.classList.toggle('vk7tv-fav-on', on);
    btn.title = on ? 'Убрать из избранного' : 'В избранное';
  }

  function syncStars() {
    for (const cell of picker.querySelectorAll('.vk7tv-picker-cell')) {
      const star = cell.querySelector('.vk7tv-fav');
      if (star) setStar(star, favSet.has(cell.dataset.name));
    }
  }

  function renderFavorites() {
    favGrid.innerHTML = '';
    let shown = 0;
    for (const name of favorites) {
      const url = emoteIndex.get(name);
      if (!url) continue; // набор отключили — эмоут просто не показываем
      favGrid.appendChild(makeCell(name, url));
      shown++;
    }
    favEmpty.style.display = shown ? 'none' : '';
    applyFilter();
  }

  function renderBody() {
    body.innerHTML = '';
    for (const g of groups) {
      const sec = document.createElement('div');
      sec.className = 'vk7tv-picker-group';
      const h = document.createElement('div');
      h.className = 'vk7tv-picker-group-title';
      h.textContent = g.title;
      const grid = document.createElement('div');
      grid.className = 'vk7tv-picker-grid';
      for (const [name, v] of Object.entries(g.emotes)) {
        grid.appendChild(makeCell(fullName(g, name), typeof v === 'string' ? v : v.u));
      }
      sec.append(h, grid);
      body.appendChild(sec);
    }
    renderFavorites();
  }

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    let favShown = 0;
    for (const cell of favGrid.querySelectorAll('.vk7tv-picker-cell')) {
      const hit = !q || cell.dataset.name.toLowerCase().includes(q);
      cell.style.display = hit ? '' : 'none';
      if (hit) favShown++;
    }
    // при пустом поиске полоса остаётся с подсказкой, при поиске — только с находками
    favBox.style.display = favShown || !q ? '' : 'none';
    favEmpty.style.display = favShown || q ? 'none' : '';
    for (const sec of body.querySelectorAll('.vk7tv-picker-group')) {
      let shown = 0;
      for (const cell of sec.querySelectorAll('.vk7tv-picker-cell')) {
        const hit = !q || cell.dataset.name.toLowerCase().includes(q);
        cell.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      sec.style.display = shown ? '' : 'none';
    }
  }

  // --- позиционирование и перетаскивание ---

  function setWidgetPos(left, top) {
    left = Math.max(4, Math.min(left, window.innerWidth - WIDGET_SIZE - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - WIDGET_SIZE - 4));
    widget.style.left = left + 'px';
    widget.style.top = top + 'px';
  }

  function positionPicker() {
    const r = widget.getBoundingClientRect();
    const pw = picker.offsetWidth;
    const ph = picker.offsetHeight;
    // раскрываемся в сторону, где больше места
    let left = r.left + r.width / 2 > window.innerWidth / 2 ? r.right - pw : r.left;
    let top = r.top + r.height / 2 > window.innerHeight / 2 ? r.top - ph - 10 : r.bottom + 10;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  }

  function makeDraggable(handle, toggleOnClick) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList.contains('vk7tv-picker-close') || e.target.closest('a')) return;
      e.preventDefault(); // не забираем фокус у поля ввода ВК
      const r = widget.getBoundingClientRect();
      drag = { px: e.clientX, py: e.clientY, left: r.left, top: r.top, moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.px;
      const dy = e.clientY - drag.py;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      setWidgetPos(drag.left + dx, drag.top + dy);
      if (open) positionPicker();
    });
    handle.addEventListener('pointerup', () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) {
        const r = widget.getBoundingClientRect();
        chrome.storage.local.set({ widgetPos: { left: r.left, top: r.top } });
      } else if (toggleOnClick) {
        setOpen(!open);
      }
    });
    handle.addEventListener('pointercancel', () => {
      drag = null;
    });
  }

  function setOpen(next) {
    open = next;
    picker.style.display = open ? 'flex' : 'none';
    if (open) {
      positionPicker();
      searchInput.focus();
    }
  }

  // --- ресайз поповера (нативный CSS resize за правый нижний угол) ---

  function clampPicker() {
    const r = picker.getBoundingClientRect();
    picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)) + 'px';
    picker.style.top = Math.max(8, Math.min(r.top, window.innerHeight - r.height - 8)) + 'px';
  }

  let sizeTimer = null;
  const sizeObserver = new ResizeObserver(() => {
    if (!open) return;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const r = picker.getBoundingClientRect();
      if (!r.width || !r.height) return;
      chrome.storage.local.set({ pickerSize: { w: Math.round(r.width), h: Math.round(r.height) } });
      clampPicker();
    }, 250);
  });

  // --- реакция на настройки и ресайз ---

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    // позиция и размер — наши же записи, сетку из-за них не перерисовываем
    if (area === 'local' && !changes.setEmotes && !changes.globalEmotes) return;
    // избранное меняется часто (в том числе в соседней вкладке) — тысячу
    // картинок из-за него не пересобираем, хватает полосы и звёздочек
    const keys = Object.keys(changes);
    if (area === 'sync' && keys.length === 1 && keys[0] === 'favorites') {
      setFavorites(changes.favorites.newValue || []);
      renderFavorites();
      syncStars();
      return;
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      const show = await loadGroups();
      widget.style.display = show ? 'flex' : 'none';
      if (!show) setOpen(false);
      renderBody();
    }, 200);
  });

  window.addEventListener('resize', () => {
    const r = widget.getBoundingClientRect();
    setWidgetPos(r.left, r.top);
    if (open) positionPicker();
  });

  async function init() {
    buildUi();
    const { widgetPos, pickerSize } = await chrome.storage.local.get({
      widgetPos: null,
      pickerSize: null,
    });
    if (pickerSize) {
      picker.style.width = pickerSize.w + 'px';
      picker.style.height = pickerSize.h + 'px';
    }
    if (widgetPos) {
      setWidgetPos(widgetPos.left, widgetPos.top);
    } else {
      setWidgetPos(window.innerWidth - WIDGET_SIZE - 20, window.innerHeight - 170);
    }
    const show = await loadGroups();
    widget.style.display = show ? 'flex' : 'none';
    renderBody();
  }

  init();
})();
