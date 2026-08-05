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
  let filterTimer = null;
  let widgetOn = false; // кнопка спрятана настройкой — поповер не открываем
  let collapsedKeys = new Set(); // ключи свёрнутых наборов, помнятся между сессиями
  let pendingReveal = null; // {key, full} — доскроллить, когда набор соберётся

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
        emoteIndex.set(fullName(g, name), typeof v === 'string' ? v : v.u);
      }
    }
    setFavorites(sync.favorites);
    widgetOn = sync.enabled && sync.widget;
    return widgetOn;
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
    syncStars(name);
    await chrome.storage.sync.set({ favorites: next });
  }

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
    favGrid.className = 'vk7tv-picker-grid vk7tv-scroll';
    favEmpty = document.createElement('div');
    favEmpty.className = 'vk7tv-picker-fav-empty';
    favEmpty.textContent = 'Наведи на эмоут и нажми ★ — он закрепится здесь';
    favBox.append(favTitle, favGrid, favEmpty);

    body = document.createElement('div');
    body.className = 'vk7tv-picker-body vk7tv-scroll';

    foot = document.createElement('div');
    foot.className = 'vk7tv-picker-foot';
    foot.textContent = FOOT_HINT;

    picker.append(head, searchInput, favBox, body, foot);
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
  const hiCache = new Map(); // cdn-url -> Promise<url версии 4x | null>
  let previewBox = null;
  let previewCell = null;
  let previewTimer = 0;
  let previewShown = false;

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

    const p = hiRes(cell.dataset.cdn);
    if (p) {
      p.then((u) => {
        if (u && previewShown && label.textContent === name) img.src = u;
      });
    }
  }

  function hidePreview() {
    clearTimeout(previewTimer);
    previewTimer = 0;
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

    picker.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.vk7tv-fav, .vk7tv-picker-group-title')) {
        e.preventDefault(); // не забираем фокус у поля ВК
        return;
      }
      const cell = e.target.closest('.vk7tv-picker-cell');
      if (!cell) return;
      previewShown = false;
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
    filterFavorites();
  }

  // Избранного немного — тут перебор ячеек дешевле пересборки.
  function filterFavorites() {
    const q = searchInput.value.trim().toLowerCase();
    let shown = 0;
    for (const cell of favGrid.querySelectorAll('.vk7tv-picker-cell')) {
      const hit = !q || cell.dataset.name.toLowerCase().includes(q);
      cell.style.display = hit ? '' : 'none';
      if (hit) shown++;
    }
    // при пустом поиске полоса остаётся с подсказкой, при поиске — только с находками
    favBox.style.display = shown || !q ? '' : 'none';
    favEmpty.style.display = shown || q ? 'none' : '';
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
    body.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();

    const jobs = [];
    for (const g of groups) {
      const found = [];
      for (const [name, v] of Object.entries(g.emotes)) {
        const full = fullName(g, name);
        if (q && !full.toLowerCase().includes(q)) continue;
        found.push([full, typeof v === 'string' ? v : v.u]);
      }
      if (!found.length) continue;
      const sec = document.createElement('div');
      sec.className = 'vk7tv-picker-group';
      const grid = document.createElement('div');
      grid.className = 'vk7tv-picker-grid';
      sec.append(groupTitle(g.title, found.length), grid);
      // работа по сборке живёт на самой секции: раскрыли набор — берём её
      // оттуда и досоздаём ячейки
      sec._vk7tvJob = { key: g.key, sec, grid, found, at: 0, filled: false, running: false };
      body.appendChild(sec);
      if (collapsedKeys.has(g.key)) sec.classList.add('vk7tv-collapsed');
      else jobs.push(sec._vk7tvJob);
    }
    fillJobs(jobs, token);
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
        const full = fullName(g, n);
        if (full === name) return { key: g.key, full };
        if (!byUrl && url && (typeof v === 'string' ? v : v.u) === url) {
          byUrl = { key: g.key, full };
        }
      }
    }
    return byUrl;
  }

  let hitCell = null;
  let hitTimer = null;

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
    filterFavorites();
  }

  document.addEventListener('vk7tv-reveal-emote', (e) => {
    const d = e.detail || {};
    revealEmote(d.name, d.url);
  });

  function applyFilter() {
    filterFavorites();
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
    renderFavorites();
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
    // позиция и размер — наши же записи, сетку из-за них не перерисовываем
    if (area === 'local' && !changes.setEmotes && !changes.globalEmotes) return;
    // избранное меняется часто (в том числе в соседней вкладке) — тысячу
    // картинок из-за него не пересобираем, хватает полосы и звёздочек
    const keys = Object.keys(changes);
    if (area === 'sync' && keys.length === 1 && keys[0] === 'favorites') {
      setFavorites(changes.favorites.newValue || []);
      renderFavorites();
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

  async function init() {
    buildUi();
    const { widgetPos, pickerSize, collapsedGroups } = await chrome.storage.local.get({
      widgetPos: null,
      pickerSize: null,
      collapsedGroups: [],
    });
    collapsedKeys = new Set(Array.isArray(collapsedGroups) ? collapsedGroups : []);
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
