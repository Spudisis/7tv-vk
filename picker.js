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
  let stripBox = null; // полоса над списком: «Недавние» или «Избранное»
  let stripGrid = null;
  let stripEmpty = null;
  let open = false;
  let groups = [];
  let favorites = []; // полные имена, порядок добавления
  let favSet = new Set();
  let recent = []; // последние вставленные, свежие первыми
  let stripTab = 'recent';
  let emoteIndex = new Map(); // полное имя -> url, чтобы найти картинку избранного
  let lastInput = null;
  let lastRange = null;
  let flashTimer = null;
  let filterTimer = null;
  let widgetOn = false; // кнопка спрятана настройкой — поповер не открываем
  let collapsedKeys = new Set(); // ключи свёрнутых наборов, помнятся между сессиями
  let pendingReveal = null; // {key, full} — доскроллить, когда набор соберётся
  let nearObserver = null; // следит, какой набор подошёл к видимой части списка

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
      document.execCommand('insertText', false, spaceBefore(target) + name + ' ');
      flash(`${name} — вставлено`);
    } else {
      navigator.clipboard.writeText(name);
      flash(`${name} — скопировано, поле ввода не найдено`);
    }
    pushRecent(name);
  }

  // Эмоут — отдельное слово между пробелами. Без этой проверки вставка
  // в конец «привет» давала «приветok»: код прилипал к предыдущему слову
  // и подмена его не находила. Текст до курсора берём диапазоном от начала
  // поля: ВК режет сообщение на несколько узлов, и соседний символ может
  // лежать не в том же текстовом узле, где стоит курсор.
  function spaceBefore(target) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return '';
    try {
      const r = sel.getRangeAt(0);
      const probe = document.createRange();
      probe.selectNodeContents(target);
      probe.setEnd(r.startContainer, r.startOffset);
      const before = probe.toString();
      return before && !/\s$/.test(before) ? ' ' : '';
    } catch (e) {
      return '';
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

  const FOOT_HINT = 'Вставить — клик или Enter, выбор — стрелками';

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
    // key — по нему помнится, свёрнут ли набор; берём id набора, а не
    // название: переименованный на 7TV набор должен остаться свёрнутым
    if (sync.useGlobal) {
      const g =
        local.globalEmotes && Object.keys(local.globalEmotes).length
          ? local.globalEmotes
          : DEFAULT_EMOTES;
      groups.push({ key: 'global', title: 'Глобальные 7TV', emotes: g });
    }
    for (const s of sync.sets) {
      const m = local.setEmotes[s.id];
      // suffix — постфикс набора: пикер всегда вставляет имя с ним
      if (m && Object.keys(m).length) {
        groups.push({ key: `set:${s.id}`, title: s.name, emotes: m, suffix: s.slug || '' });
      }
    }
    if (Object.keys(sync.customEmotes).length) {
      groups.push({ key: 'custom', title: 'Свои', emotes: sync.customEmotes });
    }
    // избранное хранит только имена — картинку берём из этого индекса,
    // а эмоуты удалённого набора просто перестают показываться
    emoteIndex = new Map();
    for (const g of groups) {
      for (const [name, v] of Object.entries(g.emotes)) {
        const em = normEmote(v);
        emoteIndex.set(fullName(g, name, em), em.u);
      }
    }
    setFavorites(sync.favorites);
    widgetOn = sync.enabled && sync.widget;
    return widgetOn;
  }

  // Вставляем всегда полное имя: у эмоута набора это постфикс набора,
  // у своего — id эмоута на 7TV, по которому его узнаёт чужое расширение.
  // Так эмоут не спутается с одноимённым из другого набора и с обычным словом.
  const fullName = (g, name, em) =>
    em && em.id ? `${name}_${em.id}` : g.suffix ? `${name}_${g.suffix}` : name;

  // старый кэш и часть своих эмоутов хранят просто строку-URL
  const normEmote = (v) => (typeof v === 'string' ? { u: v, z: 0 } : v);

  function setFavorites(list) {
    favorites = Array.isArray(list) ? list : [];
    favSet = new Set(favorites);
  }

  async function toggleFav(name) {
    const next = favSet.has(name) ? favorites.filter((n) => n !== name) : favorites.concat(name);
    setFavorites(next);
    renderStrip();
    syncStars(name);
    await chrome.storage.sync.set({ favorites: next });
  }

  // Недавние держим в local, а не в sync: вставка эмоута — частое действие,
  // а у sync потолок в 120 записей в минуту на всё расширение.
  const RECENT_MAX = 32;

  function pushRecent(name) {
    if (!name) return;
    recent = [name, ...recent.filter((n) => n !== name)].slice(0, RECENT_MAX);
    if (stripTab === 'recent') renderStrip();
    chrome.storage.local.set({ recent });
  }

  // эмоут вставили автозаполнением — полоса «Недавние» ведётся здесь
  document.addEventListener('vk7tv-used-emote', (e) => {
    pushRecent((e.detail || {}).name);
  });

  // --- DOM ---

  function buildUi() {
    widget = document.createElement('div');
    widget.className = 'vk7tv-widget';
    widget.textContent = '7VK';
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
    // Пересборка сетки на каждую букву — лишняя работа, пока фраза набирается.
    searchInput.addEventListener('input', () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(applyFilter, 120);
    });
    // Фокус всегда в поиске, поэтому перебор ячеек разбирается здесь.
    // Влево-вправо без выбранной ячейки не перехватываем: там курсор
    // ходит по набранному тексту.
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cell = selCell && selCell.isConnected ? selCell : firstCell();
        if (cell) insertEmote(cell.dataset.name);
        return;
      }
      const step =
        e.key === 'ArrowDown' ? [0, 1]
        : e.key === 'ArrowUp' ? [0, -1]
        : selCell && e.key === 'ArrowRight' ? [1, 0]
        : selCell && e.key === 'ArrowLeft' ? [-1, 0]
        : null;
      if (!step) return;
      e.preventDefault();
      moveSel(step[0], step[1]);
    });

    // полоса живёт над прокруткой списка, поэтому всегда на виду
    stripBox = document.createElement('div');
    stripBox.className = 'vk7tv-picker-fav';
    const tabs = document.createElement('div');
    tabs.className = 'vk7tv-picker-fav-title';
    for (const [key, label] of [['recent', 'Недавние'], ['fav', 'Избранное']]) {
      const tab = document.createElement('span');
      tab.className = 'vk7tv-strip-tab';
      tab.dataset.tab = key;
      tab.textContent = label;
      tab.addEventListener('click', () => setStripTab(key));
      tabs.appendChild(tab);
    }
    stripGrid = document.createElement('div');
    stripGrid.className = 'vk7tv-picker-grid vk7tv-scroll';
    stripEmpty = document.createElement('div');
    stripEmpty.className = 'vk7tv-picker-fav-empty';
    stripBox.append(tabs, stripGrid, stripEmpty);

    body = document.createElement('div');
    body.className = 'vk7tv-picker-body vk7tv-scroll';
    // Ячейки набора создаются, когда набор подходит к видимой части списка.
    // Запас в 600px — чтобы при обычной прокрутке они успевали появиться
    // до того, как набор покажется на экране.
    nearObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const job = e.target._vk7tvJob;
          if (!job || job.filled || job.running || collapsedKeys.has(job.key)) continue;
          fillJobs([job], buildToken);
        }
      },
      { root: body, rootMargin: '600px 0px' }
    );

    foot = document.createElement('div');
    foot.className = 'vk7tv-picker-foot';
    foot.textContent = FOOT_HINT;

    picker.append(head, searchInput, stripBox, body, foot);
    document.body.append(widget, picker);

    bindGrid();
    makeDraggable(widget, true);
    makeDraggable(head, false);
    sizeObserver.observe(picker);
  }

  // ячейка сетки: картинка + кнопка «в избранное» в правом верхнем углу
  // Долгое нажатие показывает эмоут крупно: в сетке 32px не разобрать,
  // что именно за картинка, особенно у похожих вариантов одного эмоута.
  const PREVIEW_DELAY = 300;
  // 4x тянем не сразу: при протяжке по сетке каждая ячейка под курсором
  // иначе уходила бы в сеть, а показывается она доли секунды
  const HI_DELAY = 160;
  const hiCache = new Map(); // cdn-url -> Promise<url версии 4x | null>
  let previewBox = null;
  let previewCell = null;
  let previewTimer = 0;
  let hiTimer = 0;
  let previewShown = false;
  let pressing = false; // кнопка мыши зажата на сетке — идёт протяжка
  let armedCell = null; // ячейка, на которую заведён таймер превью

  function previewEl() {
    if (previewBox) return previewBox;
    previewBox = document.createElement('div');
    previewBox.className = 'vk7tv-preview';
    previewBox.append(document.createElement('img'), document.createElement('span'));
    document.body.appendChild(previewBox);
    // Высота меняется, когда догрузится картинка. Позиция считается от неё,
    // поэтому одного расчёта мало — окно наезжало на эмоут снизу.
    new ResizeObserver(() => {
      if (previewCell) placePreview(previewCell, previewBox);
    }).observe(previewBox);
    return previewBox;
  }

  // в сетке лежит вариант 2x — при увеличении он мылит, поэтому тянем 4x
  function hiRes(cdn) {
    if (!cdn) return null;
    if (!hiCache.has(cdn)) {
      const st = window.__vk7tv;
      const big = cdn.replace(/\/\dx\.webp$/, '/4x.webp');
      hiCache.set(
        cdn,
        st && st.resolveEmote ? st.resolveEmote(big).catch(() => null) : Promise.resolve(null)
      );
    }
    return hiCache.get(cdn);
  }

  // Ставим окошко над ячейкой. Отдельной функцией, потому что позвать её
  // надо дважды: сразу и после загрузки картинки — до неё высота окошка
  // ещё не окончательная, и оно наезжало на эмоут снизу.
  function placePreview(cell, box) {
    const c = cell.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    let left = c.left + c.width / 2 - b.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - b.width - 8));
    let top = c.top - b.height - 8;
    if (top < 8) top = c.bottom + 8; // сверху не влезло — показываем снизу
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  function showPreview(cell) {
    const src = cell.querySelector('img');
    if (!src) return;
    const box = previewEl();
    const img = box.querySelector('img');
    const label = box.querySelector('span');
    const name = cell.dataset.name || src.alt || '';
    label.textContent = name;
    box.style.display = 'flex';
    previewShown = true;

    previewCell = cell;
    img.src = src.src;
    placePreview(cell, box);

    clearTimeout(hiTimer);
    hiTimer = setTimeout(() => {
      const p = hiRes(cell.dataset.cdn);
      if (!p) return;
      p.then((u) => {
        if (u && previewShown && previewCell === cell) img.src = u;
      });
    }, HI_DELAY);
  }

  function hidePreview() {
    clearTimeout(previewTimer);
    clearTimeout(hiTimer);
    previewTimer = 0;
    pressing = false;
    armedCell = null;
    if (previewBox) previewBox.style.display = 'none';
  }

  // За pointerleave не цепляемся: браузер сыплет leave/enter, даже когда
  // курсор стоит на месте, и превью не успевало показаться.
  document.addEventListener('pointerup', hidePreview, true);
  document.addEventListener('pointercancel', hidePreview, true);
  // Прокрутку не слушаем: браузер шлёт scroll прямо на нажатие, подтягивая
  // элемент в видимую часть, и превью из-за этого не открывалось.
  // Отпускания кнопки достаточно — превью живёт ровно пока держишь.

  // Ячейка — только разметка, без своих слушателей: в наборах бывают тысячи
  // эмоутов, и пять обработчиков на ячейку складывались в десятки тысяч.
  // Нажатия разбирает один общий обработчик на поповере (bindGrid).
  function makeCell(name, url) {
    const cell = document.createElement('span');
    cell.className = 'vk7tv-picker-cell';
    cell.dataset.name = name;
    // оригинал с CDN нужен, чтобы достать версию 4x для превью;
    // в url к этому моменту может лежать уже blob:
    if (/^https:\/\/cdn\.7tv\.app\//.test(url)) cell.dataset.cdn = url;

    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    img.title = name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;

    const star = document.createElement('button');
    star.className = 'vk7tv-fav';
    star.type = 'button';
    star.appendChild(starIcon());
    setStar(star, favSet.has(name));

    cell.append(img, star);
    return cell;
  }

  function bindGrid() {
    picker.addEventListener('click', (e) => {
      const star = e.target.closest('.vk7tv-fav');
      if (star) {
        e.stopPropagation();
        toggleFav(star.parentElement.dataset.name);
        return;
      }
      const head = e.target.closest('.vk7tv-picker-group-title');
      if (head) {
        toggleGroup(head.parentElement);
        return;
      }
      const cell = e.target.closest('.vk7tv-picker-cell');
      if (!cell) return;
      // зажали ради превью — вставлять не надо
      if (previewShown) {
        previewShown = false;
        return;
      }
      insertEmote(cell.dataset.name);
    });

    // Фокус не забираем: вставка идёт в поле ВК, а перебор стрелками — из
    // поиска, и клик по ячейке не должен его гасить. Уголок ресайза сюда
    // не попадает — иначе поповер перестал бы растягиваться.
    const NO_FOCUS =
      '.vk7tv-fav, .vk7tv-picker-group-title, .vk7tv-strip-tab, .vk7tv-picker-cell';

    picker.addEventListener('pointerdown', (e) => {
      if (e.target.closest(NO_FOCUS)) e.preventDefault();
      if (e.target.closest('.vk7tv-fav')) return; // звезда превью не открывает
      const cell = e.target.closest('.vk7tv-picker-cell');
      if (!cell) return;
      previewShown = false;
      pressing = true;
      armedCell = cell;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showPreview(cell), PREVIEW_DELAY);
    });

    // Не отпуская кнопку, ведём курсор по сетке — превью перескакивает
    // на ячейку под курсором. В зазор между ячейками (2px) курсор попадает
    // на каждом переходе, поэтому там оставляем прошлое превью.
    picker.addEventListener('pointermove', (e) => {
      if (!pressing) return;
      const cell = e.target.closest('.vk7tv-picker-cell');
      if (!cell || cell === armedCell) return;
      armedCell = cell;
      if (previewShown) {
        showPreview(cell); // превью уже открыто — переключаем без задержки
        return;
      }
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showPreview(cell), PREVIEW_DELAY);
    });

    // CSP ВК режет cdn.7tv.app — перезагружаем через фоновый скрипт (blob:).
    // Слушаем на перехвате: error не всплывает.
    picker.addEventListener(
      'error',
      (e) => {
        const img = e.target;
        if (!(img instanceof HTMLImageElement)) return;
        const cell = img.parentElement;
        if (!cell || !cell.classList.contains('vk7tv-picker-cell')) return;
        if (img.dataset.fb) return cell.remove();
        img.dataset.fb = '1';
        const st = window.__vk7tv;
        if (!st || !st.resolveEmote) return cell.remove();
        const url = img.src;
        const name = cell.dataset.name;
        st.resolveEmote(url).then((u) => {
          if (!u) return cell.remove();
          img.src = u;
          // запоминаем рабочий blob: — копия в избранном не пойдёт за ним заново
          if (emoteIndex.get(name) === url) emoteIndex.set(name, u);
        });
      },
      true
    );
  }

  // залитая звезда картинкой, а не глифом: у ★ ink сидит выше середины строки
  // и в кружке 15px это заметно, а тут центр — просто геометрия viewBox
  const STAR_PATH =
    'M12.00 2.95 L14.70 9.23 L21.51 9.86 L16.37 14.38 L17.88 21.05 ' +
    'L12.00 17.55 L6.12 21.05 L7.63 14.38 L2.49 9.86 L9.30 9.23 Z';

  function starIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '10');
    svg.setAttribute('height', '10');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', STAR_PATH);
    svg.appendChild(path);
    return svg;
  }

  // состояние показываем цветом — звезда всегда залита
  function setStar(btn, on) {
    btn.classList.toggle('vk7tv-fav-on', on);
    btn.title = on ? 'Убрать из избранного' : 'В избранное';
  }

  // Звёздочка меняется у одного имени, а ячеек в сетке тысячи: перебирать
  // все ради одной — заметная пауза на каждое нажатие звезды. Имя в селекторе
  // экранируем: в именах эмоутов бывают скобки и двоеточия.
  function syncStars(name) {
    const sel = name
      ? `.vk7tv-picker-cell[data-name="${CSS.escape(name)}"]`
      : '.vk7tv-picker-cell';
    for (const cell of picker.querySelectorAll(sel)) {
      const star = cell.querySelector('.vk7tv-fav');
      if (star) setStar(star, favSet.has(cell.dataset.name));
    }
  }

  const STRIP_EMPTY = {
    recent: 'Здесь появятся эмоуты, которые ты вставлял последними',
    fav: 'Наведи на эмоут и нажми ★ — он закрепится здесь',
  };

  function setStripTab(tab) {
    stripTab = tab;
    chrome.storage.local.set({ stripTab: tab });
    renderStrip();
  }

  function renderStrip() {
    for (const tab of stripBox.querySelectorAll('.vk7tv-strip-tab')) {
      tab.classList.toggle('vk7tv-strip-tab-on', tab.dataset.tab === stripTab);
    }
    stripBox.classList.toggle('vk7tv-tab-fav', stripTab === 'fav');
    stripGrid.innerHTML = '';
    let shown = 0;
    for (const name of stripTab === 'fav' ? favorites : recent) {
      const url = emoteIndex.get(name);
      if (!url) continue; // набор отключили — эмоут просто не показываем
      stripGrid.appendChild(makeCell(name, url));
      shown++;
    }
    stripEmpty.textContent = STRIP_EMPTY[stripTab];
    stripEmpty.style.display = shown ? 'none' : '';
    filterStrip();
  }

  // В полосе три десятка ячеек — тут перебор дешевле пересборки.
  function filterStrip() {
    const q = searchInput.value.trim().toLowerCase();
    let shown = 0;
    for (const cell of stripGrid.querySelectorAll('.vk7tv-picker-cell')) {
      const hit = !q || cell.dataset.name.toLowerCase().includes(q);
      cell.style.display = hit ? '' : 'none';
      if (hit) shown++;
    }
    // при пустом поиске полоса остаётся с подсказкой, при поиске — только с находками
    stripBox.style.display = shown || !q ? '' : 'none';
    stripEmpty.style.display = shown || q ? 'none' : '';
  }

  // Сколько ячеек создаём за кадр. Сборка тысяч картинок разом держала
  // страницу заблокированной; порциями поповер открывается сразу и
  // дозаполняется на глазах.
  const CHUNK = 120;
  let buildToken = 0;
  let dirty = true; // данные изменились, сетку надо собрать заново

  // Заголовок набора — он же кнопка сворачивания. Число рядом показывает,
  // сколько эмоутов внутри: у свёрнутого набора это единственный признак,
  // что находки по поиску там есть.
  function groupTitle(text, count) {
    const h = document.createElement('div');
    h.className = 'vk7tv-picker-group-title';
    h.title = 'Свернуть или развернуть набор';
    const chevron = document.createElement('span');
    chevron.className = 'vk7tv-picker-chevron';
    chevron.textContent = '▾';
    const name = document.createElement('span');
    name.className = 'vk7tv-picker-group-name';
    name.textContent = text;
    const cnt = document.createElement('span');
    cnt.className = 'vk7tv-picker-group-count';
    cnt.textContent = count;
    h.append(chevron, name, cnt);
    return h;
  }

  // Ячейки наборов, порциями по кадрам. Свёрнутый набор ячеек не создаёт
  // вовсе — они собираются при раскрытии этой же функцией.
  function fillJobs(jobs, token) {
    // пометка «уже собирается»: свернули набор на середине сборки и тут же
    // раскрыли — второй сборщик на тот же набор перемешал бы ячейки
    for (const job of jobs) job.running = true;
    let ji = 0;
    const step = () => {
      if (token !== buildToken) return; // пошла новая сборка
      let budget = CHUNK;
      while (ji < jobs.length && budget > 0) {
        const job = jobs[ji];
        const frag = document.createDocumentFragment();
        while (job.at < job.found.length && budget > 0) {
          frag.appendChild(makeCell(job.found[job.at][0], job.found[job.at][1]));
          job.at++;
          budget--;
        }
        job.grid.appendChild(frag);
        if (job.at >= job.found.length) {
          job.filled = true;
          job.running = false;
          // набор собран целиком, и только теперь его высота окончательная —
          // раньше прокручивать к нему бессмысленно
          if (pendingReveal && pendingReveal.key === job.key) revealNow(job);
          ji++;
        }
      }
      if (ji < jobs.length) requestAnimationFrame(step);
    };
    step(); // первую порцию кладём сразу — поповер не открывается пустым
  }

  // Сетка собирается только под текущий поиск: при запросе создаются
  // ячейки-находки, а не все тысячи с последующим display: none.
  function renderBody() {
    const token = ++buildToken; // отменяет незаконченную прошлую сборку
    selCell = null;
    nearObserver.disconnect();
    body.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();

    const jobs = [];
    let reached = false; // набор, к которому ведём прокрутку, уже встретился
    for (const g of groups) {
      const found = [];
      for (const [name, v] of Object.entries(g.emotes)) {
        const em = normEmote(v);
        const full = fullName(g, name, em);
        const low = full.toLowerCase();
        if (q && !low.includes(q)) continue;
        found.push([full, em.u, low]);
      }
      if (!found.length) continue;
      // при поиске сперва совпадения с начала имени, потом короткие:
      // порядок эмоутов в наборе для находок ничего не значит
      if (q) {
        found.sort((a, b) => {
          const ax = a[2].startsWith(q) ? 0 : 1;
          const bx = b[2].startsWith(q) ? 0 : 1;
          if (ax !== bx) return ax - bx;
          if (a[0].length !== b[0].length) return a[0].length - b[0].length;
          return a[0].localeCompare(b[0]);
        });
      }
      const sec = document.createElement('div');
      sec.className = 'vk7tv-picker-group';
      const grid = document.createElement('div');
      grid.className = 'vk7tv-picker-grid';
      sec.append(groupTitle(g.title, found.length), grid);
      // работа по сборке живёт на самой секции: раскрыли набор или он
      // подошёл к видимой части — берём её оттуда и досоздаём ячейки
      sec._vk7tvJob = { key: g.key, sec, grid, found, at: 0, filled: false, running: false };
      body.appendChild(sec);
      if (collapsedKeys.has(g.key)) {
        sec.classList.add('vk7tv-collapsed');
        continue;
      }
      nearObserver.observe(sec);
      // Первый набор собираем сразу, не дожидаясь наблюдателя: он отвечает
      // с задержкой, и поповер открывался бы пустым. Если ведём прокрутку
      // к набору — так же собираем всё до него: высота того, что выше,
      // должна быть окончательной, иначе прокрутка промахнётся.
      if (!jobs.length || (pendingReveal && !reached)) {
        jobs.push(sec._vk7tvJob);
        if (pendingReveal && pendingReveal.key === g.key) reached = true;
      }
    }
    if (!body.firstChild) body.appendChild(emptyNote(q));
    fillJobs(jobs, token);
  }

  // Пустой список: без пояснения непонятно, то ли не нашлось, то ли
  // расширение не загрузило наборы.
  function emptyNote(q) {
    const el = document.createElement('div');
    el.className = 'vk7tv-picker-empty';
    el.textContent = q
      ? 'Ничего не найдено'
      : 'Наборы не подключены — открой настройки расширения и добавь набор 7TV';
    return el;
  }

  // --- перебор ячеек с клавиатуры ---

  // Сетки в порядке показа: полоса сверху, дальше развёрнутые наборы.
  function visibleGrids() {
    const out = [];
    if (stripBox.style.display !== 'none') out.push(stripGrid);
    for (const sec of body.querySelectorAll('.vk7tv-picker-group:not(.vk7tv-collapsed)')) {
      const grid = sec.querySelector('.vk7tv-picker-grid');
      if (grid) out.push(grid);
    }
    return out;
  }

  // в полосе ячейки прячутся поиском, в наборах — пересобираются
  function gridCells(grid) {
    return [...grid.children].filter((c) => c.style.display !== 'none');
  }

  function selectCell(cell) {
    if (selCell) selCell.classList.remove('vk7tv-sel');
    selCell = cell || null;
    if (!selCell) return;
    selCell.classList.add('vk7tv-sel');
    selCell.scrollIntoView({ block: 'nearest' });
  }

  function firstCell() {
    for (const grid of visibleGrids()) {
      const cells = gridCells(grid);
      if (cells.length) return cells[0];
    }
    return null;
  }

  // Ячейки лежат в потоке с переносом строк: у соседней строки другой
  // offsetTop. Из неё берём ближайшую по горизонтали к текущей.
  function rowNeighbor(cells, i, dir) {
    const top = cells[i].offsetTop;
    const left = cells[i].offsetLeft;
    let j = i;
    while (j >= 0 && j < cells.length && cells[j].offsetTop === top) j += dir;
    if (j < 0 || j >= cells.length) return null;
    const rowTop = cells[j].offsetTop;
    let best = cells[j];
    for (let k = j; k >= 0 && k < cells.length && cells[k].offsetTop === rowTop; k += dir) {
      if (Math.abs(cells[k].offsetLeft - left) < Math.abs(best.offsetLeft - left)) best = cells[k];
    }
    return best;
  }

  // Край сетки — переходим в соседнюю. Набор, до которого прокрутка ещё
  // не дошла, пуст: первую порцию ячеек он создаёт сразу, её и хватает.
  function edgeCell(grids, grid, dir) {
    let gi = grids.indexOf(grid);
    for (;;) {
      gi += dir > 0 ? 1 : -1;
      if (gi < 0 || gi >= grids.length) return null;
      const job = grids[gi].parentElement._vk7tvJob;
      if (job && !job.filled && !job.running) fillJobs([job], buildToken);
      const cells = gridCells(grids[gi]);
      if (cells.length) return dir > 0 ? cells[0] : cells[cells.length - 1];
    }
  }

  function moveSel(dx, dy) {
    const grids = visibleGrids();
    if (!grids.length) return;
    if (!selCell || !selCell.isConnected) return selectCell(firstCell());
    const grid = selCell.parentElement;
    const cells = gridCells(grid);
    const i = cells.indexOf(selCell);
    if (i < 0) return selectCell(firstCell());
    if (dx) {
      selectCell(cells[i + dx] || edgeCell(grids, grid, dx));
      return;
    }
    selectCell(rowNeighbor(cells, i, dy) || edgeCell(grids, grid, dy));
  }

  function toggleGroup(sec) {
    const job = sec._vk7tvJob;
    if (!job) return;
    const collapse = !sec.classList.contains('vk7tv-collapsed');
    sec.classList.toggle('vk7tv-collapsed', collapse);
    if (collapse) {
      collapsedKeys.add(job.key);
    } else {
      collapsedKeys.delete(job.key);
      if (!job.filled && !job.running) fillJobs([job], buildToken);
    }
    chrome.storage.local.set({ collapsedGroups: [...collapsedKeys] });
  }

  // --- переход к эмоуту, по которому кликнули в сообщении ---

  // В чате эмоут из набора пишется голым именем (ok), а в пикере он всегда
  // с постфиксом (ok_bratishkinoff) — поэтому сперва ищем по полному имени,
  // а потом по адресу картинки: он у эмоута свой в любом наборе.
  function findEmote(name, url) {
    let byUrl = null;
    for (const g of groups) {
      for (const [n, v] of Object.entries(g.emotes)) {
        const em = normEmote(v);
        const full = fullName(g, n, em);
        if (full === name) return { key: g.key, full };
        if (!byUrl && url && em.u === url) byUrl = { key: g.key, full };
      }
    }
    return byUrl;
  }

  let hitCell = null;
  let hitTimer = null;
  let selCell = null; // ячейка, выбранная стрелками

  // Прокручиваем список к набору и подсвечиваем сам эмоут: в наборе на
  // тысячу картинок иначе непонятно, о какой из них речь.
  function revealNow(job) {
    const full = pendingReveal.full;
    pendingReveal = null;
    const cell = job.grid.querySelector(
      `.vk7tv-picker-cell[data-name="${CSS.escape(full)}"]`
    );
    const place = () => {
      const br = body.getBoundingClientRect();
      body.scrollTop += job.sec.getBoundingClientRect().top - br.top;
      if (!cell) return;
      const cr = cell.getBoundingClientRect();
      // набор большой — эмоут может остаться ниже видимой части
      if (cr.bottom > br.bottom) body.scrollTop += cr.top - br.top - body.clientHeight / 2;
    };
    // Наборы выше могли ещё ни разу не рисоваться (content-visibility), их
    // высота уточняется только при отрисовке и сдвигает нужный набор —
    // поэтому прокрутку повторяем ещё пару кадров, пока она не устоится.
    let tries = 3;
    const settle = () => {
      place();
      if (--tries > 0) requestAnimationFrame(settle);
    };
    settle();
    if (!cell) return;
    if (hitCell) hitCell.classList.remove('vk7tv-hit');
    hitCell = cell;
    cell.classList.add('vk7tv-hit');
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => cell.classList.remove('vk7tv-hit'), 2000);
  }

  function revealEmote(name, url) {
    if (!widgetOn) return; // кнопку спрятали настройкой — не лезем на страницу
    const hit = findEmote(name, url);
    // набор могли отключить, пока сообщение висело на экране — тогда просто
    // открываем поповер с поиском по имени
    searchInput.value = hit ? '' : name || '';
    pendingReveal = hit;
    if (hit && collapsedKeys.delete(hit.key)) {
      chrome.storage.local.set({ collapsedGroups: [...collapsedKeys] });
    }
    dirty = true; // сетку пересобираем: без фильтра и с раскрытым набором
    setOpen(true);
    filterStrip();
  }

  document.addEventListener('vk7tv-reveal-emote', (e) => {
    const d = e.detail || {};
    revealEmote(d.name, d.url);
  });

  function applyFilter() {
    filterStrip();
    renderBody();
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
    hidePreview();
    picker.style.display = open ? 'flex' : 'none';
    if (open) {
      // Сетку собираем при первом открытии, а не на загрузке страницы:
      // тысячи ячеек стоили заметной паузы каждой вкладке ВК, даже если
      // пикер в ней ни разу не открывали.
      if (dirty) {
        dirty = false;
        renderBody();
      }
      positionPicker();
      searchInput.focus();
    }
  }

  // Данные изменились: закрытый пикер соберётся при открытии, открытый — сразу.
  function refreshGrid() {
    renderStrip();
    dirty = true;
    if (!open) return;
    dirty = false;
    renderBody();
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
    // недавние пишет и соседняя вкладка, и автозаполнение — обновляем полосу
    if (area === 'local' && changes.recent) {
      recent = changes.recent.newValue || [];
      if (stripTab === 'recent') renderStrip();
    }
    // позиция и размер — наши же записи, сетку из-за них не перерисовываем
    if (area === 'local' && !changes.setEmotes && !changes.globalEmotes) return;
    // избранное меняется часто (в том числе в соседней вкладке) — тысячу
    // картинок из-за него не пересобираем, хватает полосы и звёздочек
    const keys = Object.keys(changes);
    if (area === 'sync' && keys.length === 1 && keys[0] === 'favorites') {
      setFavorites(changes.favorites.newValue || []);
      renderStrip();
      syncStars(); // из соседней вкладки могло измениться несколько имён сразу
      return;
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      const show = await loadGroups();
      widget.style.display = show ? 'flex' : 'none';
      if (!show) setOpen(false);
      refreshGrid();
    }, 200);
  });

  window.addEventListener('resize', () => {
    const r = widget.getBoundingClientRect();
    setWidgetPos(r.left, r.top);
    if (open) positionPicker();
  });

  // Ctrl+Shift+E — открыть поповер, не отрываясь от клавиатуры; фокус
  // сразу в поиске. На перехвате, иначе сочетание разберёт ВК.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!widgetOn || e.code !== 'KeyE') return;
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(!open);
    },
    true
  );

  async function init() {
    buildUi();
    const stored = await chrome.storage.local.get({
      widgetPos: null,
      pickerSize: null,
      collapsedGroups: [],
      recent: [],
      stripTab: 'recent',
    });
    const { widgetPos, pickerSize } = stored;
    collapsedKeys = new Set(Array.isArray(stored.collapsedGroups) ? stored.collapsedGroups : []);
    recent = Array.isArray(stored.recent) ? stored.recent : [];
    stripTab = stored.stripTab === 'fav' ? 'fav' : 'recent';
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
    refreshGrid();
  }

  init();
})();
