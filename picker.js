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
  const DOCS = window.VK7TV_DOCS;
  const DOCS_MEDIA = window.VK7TV_DOCS_MEDIA;
  const DOCS_KEY = 'docs:files'; // отдельный ключ: наборы 7TV его не двигают
  const DOC_MEDIA_MARGIN = 100; // запас видимости для паузы/возобновления видео
  const DOC_DELETE_HOLD_MS = 1000;
  const DOC_DELETE_HINT = 'Удерживайте 1 секунду, чтобы удалить из документов VK';
  const DOC_DELETE_DRAFT_WARN = ' Документ уже прикреплён к текущему черновику.';

  let widget = null;
  let picker = null;
  // Желаемое положение кнопки: привязка к краю окна и отступ от него.
  // Фактические left/top могут быть сдвинуты, если окно временно меньше.
  let widgetPos = null;
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
  let emoteIndex = new Map(); // полное имя -> эмоут, чтобы найти картинку избранного
  let lastInput = null;
  let lastRange = null;
  let flashTimer = null;
  let filterTimer = null;
  let widgetOn = false; // кнопка спрятана настройкой — поповер не открываем
  let collapsedKeys = new Set(); // ключи свёрнутых наборов, помнятся между сессиями
  let pendingReveal = null; // {key, full} — доскроллить, когда набор соберётся
  let missingSets = 0; // наборы подключены, но их эмоуты не скачались
  let nearObserver = null; // следит, какой набор подошёл к видимой части списка
  let docsSection = null;
  let docsGrid = null;
  let docsStatus = null;
  let docsCount = null;
  let docsLoadingTail = null;
  let docsRefresh = null;
  let docsSentinel = null;
  let docsObserver = null;
  let docsVideoObserver = null;
  let docsCollapsed = true;
  let docsBuildToken = 0;
  let docsRenderQueued = false;
  let docsSubscribed = false;
  let docsRenderedQuery = null;
  let docsRenderedGen = -1;
  let docsRenderedKeys = new Set();
  let docsAttachQueue = Promise.resolve();
  let docsAttaching = new Set();
  let docsRefreshBusy = false;
  let docsMediaEpoch = null;
  let docsRenderedVersion = -1;
  let docsUploadInput = null;
  let docsUploadsBox = null;
  let docsUploadsLive = null;
  let docsUploadRows = new Map();
  let docsUploadAnnounced = new Map();
  let docsBatchBox = null;
  let docsBatchTitle = null;
  let docsBatchModes = [];
  let docsBatchFiles = [];
  let docsBatchRejected = [];
  let docsBatchMode = 'gif';
  let docsDnd = null;
  let docsDndDepth = 0;
  let docsDndVisible = false;
  let docHold = null; // одно активное удержание крестика
  let docsDeleteEpoch = null;

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
    foot.title = '';
    foot.classList.add('vk7tv-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      foot.classList.remove('vk7tv-flash');
      foot.textContent = FOOT_HINT;
    }, 1800);
  }

  const FOOT_HINT = 'Вставить — клик или Enter, выбор — стрелками';

  // --- данные ---

  // Разделы, порядок и приведение значений — в emotes.js: их же читают
  // чат и попап, и расходиться им нельзя.
  async function loadGroups() {
    const { settings, groups: loaded, missing } = await VK7TV.load();
    groups = loaded;
    missingSets = missing;
    // избранное хранит только имена — сам эмоут берём из этого индекса,
    // а эмоуты удалённого набора просто перестают показываться
    emoteIndex = new Map();
    for (const g of groups) {
      for (const [name, em] of Object.entries(g.emotes)) {
        emoteIndex.set(fullName(g, name, em), em);
      }
    }
    setFavorites(settings.favorites);
    widgetOn = settings.enabled && settings.widget;
    return widgetOn;
  }

  // Вставляем всегда полное имя: у эмоута набора это постфикс набора,
  // у своего — id эмоута на 7TV, по которому его узнаёт чужое расширение.
  const fullName = VK7TV.fullName;

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
      cancelDocHold('search');
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
        if (cell) activateCell(cell);
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

    // Видео и крупные анимации файлов играют только в видимой части списка;
    // при уходе за неё ставим на паузу, при возврате продолжаем с того же места.
    docsVideoObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const cell = e.target;
          if (!cell.classList || !cell.classList.contains('vk7tv-doc-cell')) continue;
          cell._vkVisible = e.isIntersecting;
          if (!cell._mediaReady) continue;
          setDocAnimVisible(cell, e.isIntersecting && mediaPlaybackAllowed());
        }
      },
      { root: body, rootMargin: DOC_MEDIA_MARGIN + 'px 0px' }
    );

    foot = document.createElement('div');
    foot.className = 'vk7tv-picker-foot';
    foot.textContent = FOOT_HINT;

    // Скрытый input живёт рядом с пикером: кнопка открывает системный
    // выбор, а после обработки значение сбрасывается — иначе повторный
    // выбор того же файла не вызовет change.
    docsUploadInput = document.createElement('input');
    docsUploadInput.type = 'file';
    docsUploadInput.multiple = true;
    docsUploadInput.className = 'vk7tv-docs-upload-input';
    docsUploadInput.accept = docsAccept();
    docsUploadInput.style.display = 'none';
    docsUploadInput.addEventListener('change', () => {
      const files = Array.from(docsUploadInput.files || []);
      docsUploadInput.value = '';
      if (!files.length || !DOCS) return;
      queueDocsFiles(files, []);
    });

    docsDnd = document.createElement('div');
    docsDnd.className = 'vk7tv-docs-dnd';
    docsDnd.hidden = true;
    const dndText = document.createElement('span');
    dndText.textContent = docsDndText();
    docsDnd.appendChild(dndText);

    picker.append(head, searchInput, stripBox, body, foot, docsUploadInput, docsDnd);
    document.body.append(widget, picker);

    bindGrid();
    bindDocsDnd();
    makeDraggable(widget, true);
    makeDraggable(head, false);
    sizeObserver.observe(picker);
  }

  function docsAccept() {
    const list = DOCS && Array.isArray(DOCS.formats) ? DOCS.formats : ['gif', 'webp', 'png'];
    return list.map((ext) => '.' + ext).join(',') + ',image/*,video/mp4';
  }

  function docsDndText() {
    const files = DOCS && DOCS.mp4;
    return files
      ? 'Перетащите сюда файлы, чтобы добавить их в документы VK'
      : 'Перетащите сюда изображения, чтобы добавить их в документы VK';
  }

  function isMp4Name(name) {
    return /\.mp4$/i.test(String(name || ''));
  }

  // Партия с MP4 сначала показывает выбор режима. Изображения из этой же
  // партии уходят в очередь без изменений, а режим применяется ко всем MP4.
  function queueDocsFiles(files, rejected) {
    const list = Array.from(files || []);
    const bad = Array.from(rejected || []);
    if (!DOCS) return;
    if (!list.length && !bad.length) return;
    const hasMp4 = !!(DOCS.mp4 && list.some((file) => isMp4Name(file && file.name)));
    if (hasMp4) {
      showDocsBatch(list, bad);
      return;
    }
    try {
      if (bad.length) DOCS.enqueueRejected(bad);
      if (list.length) DOCS.enqueueUploads(list);
    } catch (e) {
      flash('Не удалось поставить файлы в очередь');
    }
  }

  function showDocsBatch(files, rejected) {
    docsBatchFiles = Array.from(files || []);
    docsBatchRejected = Array.from(rejected || []);
    docsBatchMode = 'gif';
    renderDocsBatch();
  }

  function hideDocsBatch() {
    docsBatchFiles = [];
    docsBatchRejected = [];
    docsBatchMode = 'gif';
    renderDocsBatch();
  }

  function renderDocsBatch() {
    if (!docsBatchBox) return;
    const mp4Count = docsBatchFiles.filter((f) => isMp4Name(f && f.name)).length;
    const active = !!(docsBatchFiles.length || docsBatchRejected.length);
    docsBatchBox.style.display = active ? '' : 'none';
    if (!active) return;
    if (docsBatchTitle) {
      docsBatchTitle.textContent =
        mp4Count === 1 ? 'Выберите режим для MP4' : `Выберите режим для MP4 (${mp4Count})`;
    }
    for (const mode of docsBatchModes) {
      const on = mode.value === docsBatchMode;
      mode.input.checked = on;
      mode.label.classList.toggle('is-active', on);
    }
  }

  function buildDocsBatch() {
    const box = document.createElement('div');
    box.className = 'vk7tv-docs-batch';
    box.style.display = 'none';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Режим загрузки MP4');

    const title = document.createElement('div');
    title.className = 'vk7tv-docs-batch-title';

    const modes = document.createElement('div');
    modes.className = 'vk7tv-docs-batch-modes';
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', 'Режим загрузки MP4');
    const built = [];
    const addMode = (value, name, hint) => {
      const label = document.createElement('label');
      label.className = 'vk7tv-docs-batch-mode';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'vk7tv-mp4-mode';
      input.value = value;
      const body = document.createElement('span');
      body.className = 'vk7tv-docs-batch-mode-body';
      const nameEl = document.createElement('span');
      nameEl.className = 'vk7tv-docs-batch-mode-name';
      nameEl.textContent = name;
      body.appendChild(nameEl);
      if (hint) {
        const hintEl = document.createElement('span');
        hintEl.className = 'vk7tv-docs-batch-mode-hint';
        hintEl.textContent = hint;
        body.appendChild(hintEl);
      }
      label.append(input, body);
      input.addEventListener('change', () => {
        if (!input.checked) return;
        docsBatchMode = value;
        renderDocsBatch();
      });
      modes.appendChild(label);
      built.push({ value, label, input });
    };
    addMode('original', 'Загрузить видео', '');
    addMode(
      'gif',
      'Преобразовать в GIF',
      'До 15 с, 480 px по большей стороне, 15 кадров/с, исходник до 32 МиБ и 4 млн пикселей, GIF до 50 МиБ. Без звука; размер, плавность и цвета могут измениться.'
    );

    const actions = document.createElement('div');
    actions.className = 'vk7tv-docs-batch-actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'vk7tv-docs-batch-action is-primary';
    add.dataset.batchAction = 'add';
    add.textContent = 'Добавить';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'vk7tv-docs-batch-action';
    cancel.dataset.batchAction = 'cancel';
    cancel.textContent = 'Отмена';
    add.addEventListener('click', () => {
      const files = docsBatchFiles;
      const rejected = docsBatchRejected;
      const mode = docsBatchMode;
      hideDocsBatch();
      if (!DOCS) return;
      try {
        if (rejected.length) DOCS.enqueueRejected(rejected);
        if (files.length) DOCS.enqueueUploads(files, { mp4Mode: mode });
      } catch (e) {
        flash('Не удалось поставить файлы в очередь');
      }
    });
    cancel.addEventListener('click', hideDocsBatch);
    actions.append(add, cancel);

    box.append(title, modes, actions);
    docsBatchBox = box;
    docsBatchTitle = title;
    docsBatchModes = built;
    renderDocsBatch();
    return box;
  }

  function hasExternalFiles(dt) {
    if (!dt) return false;
    const types = dt.types ? Array.from(dt.types) : [];
    if (types.includes('Files')) return true;
    if (dt.items) {
      for (const item of Array.from(dt.items)) {
        if (item && item.kind === 'file') return true;
      }
    }
    return false;
  }

  function placeDropOverlay() {
    if (!docsDnd || !picker) return;
    const headEl = picker.querySelector('.vk7tv-picker-head');
    const footEl = picker.querySelector('.vk7tv-picker-foot');
    // Всё содержимое между шапкой и подвалом: шапка с закрытием остаётся
    // доступной, уголок ресайза в подвале — тоже.
    const top = headEl ? headEl.offsetTop + headEl.offsetHeight : 0;
    const bottom = footEl ? footEl.offsetTop : picker.offsetHeight;
    docsDnd.style.top = top + 'px';
    docsDnd.style.height = Math.max(0, bottom - top) + 'px';
  }

  function setDropVisible(next) {
    const value = !!next && open;
    if (docsDndVisible === value) {
      if (value) placeDropOverlay();
      return;
    }
    docsDndVisible = value;
    if (docsDnd) docsDnd.hidden = !value;
    if (value) placeDropOverlay();
  }

  function resetDrop() {
    docsDndDepth = 0;
    setDropVisible(false);
  }

  function bindDocsDnd() {
    // Только основной фрейм: пикер в iframe не создаётся (см. начало файла).
    document.addEventListener(
      'dragenter',
      (e) => {
        if (!open || !hasExternalFiles(e.dataTransfer)) return;
        docsDndDepth++;
        hidePreview();
        setDropVisible(true);
      },
      true
    );

    document.addEventListener(
      'dragleave',
      (e) => {
        if (!open) return;
        // Уход за пределы окна: DataTransfer к этому моменту может быть уже
        // пустым, поэтому relatedTarget надёжнее, чем types.
        if (e.relatedTarget === null) {
          resetDrop();
          return;
        }
        if (!hasExternalFiles(e.dataTransfer) && !docsDndVisible) return;
        docsDndDepth = Math.max(0, docsDndDepth - 1);
        if (docsDndDepth === 0) setDropVisible(false);
      },
      true
    );

    document.addEventListener(
      'dragover',
      (e) => {
        if (!open || !docsDndVisible || !hasExternalFiles(e.dataTransfer)) return;
        if (!docsDnd || !docsDnd.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      },
      true
    );

    document.addEventListener(
      'drop',
      (e) => {
        if (!open || !docsDndVisible) return;
        if (!docsDnd || !docsDnd.contains(e.target)) {
          resetDrop();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const dt = e.dataTransfer;
        resetDrop();
        if (dt) acceptDroppedFiles(dt);
      },
      true
    );

    document.addEventListener('dragend', resetDrop, true);
    window.addEventListener('blur', resetDrop);

    // Escape сначала снимает накладку: пикер при этом остаётся открытым.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !docsDndVisible) return;
        e.preventDefault();
        e.stopPropagation();
        resetDrop();
      },
      true
    );

    document.addEventListener('focusin', (e) => {
      if (!previewCell || !picker || picker.contains(e.target)) return;
      if (previewCell.classList.contains('vk7tv-doc-cell')) hidePreview();
    });
  }

  function acceptDroppedFiles(dt) {
    const files = [];
    const rejected = [];
    const items = dt.items ? Array.from(dt.items) : [];

    if (items.length) {
      for (const item of items) {
        if (!item || item.kind !== 'file') continue;
        let entry = null;
        try {
          entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        } catch (e) {
          entry = null;
        }
        if (entry && entry.isDirectory) {
          rejected.push({
            name: entry.name || 'Каталог',
            kind: 'file',
            message: 'Каталоги не загружаются: перетащи файлы по одному.',
          });
          continue;
        }
        let file = null;
        try {
          file = item.getAsFile();
        } catch (e) {
          file = null;
        }
        if (file) files.push(file);
        else {
          rejected.push({
            name: (entry && entry.name) || 'Файл',
            kind: 'file',
            message: 'Не удалось получить файл для загрузки.',
          });
        }
      }
    } else if (dt.files) {
      for (const file of Array.from(dt.files)) files.push(file);
    }

    if (!DOCS) return;
    queueDocsFiles(files, rejected);
    if (!files.length && !rejected.length) flash('Файлы не получены — попробуй ещё раз');
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
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.style.display = 'none';
    previewBox.append(video, document.createElement('img'), document.createElement('span'));
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
    if (cell.classList.contains('vk7tv-doc-cell')) {
      showDocPreview(cell);
      return;
    }
    const src = cell.querySelector('img');
    if (!src) return;
    const box = previewEl();
    const img = box.querySelector('img');
    const label = box.querySelector('span');
    const video = box.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.style.display = 'none';
    }
    img.style.display = '';
    img.onerror = null;
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

  // В сетке лежит лёгкое превью. Оригинал GIF тянем только здесь, по
  // требованию; если у документа есть видео-превью, оно и проигрывается.
  function showDocPreview(cell) {
    if (!DOCS) return;
    const doc = DOCS.getDocument(cell.dataset.key);
    if (!doc) return;
    const box = previewEl();
    const img = box.querySelector('img');
    const video = box.querySelector('video');
    const label = box.querySelector('span');
    label.textContent = doc.ext === 'mp4' ? 'MP4 · ' + doc.title : doc.title;
    box.style.display = 'flex';
    // Открытие по наведению не блокирует клик: previewShown остаётся для
    // удержания кнопки на эмоутах и не должен переключаться здесь.
    previewCell = cell;
    delete img.dataset.previewTried;
    img.onerror = () => {
      if (previewCell !== cell) return;
      const staticImage =
        doc.ext === 'png' || doc.ext === 'jpg' || doc.ext === 'jpeg';
      // Сначала пробуем оригинал вместо отвалившейся миниатюры.
      if (
        staticImage &&
        doc.url &&
        img.dataset.previewTried !== '1' &&
        img.src !== doc.url
      ) {
        img.dataset.previewTried = '1';
        img.src = doc.url;
        return;
      }
      img.style.display = 'none';
      label.textContent = doc.ext.toUpperCase() + ' · ' + doc.title;
    };

    const still = doc.preview
      ? doc.preview.url
      : doc.ext === 'gif' || doc.ext === 'webp' || doc.ext === 'mp4'
        ? ''
        : doc.url;
    if (still) {
      img.style.display = '';
      img.src = still;
    } else {
      img.style.display = 'none';
      img.removeAttribute('src');
    }
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.onerror = null;
      video.style.display = 'none';
    }

    const st = docsSnapshot();
    const account = docsAccountKey(st);
    const preferred = mediaSourceFor(doc, false);
    const prepared = preferred && DOCS_MEDIA ? DOCS_MEDIA.peek(account, doc, preferred) : null;
    const original = mediaSourceFor(doc, true);
    const preparedOriginal =
      original && DOCS_MEDIA ? DOCS_MEDIA.peek(account, doc, original) : null;
    const ready = (rec) => rec && rec.state === 'ready' && rec.url;

    if (doc.ext === 'gif' && video) {
      const videoUrl =
        (preferred && preferred.kind === 'video' && ready(prepared) && prepared.url) ||
        (doc.video && doc.video.url) ||
        '';
      if (videoUrl) {
        img.style.display = 'none';
        video.style.display = '';
        video.src = videoUrl;
        video.onerror = () => {
          if (previewCell !== cell) return;
          video.pause();
          video.removeAttribute('src');
          video.style.display = 'none';
          if (doc.preview) {
            img.style.display = '';
            img.src = doc.preview.url;
          } else if (doc.url) {
            img.style.display = '';
            img.src = doc.url;
          } else {
            label.textContent = 'GIF · ' + doc.title;
          }
        };
        const play = video.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
      } else if (doc.url) {
        img.style.display = '';
        img.src = ready(preparedOriginal) ? preparedOriginal.url : doc.url;
      }
    } else if (doc.ext === 'mp4') {
      // VK отдаёт оригинал MP4 как HTML-страницу, поэтому video ожидаемо
      // уходит в error. Не оставляем пустое окно: заголовок с «MP4» и есть
      // заглушка, документ при этом прикрепляется обычным кликом.
      const mp4Url =
        (prepared && prepared.state === 'ready' && prepared.url) ||
        (doc.video && doc.video.url) ||
        doc.url;
      if (video && mp4Url) {
        img.style.display = 'none';
        video.style.display = '';
        video.muted = true;
        video.loop = true;
        video.src = mp4Url;
        video.onerror = () => {
          if (previewCell !== cell) return;
          video.pause();
          video.removeAttribute('src');
          video.style.display = 'none';
          if (doc.preview) {
            img.style.display = '';
            img.src = doc.preview.url;
          }
        };
        const play = video.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
      }
    } else if (doc.url && doc.ext !== 'png' && doc.ext !== 'jpg' && doc.ext !== 'jpeg') {
      // GIF без видео и WEBP показываем оригиналом: в сетке он не нужен,
      // а при увеличении это единственный способ увидеть анимацию.
      img.style.display = '';
      img.src = ready(prepared) ? prepared.url : doc.url;
    } else if (doc.preview) {
      img.style.display = '';
      img.src = doc.preview.url;
    }
    placePreview(cell, box);
  }

  function hidePreview() {
    clearTimeout(previewTimer);
    clearTimeout(hiTimer);
    previewTimer = 0;
    pressing = false;
    armedCell = null;
    previewCell = null;
    if (!previewBox) return;
    const img = previewBox.querySelector('img');
    if (img) img.onerror = null;
    const video = previewBox.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.onerror = null;
      video.load?.();
    }
    previewBox.style.display = 'none';
  }

  // За pointerleave не цепляемся: браузер сыплет leave/enter, даже когда
  // курсор стоит на месте, и превью не успевало показаться.
  document.addEventListener('pointerup', hidePreview, true);
  document.addEventListener('pointercancel', hidePreview, true);
  // Прокрутку не слушаем: браузер шлёт scroll прямо на нажатие, подтягивая
  // элемент в видимую часть, и превью из-за этого не открывалось.
  // Отпускания кнопки достаточно — превью живёт ровно пока держишь.

  // Высота эмоута в сетке — та же, что в picker.css. Вместе с пропорциями
  // она даёт ширину ячейки: по ней эмоуты выстраиваются по размеру.
  // Пропорции берём ограниченные (см. displayRatio): растяжка 10:1 иначе
  // занимала бы всю строку.
  const CELL_PX = 32;
  const cellWidth = (em) => Math.round(CELL_PX * VK7TV.displayRatio(em));

  // Ячейка — только разметка, без своих слушателей: в наборах бывают тысячи
  // эмоутов, и пять обработчиков на ячейку складывались в десятки тысяч.
  // Нажатия разбирает один общий обработчик на поповере (bindGrid).
  function makeCell(name, em) {
    const cell = document.createElement('span');
    cell.className = 'vk7tv-picker-cell';
    cell.dataset.name = name;
    // оригинал с CDN нужен, чтобы достать версию 4x для превью;
    // в em.u к этому моменту может лежать уже blob: — тогда адрес на CDN
    // лежит в em.cdn (см. обработчик error в bindGrid)
    const cdn = em.cdn || em.u;
    if (/^https:\/\/cdn\.7tv\.app\//.test(cdn)) cell.dataset.cdn = cdn;

    const img = document.createElement('img');
    img.src = em.u;
    // Место под картинку держим заранее: пока она не загрузилась, своих
    // размеров у неё нет, ячейка была шириной в отбивку, а после загрузки
    // сетка расползалась. Пропорции пришли из API вместе с адресом;
    // у своей картинки не с 7TV их нет — там место под квадрат.
    if (em.r) img.style.aspectRatio = String(VK7TV.displayRatio(em));
    else img.style.minWidth = CELL_PX + 'px';
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

  // --- удаление документа удержанием крестика ---

  function docNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function docHoldCell(hold) {
    return hold && hold.button ? hold.button.closest('.vk7tv-doc-cell') : null;
  }

  function cancelDocHold(reason) {
    const hold = docHold;
    if (!hold) return;
    docHold = null;
    if (hold.timer) clearTimeout(hold.timer);
    if (hold.raf) cancelAnimationFrame(hold.raf);
    hold.timer = 0;
    hold.raf = 0;
    if (hold.button) {
      hold.button.classList.remove('vk7tv-doc-holding');
      hold.button.style.removeProperty('--vk7tv-hold');
      if (hold.source === 'pointer' && hold.pointerId != null) {
        try {
          if (hold.button.hasPointerCapture(hold.pointerId)) {
            hold.button.releasePointerCapture(hold.pointerId);
          }
        } catch (e) {
          // захват уже потерян
        }
      }
      if (reason === 'outside') {
        try {
          hold.button.blur();
        } catch (e) {
          // кнопка уже убрана
        }
      }
    }
    const cell = docHoldCell(hold);
    if (cell) cell.classList.remove('vk7tv-doc-delete-holding');
  }

  function paintDocHold(hold) {
    if (docHold !== hold || !hold.button) return;
    const elapsed = docNow() - hold.startedAt;
    const percent = Math.max(0, Math.min(100, (elapsed / DOC_DELETE_HOLD_MS) * 100));
    hold.button.style.setProperty('--vk7tv-hold', String(percent));
    if (elapsed < DOC_DELETE_HOLD_MS) {
      hold.raf = requestAnimationFrame(() => paintDocHold(hold));
    }
  }

  function finishDocHold(hold) {
    if (docHold !== hold) return;
    const key = hold.key;
    hold.done = true;
    cancelDocHold('done');
    if (!key || !DOCS) return;
    const state = DOCS.getDeletion(key);
    if (state && (state.status === 'pending' || state.checking)) return;
    let result;
    try {
      result = DOCS.deleteDocument(key);
    } catch (e) {
      result = null;
    }
    if (result && typeof result.then === 'function') {
      result
        .then((answer) => {
          if (!answer || answer.ok) return;
          if (answer.reason === 'stale') flash('Файл больше не доступен');
          else if (answer.reason === 'auth') {
            const state = DOCS.getState();
            flash(
              (state.error && state.error.message) ||
                'Не удалось подтвердить вход VK для удаления документа.'
            );
          }
        })
        .catch(() => {});
    }
  }

  function armDocHold(hold, wait) {
    hold.timer = setTimeout(() => {
      if (docHold !== hold) return;
      const elapsed = docNow() - hold.startedAt;
      if (elapsed < DOC_DELETE_HOLD_MS) {
        // Таймер сработал раньше монотонных часов — ждём остаток, а не
        // начинаем новую полную секунду.
        armDocHold(hold, DOC_DELETE_HOLD_MS - elapsed);
        return;
      }
      finishDocHold(hold);
    }, wait == null ? DOC_DELETE_HOLD_MS : Math.max(0, wait));
  }

  function startDocHold(button, event, source) {
    if (!button || !DOCS || !open || docsCollapsed) return false;
    if (docHold) return false;
    const cell = button.closest('.vk7tv-doc-cell');
    const key = cell && cell.dataset.key;
    if (!key) return false;
    const state = DOCS.getDeletion(key);
    if (state && (state.status === 'pending' || state.checking)) return false;
    if (docsAttaching.has(key)) {
      flash('Файл прикрепляется — удаление недоступно');
      return false;
    }

    hidePreview();
    const hold = {
      key,
      button,
      source,
      pointerId: null,
      startedAt: docNow(),
      timer: 0,
      raf: 0,
      done: false,
    };
    docHold = hold;
    button.classList.add('vk7tv-doc-holding');
    if (cell) cell.classList.add('vk7tv-doc-delete-holding');
    if (source === 'pointer') {
      hold.pointerId = event.pointerId;
      try {
        button.setPointerCapture(event.pointerId);
      } catch (e) {
        // touch может не дать захват до движения
      }
    }
    armDocHold(hold);
    paintDocHold(hold);
    warnDraftDoc(button, key);
    return true;
  }

  // Предупреждение о текущем черновике не блокирует удаление: ВК не меняет
  // уже прикреплённые документы, но пользователь должен об этом знать.
  function warnDraftDoc(button, key) {
    if (!DOCS || !DOCS.composer || typeof DOCS.composer.getContext !== 'function') return;
    button.title = DOC_DELETE_HINT;
    button.setAttribute('aria-label', DOC_DELETE_HINT);
    let promise;
    try {
      promise = DOCS.composer.getContext();
    } catch (e) {
      return;
    }
    Promise.resolve(promise)
      .then((context) => {
        if (!button.isConnected) return;
        if (!context || !context.ok || !Array.isArray(context.docs)) return;
        if (!context.docs.includes(key)) return;
        button.title = DOC_DELETE_HINT + DOC_DELETE_DRAFT_WARN;
        button.setAttribute('aria-label', button.title);
      })
      .catch(() => {});
  }

  function applyDocDeleteState(cell, state) {
    if (!cell) return;
    const button = cell.querySelector('.vk7tv-doc-delete');
    const status = cell.querySelector('.vk7tv-doc-delete-state');
    const text = cell.querySelector('.vk7tv-doc-delete-text');
    const verify = cell.querySelector('.vk7tv-doc-verify');
    let message = '';
    if (state) {
      if (state.status === 'pending') message = 'Удаление…';
      else if (state.checking) message = 'Проверяем библиотеку…';
      else if (state.status === 'unknown') message = 'Не удалось подтвердить удаление';
      else if (state.status === 'error') message = state.message || 'Не удалось удалить';
    }
    cell.classList.toggle(
      'vk7tv-doc-deleting',
      !!state && (state.status === 'pending' || state.checking)
    );
    cell.classList.toggle('vk7tv-doc-delete-error', !!state && state.status === 'error');
    cell.classList.toggle('vk7tv-doc-delete-unknown', !!state && state.status === 'unknown');
    if (status) {
      status.style.display = message ? '' : 'none';
      status.title = message;
      status.setAttribute('aria-label', message);
    }
    if (text) text.textContent = message;
    if (button) {
      button.disabled = !!state && (state.status === 'pending' || state.checking);
    }
    if (verify) {
      verify.style.display = state && state.status === 'unknown' && !state.checking ? '' : 'none';
    }
  }

  function refreshDocDeleteStates(st) {
    if (!docsGrid || !DOCS) return;
    const map = new Map();
    const list = st && Array.isArray(st.deletions) ? st.deletions : [];
    for (const state of list) map.set(state.key, state);
    for (const cell of docsGrid.querySelectorAll('.vk7tv-doc-cell')) {
      applyDocDeleteState(cell, map.get(cell.dataset.key) || null);
    }
  }

  function syncDocDeleteSession(st) {
    const epoch = st ? st.accountEpoch || 0 : 0;
    if (docsDeleteEpoch === null) {
      docsDeleteEpoch = epoch;
      return;
    }
    if (epoch !== docsDeleteEpoch) {
      docsDeleteEpoch = epoch;
      cancelDocHold('account');
    }
  }

  // Документ — отдельный тип ячейки: у него нет звезды избранного, имени
  // эмоута и правил CDN 7TV. Клик и Enter прикрепляют его к черновику.
  function makeDocCell(doc) {
    const cell = document.createElement('span');
    cell.className = 'vk7tv-picker-cell vk7tv-doc-cell';
    cell.dataset.key = doc.key;
    cell.dataset.name = doc.title;

    const media = document.createElement('span');
    media.className = 'vk7tv-doc-media';

    const img = document.createElement('img');
    img.className = 'vk7tv-doc-poster';
    // У статичных PNG/JPEG миниатюры может не быть: пробуем оригинал, а
    // ошибка загрузки оставит заглушку с форматом.
    const staticImage = doc.ext === 'png' || doc.ext === 'jpg' || doc.ext === 'jpeg';
    const poster = doc.preview ? doc.preview.url : staticImage ? doc.url : '';
    if (poster) {
      img.src = poster;
    } else {
      img.style.display = 'none';
    }
    img.alt = doc.title;
    img.title = doc.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;

    const fallback = document.createElement('span');
    fallback.className = 'vk7tv-doc-fallback';
    fallback.textContent = doc.ext.toUpperCase();
    fallback.title = doc.title;
    fallback.style.display = poster ? 'none' : 'flex';

    media.append(img, fallback);
    cell.appendChild(media);

    const remove = document.createElement('button');
    remove.className = 'vk7tv-doc-delete';
    remove.type = 'button';
    remove.title = DOC_DELETE_HINT;
    remove.setAttribute('aria-label', DOC_DELETE_HINT);
    remove.appendChild(deleteIcon());

    const status = document.createElement('span');
    status.className = 'vk7tv-doc-delete-state';
    status.style.display = 'none';
    const statusText = document.createElement('span');
    statusText.className = 'vk7tv-doc-delete-text';
    const verify = document.createElement('button');
    verify.className = 'vk7tv-doc-verify';
    verify.type = 'button';
    verify.textContent = 'Проверить библиотеку';
    verify.title = 'Прочитать библиотеку с первой страницы';
    status.append(statusText, verify);
    cell.append(remove, status);

    applyReadyDocMedia(cell, doc);
    applyDocDeleteState(cell, DOCS ? DOCS.getDeletion(doc.key) : null);
    return cell;
  }

  function docsSnapshot() {
    if (!DOCS) return null;
    try {
      return DOCS.getState();
    } catch (e) {
      return null;
    }
  }

  function docsAccountKey(st) {
    const s = st || docsSnapshot();
    if (!s) return '';
    return `${(s.auth && s.auth.userId) || 0}:${s.accountEpoch || 0}`;
  }

  function mediaSourceFor(doc, forceOriginal) {
    if (!doc) return null;
    // PNG/JPEG статичны: отдельная загрузка через кэш им не нужна.
    if (doc.ext === 'png' || doc.ext === 'jpg' || doc.ext === 'jpeg') return null;
    // MP4 VK отдаёт HTML-страницей, а не потоком. Если отдельного
    // видео-превью нет, карточка показывает заглушку, а большое превью
    // пробует оригинал напрямую.
    if (doc.ext === 'mp4') {
      return doc.video && doc.video.url
        ? { kind: 'video', url: doc.video.url, size: doc.video.size || 0 }
        : null;
    }
    if (!forceOriginal && doc.ext === 'gif' && doc.video && doc.video.url) {
      return { kind: 'video', url: doc.video.url, size: doc.video.size || 0 };
    }
    if (doc.url) return { kind: 'image', url: doc.url, size: doc.size || 0 };
    return null;
  }

  function mediaPlaybackAllowed() {
    return open && !docsCollapsed && !document.hidden;
  }

  function docCellInView(cell) {
    if (!cell || !body) return false;
    const br = body.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    return cr.bottom > br.top - DOC_MEDIA_MARGIN && cr.top < br.bottom + DOC_MEDIA_MARGIN;
  }

  function playDocVideo(video) {
    if (!video) return;
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  // Показ подготовленного медиа и постер — взаимозаменяемые состояния одной
  // карточки. Скрытие анимации у GIF/WEBP не гарантирует остановку кадров,
  // поэтому на время паузы возвращаем постер.
  function setDocAnimVisible(cell, visible) {
    if (!cell) return;
    const anim = cell.querySelector('.vk7tv-doc-anim');
    const poster = cell.querySelector('.vk7tv-doc-poster');
    const fallback = cell.querySelector('.vk7tv-doc-fallback');
    if (!cell._mediaReady || !anim) {
      if (poster) poster.style.display = poster.dataset.failed || !poster.getAttribute('src') ? 'none' : '';
      if (fallback) {
        fallback.style.display = poster && !poster.dataset.failed && poster.getAttribute('src') ? 'none' : 'flex';
      }
      return;
    }
    if (visible) {
      anim.style.display = '';
      if (poster) poster.style.display = 'none';
      if (fallback) fallback.style.display = 'none';
      if (anim.tagName === 'VIDEO' && mediaPlaybackAllowed()) playDocVideo(anim);
      return;
    }
    anim.style.display = 'none';
    if (anim.tagName === 'VIDEO') anim.pause();
    const hasPoster = poster && !poster.dataset.failed && !!poster.getAttribute('src');
    if (poster) poster.style.display = hasPoster ? '' : 'none';
    if (fallback) fallback.style.display = hasPoster ? 'none' : 'flex';
  }

  function observeDocMedia(cell) {
    if (docsVideoObserver && cell) docsVideoObserver.observe(cell);
  }

  function pauseDocMedia() {
    if (!body) return;
    for (const cell of body.querySelectorAll('.vk7tv-doc-cell')) {
      if (cell._mediaReady) setDocAnimVisible(cell, false);
    }
  }

  function resumeDocMedia() {
    if (!body) return;
    for (const cell of body.querySelectorAll('.vk7tv-doc-cell')) {
      if (!cell._mediaReady) continue;
      cell._vkVisible = docCellInView(cell);
      setDocAnimVisible(cell, cell._vkVisible && mediaPlaybackAllowed());
    }
  }

  function cleanupDocCell(cell) {
    if (!cell) return;
    const key = cell._mediaKey || cell._mediaPending;
    cell._mediaKey = '';
    cell._mediaPending = '';
    cell._mediaReady = false;
    cell._mediaKind = '';
    cell._mediaSource = null;
    cell._mediaAccount = '';
    if (docsVideoObserver) docsVideoObserver.unobserve(cell);
    const anim = cell.querySelector('.vk7tv-doc-anim');
    if (anim) {
      if (anim.tagName === 'VIDEO') {
        anim.pause();
        anim.removeAttribute('src');
        if (anim.load) anim.load();
      }
      anim.remove();
    }
    if (key && DOCS_MEDIA) DOCS_MEDIA.release(key);
    setDocAnimVisible(cell, false);
  }

  function cleanupDocCells(root) {
    const scope = root || docsGrid;
    if (!scope) return;
    for (const cell of scope.querySelectorAll('.vk7tv-doc-cell')) cleanupDocCell(cell);
  }

  function handleDocAnimError(cell, kind) {
    if (!cell) return;
    const key = cell._mediaKey;
    const doc = DOCS ? DOCS.getDocument(cell.dataset.key) : null;
    const anim = cell.querySelector('.vk7tv-doc-anim');
    if (anim) {
      if (anim.tagName === 'VIDEO') {
        anim.pause();
        anim.removeAttribute('src');
        if (anim.load) anim.load();
      }
      anim.remove();
    }
    cell._mediaKey = '';
    cell._mediaReady = false;
    if (key && DOCS_MEDIA) {
      DOCS_MEDIA.markError(key);
      DOCS_MEDIA.release(key);
    }
    // У GIF сначала пробуем видео-превью; если оно не открылось — один раз
    // переходим на оригинал. Ошибка другого источника уже не даёт цикла.
    if (kind === 'video' && doc && doc.ext === 'gif' && doc.url && !cell._mediaTriedOriginal) {
      cell._mediaTriedOriginal = true;
      activateDocMedia(cell, true);
      return;
    }
    setDocAnimVisible(cell, false);
  }

  function showDocRecord(cell, doc, source, rec, account, key) {
    if (!cell || !rec || !rec.url) {
      if (DOCS_MEDIA) DOCS_MEDIA.release(key);
      return;
    }
    if (cell._mediaKey && cell._mediaKey !== key) cleanupDocCell(cell);
    if (cell._mediaKey === key) {
      setDocAnimVisible(cell, cell._mediaReady && cell._vkVisible && mediaPlaybackAllowed());
      return;
    }

    const media = cell.querySelector('.vk7tv-doc-media');
    if (!media) {
      if (DOCS_MEDIA) DOCS_MEDIA.release(key);
      return;
    }

    cell._mediaKey = key;
    cell._mediaPending = '';
    cell._mediaReady = false;
    cell._mediaKind = source.kind;
    cell._mediaSource = source;
    cell._mediaAccount = account;
    cell._mediaTriedOriginal = cell._mediaTriedOriginal || source.kind === 'image';

    const old = cell.querySelector('.vk7tv-doc-anim');
    if (old) old.remove();

    let anim;
    if (source.kind === 'video') {
      anim = document.createElement('video');
      anim.className = 'vk7tv-doc-anim';
      anim.muted = true;
      anim.loop = true;
      anim.playsInline = true;
      anim.preload = 'auto';
      anim.setAttribute('playsinline', '');
      anim.style.display = 'none';
      anim.addEventListener(
        'loadeddata',
        () => {
          if (cell._mediaKey !== key) return;
          cell._mediaReady = true;
          observeDocMedia(cell);
          cell._vkVisible = docCellInView(cell);
          setDocAnimVisible(cell, cell._vkVisible && mediaPlaybackAllowed());
        },
        { once: true }
      );
      anim.addEventListener('error', () => handleDocAnimError(cell, 'video'), { once: true });
      anim.src = rec.url;
      media.appendChild(anim);
      if (anim.load) anim.load();
    } else {
      anim = document.createElement('img');
      anim.className = 'vk7tv-doc-anim';
      anim.alt = doc.title;
      anim.title = doc.title;
      anim.decoding = 'async';
      anim.draggable = false;
      anim.style.display = 'none';
      anim.addEventListener(
        'load',
        () => {
          if (cell._mediaKey !== key) return;
          cell._mediaReady = true;
          observeDocMedia(cell);
          cell._vkVisible = docCellInView(cell);
          setDocAnimVisible(cell, cell._vkVisible && mediaPlaybackAllowed());
        },
        { once: true }
      );
      anim.addEventListener('error', () => handleDocAnimError(cell, 'image'), { once: true });
      anim.src = rec.url;
      media.appendChild(anim);
    }
  }

  function activateDocMedia(cell, forceOriginal) {
    if (!cell || !DOCS || !DOCS_MEDIA) return;
    if (cell._mediaReady || cell._mediaPending) return;
    const doc = DOCS.getDocument(cell.dataset.key);
    if (!doc) return;
    const st = docsSnapshot();
    if (!st) return;
    const account = docsAccountKey(st);
    const source = mediaSourceFor(doc, forceOriginal || cell._mediaTriedOriginal);
    if (!source) return;

    const acq = DOCS_MEDIA.acquire(account, doc, source);
    if (!acq || !acq.key) {
      if (acq && acq.promise) acq.promise.catch(() => {});
      return;
    }
    if (acq.record && acq.record.state === 'error') {
      DOCS_MEDIA.release(acq.key);
      if (!forceOriginal && doc.ext === 'gif' && doc.url && !cell._mediaTriedOriginal) {
        cell._mediaTriedOriginal = true;
        activateDocMedia(cell, true);
      }
      return;
    }

    cell._mediaPending = acq.key;
    acq.promise
      .then((rec) => {
        if (cell._mediaPending !== acq.key) return;
        if (!cell.parentNode || cell.dataset.key !== doc.key) {
          cell._mediaPending = '';
          DOCS_MEDIA.release(acq.key);
          return;
        }
        if (!docsGrid || !docsGrid.contains(cell)) {
          cell._mediaPending = '';
          DOCS_MEDIA.release(acq.key);
          return;
        }
        const nowSt = docsSnapshot();
        if (!nowSt || docsAccountKey(nowSt) !== account || !rec || rec.state !== 'ready') {
          cell._mediaPending = '';
          DOCS_MEDIA.release(acq.key);
          return;
        }
        showDocRecord(cell, doc, source, rec, account, acq.key);
      })
      .catch(() => {
        if (cell._mediaPending === acq.key) cell._mediaPending = '';
        DOCS_MEDIA.release(acq.key);
      });
  }

  // Карточка, пересозданная после поиска или сворачивания, сразу берёт
  // готовый источник из кэша. Новую загрузку это не запускает.
  function applyReadyDocMedia(cell, doc) {
    if (!DOCS || !DOCS_MEDIA || !cell || !doc) return;
    const st = docsSnapshot();
    if (!st) return;
    const account = docsAccountKey(st);
    const preferred = mediaSourceFor(doc, cell._mediaTriedOriginal);
    const rec = preferred && DOCS_MEDIA.peek(account, doc, preferred);
    if (rec && (rec.state === 'ready' || rec.state === 'loading')) {
      activateDocMedia(cell, !!cell._mediaTriedOriginal);
      return;
    }
    if (!cell._mediaTriedOriginal && doc.ext === 'gif' && doc.video && doc.url) {
      const original = mediaSourceFor(doc, true);
      const orig = original && DOCS_MEDIA.peek(account, doc, original);
      if (orig && (orig.state === 'ready' || orig.state === 'loading')) {
        cell._mediaTriedOriginal = true;
        activateDocMedia(cell, true);
      }
    }
  }

  function docsCountText() {
    const st = docsSnapshot();
    if (!st || st.status === 'idle') return '…';
    if (!st.totalDocuments && (st.status === 'error' || st.status === 'unauthorized')) {
      return '—';
    }
    if (st.status === 'loading' && !st.totalDocuments) return '…';
    if (st.loading && !st.totalDocuments) return '…';
    return `${st.count}${st.partial ? '+' : ''}`;
  }

  function docsStatusText() {
    const st = docsSnapshot();
    if (!st) return 'Не удалось загрузить файлы';
    if (st.status === 'unauthorized' || (st.error && st.error.kind === 'auth')) {
      return (
        (st.error && st.error.message) ||
        'VK не подтвердил вход расширения. Обнови страницу VK и повтори загрузку.'
      );
    }
    if (st.error) {
      if (st.error.search && st.totalDocuments) return 'Поиск выполнен не полностью';
      if (st.error.message) return st.error.message;
      return 'Не удалось загрузить остальные файлы';
    }
    if (st.query && !st.loaded) return 'Поиск по остальным файлам…';
    if (st.query && st.loaded && st.count === 0) return 'Ничего не найдено';
    if (st.loading && !st.totalDocuments) return 'Загружаем файлы…';
    if (st.status === 'empty') return 'В документах нет файлов';
    return '';
  }

  function docsLoadingVisible(st) {
    return !!st && st.loading && st.totalDocuments > 0 && !st.query && !st.error;
  }

  function setDocsCollapsed(next) {
    docsCollapsed = !!next;
    cancelDocHold('collapse');
    if (docsCollapsed) collapsedKeys.add(DOCS_KEY);
    else collapsedKeys.delete(DOCS_KEY);
    chrome.storage.local.set({ collapsedGroups: [...collapsedKeys] });
    if (docsCollapsed) {
      try {
        if (DOCS) DOCS.setPaused(true);
      } catch (e) {}
      pauseDocMedia();
      if (docsObserver) docsObserver.disconnect();
    } else if (DOCS) {
      try {
        DOCS.checkAuth();
        DOCS.setPaused(false);
      } catch (e) {}
    }
    renderDocsSection();
    if (!docsCollapsed) resumeDocMedia();
  }

  function toggleDocs() {
    setDocsCollapsed(!docsCollapsed);
    if (docsCollapsed) return;
    ensureDocsLoad();
  }

  function ensureDocsLoad() {
    if (!DOCS || docsCollapsed || !open) return;
    try {
      const st = DOCS.getState();
      if (st.error) return; // автоматически после ошибки не повторяем
      if (st.status === 'unauthorized' && !DOCS.checkAuth()) return;
      if (st.loaded || st.paused) return;
      if (searchInput && searchInput.value.trim()) DOCS.loadAll();
      else DOCS.loadMore();
    } catch (e) {
      // сбой загрузки файлов не должен мешать эмоутам
    }
  }

  function docSentinelInZone() {
    if (!docsSentinel || !body) return false;
    const br = body.getBoundingClientRect();
    const sr = docsSentinel.getBoundingClientRect();
    return sr.bottom >= br.top - 400 && sr.top <= br.bottom + 400;
  }

  function maybeLoadNext() {
    if (!DOCS || !open || docsCollapsed || !docsSentinel) return;
    const st = docsSnapshot();
    if (!st || st.loaded || st.loading || st.paused || st.error) return;
    if (st.status === 'unauthorized' || st.query) return;
    if (!docSentinelInZone()) return;
    try {
      DOCS.loadMore();
    } catch (e) {
      // следующая страница не должна ломать уже показанные файлы
    }
  }

  function setDocsRefreshBusy(busy) {
    docsRefreshBusy = !!busy;
    if (!docsRefresh) return;
    docsRefresh.disabled = docsRefreshBusy;
    docsRefresh.classList.toggle('vk7tv-docs-refresh-busy', docsRefreshBusy);
    if (docsRefreshBusy) docsRefresh.setAttribute('aria-busy', 'true');
    else docsRefresh.removeAttribute('aria-busy');
  }

  function refreshDocs() {
    if (!DOCS || docsRefreshBusy) return;
    if (docsCollapsed) setDocsCollapsed(false);
    setDocsRefreshBusy(true);
    let job;
    try {
      DOCS.checkAuth();
      DOCS.setPaused(false);
      job = DOCS.refresh();
    } catch (e) {
      setDocsRefreshBusy(false);
      flash('Не удалось обновить файлы');
      queueDocsRender();
      return;
    }
    Promise.resolve(job)
      .then(() => {
        if (DOCS && searchInput.value.trim()) DOCS.loadAll();
      })
      .catch(() => {})
      .finally(() => {
        setDocsRefreshBusy(false);
        queueDocsRender();
      });
    queueDocsRender();
  }

  // Пересобираем только секцию файлов: тысячи ячеек 7TV и прокрутка
  // списка при обновлении документов не должны страдать.
  function queueDocsRender() {
    if (docsRenderQueued) return;
    docsRenderQueued = true;
    requestAnimationFrame(() => {
      docsRenderQueued = false;
      try {
        renderDocsSection();
      } catch (e) {
        // сбой раздела файлов не должен ломать эмоуты
      }
    });
  }

  function buildDocsSection() {
    const sec = document.createElement('div');
    sec.className = 'vk7tv-picker-group vk7tv-docs-group';
    sec._vk7tvDocs = true;

    const head = document.createElement('div');
    head.className = 'vk7tv-picker-group-title';
    head.title = 'Свернуть или развернуть файлы';
    const chevron = document.createElement('span');
    chevron.className = 'vk7tv-picker-chevron';
    chevron.textContent = '▾';
    const name = document.createElement('span');
    name.className = 'vk7tv-picker-group-name';
    name.textContent = 'Файлы';
    const count = document.createElement('span');
    count.className = 'vk7tv-picker-group-count';
    count.textContent = docsCountText();
    const refresh = document.createElement('button');
    refresh.className = 'vk7tv-docs-refresh';
    refresh.type = 'button';
    refresh.title = 'Обновить список файлов';
    refresh.setAttribute('aria-label', 'Обновить список файлов');
    refresh.dataset.action = 'refresh';
    refresh.appendChild(refreshIcon());

    const upload = document.createElement('button');
    upload.className = 'vk7tv-docs-upload';
    upload.type = 'button';
    upload.title = 'Загрузить файлы в документы VK';
    upload.setAttribute('aria-label', 'Загрузить файлы в документы VK');
    upload.dataset.action = 'upload';
    upload.appendChild(uploadIcon());
    head.append(chevron, name, count, refresh, upload);

    // Лента загрузок живёт под шапкой «Файлов» и не прячется вместе с
    // сеткой: результат должен быть виден и при свёрнутом разделе.
    const uploads = document.createElement('div');
    uploads.className = 'vk7tv-docs-uploads';
    uploads.style.display = 'none';
    docsUploadsLive = document.createElement('div');
    docsUploadsLive.className = 'vk7tv-sr-only';
    docsUploadsLive.setAttribute('aria-live', 'polite');
    uploads.appendChild(docsUploadsLive);

    const batch = buildDocsBatch();

    const status = document.createElement('div');
    status.className = 'vk7tv-docs-status';
    const statusText = document.createElement('span');
    statusText.className = 'vk7tv-docs-status-text';
    const retry = document.createElement('button');
    retry.className = 'vk7tv-docs-action';
    retry.type = 'button';
    retry.textContent = 'Повторить';
    retry.style.display = 'none';
    status.append(statusText, retry);


    const grid = document.createElement('div');
    grid.className = 'vk7tv-picker-grid vk7tv-docs-grid';
    const tail = document.createElement('div');
    tail.className = 'vk7tv-docs-loading';
    tail.textContent = 'Загружаем файлы…';
    tail.style.display = 'none';
    const sentinel = document.createElement('div');
    sentinel.className = 'vk7tv-docs-sentinel';

    sec.append(head, uploads, batch, status, grid, tail, sentinel);

    docsSection = sec;
    docsGrid = grid;
    docsStatus = status;
    docsStatus._text = statusText;
    docsStatus._retry = retry;
    docsCount = count;
    docsLoadingTail = tail;
    docsRefresh = refresh;
    docsUploadsBox = uploads;
    docsUploadRows = new Map();
    docsUploadAnnounced = new Map();
    bindUploadActions();
    docsSentinel = sentinel;
    docsRenderedQuery = null;
    docsRenderedGen = -1;
    docsRenderedVersion = -1;
    docsRenderedKeys = new Set();
    setDocsRefreshBusy(docsRefreshBusy);

    if (!docsObserver) {
      docsObserver = new IntersectionObserver(
        (entries) => {
          if (!open || docsCollapsed || !DOCS) return;
          if (!entries.some((e) => e.isIntersecting)) return;
          const st = DOCS.getState();
          if (st.loaded || st.loading || st.error || st.status === 'unauthorized' || st.paused) {
            return;
          }
          ensureDocsLoad();
        },
        { root: body, rootMargin: '400px 0px' }
      );
    }

    if (DOCS && !docsSubscribed) {
      docsSubscribed = true;
      // Сетку пересобираем через кадр, а ленту загрузок обновляем сразу:
      // проценты и результат должны быть видны и без ожидания отрисовки.
      DOCS.subscribe((st) => {
        try {
          renderUploadQueue(st);
        } catch (e) {
          // сбой ленты не должен ломать раздел
        }
      });
      DOCS.subscribe(queueDocsRender);
    }
    return sec;
  }

  function uploadStageText(job) {
    switch (job.stage) {
      case 'queued':
        return 'В очереди';
      case 'checking':
        return 'Проверка файла';
      case 'converting':
        return job.convertedTotal > 0
          ? `Преобразование в GIF: кадр ${job.convertedFrame} из ${job.convertedTotal}`
          : 'Преобразование в GIF';
      case 'server':
        return 'Получение адреса загрузки VK';
      case 'uploading': {
        const seconds = job.transferIdleSeconds || 0;
        const wait = seconds > 0 ? ` · ожидание ${seconds} с` : '';
        if (job.total > 0 && job.loaded >= job.total) {
          return 'Файл передан · ожидание ответа VK' + wait;
        }
        if (!job.loaded) return 'Подключение к VK' + wait;
        if (job.total > 0) {
          const percent = Math.max(0, Math.min(100, Math.round((job.loaded / job.total) * 100)));
          return `Передача в VK: ${percent}% · ${formatBytes(job.loaded)} из ${formatBytes(job.total)}` +
            (seconds >= 3 ? ` · нет прогресса ${seconds} с` : '');
        }
        return 'Передача в VK' + wait;
      }
      case 'saving':
        return 'Сохранение в VK';
      case 'success':
        return 'Загружено в документы VK';
      case 'unconfirmed':
        return (
          job.note ||
          'Не удалось подтвердить сохранение — повтор сначала проверит документы VK'
        );
      case 'canceled':
        return job.error && job.error.message
          ? 'Отменено: ' + job.error.message
          : 'Отменено';
      default:
        return job.error && job.error.message ? job.error.message : 'Ошибка';
    }
  }

  function formatBytes(value) {
    const size = Number(value) || 0;
    if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' МБ';
    if (size >= 1024) return Math.round(size / 1024) + ' КБ';
    return size + ' Б';
  }

  function uploadFiltered(job) {
    if (job.stage !== 'success' || !job.docKey || !DOCS) return false;
    const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (!q) return false;
    const doc = DOCS.getDocument(job.docKey);
    return !!doc && !doc.title.toLowerCase().includes(q);
  }

  function uploadRow(id) {
    let row = docsUploadRows.get(id);
    if (row) return row;
    const box = document.createElement('div');
    box.className = 'vk7tv-docs-upload-row';
    box.dataset.uploadId = id;
    const name = document.createElement('span');
    name.className = 'vk7tv-docs-upload-name';
    const stage = document.createElement('span');
    stage.className = 'vk7tv-docs-upload-stage';
    const hint = document.createElement('span');
    hint.className = 'vk7tv-docs-upload-hint';
    hint.style.display = 'none';
    const actions = document.createElement('span');
    actions.className = 'vk7tv-docs-upload-actions';
    box.append(name, stage, hint, actions);
    row = { box, name, stage, hint, actions, buttons: new Map() };
    docsUploadRows.set(id, row);
    return row;
  }

  function uploadButton(row, action, label) {
    let button = row.buttons.get(action);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'vk7tv-docs-upload-action';
      button.dataset.uploadAction = action;
      row.buttons.set(action, button);
      row.actions.appendChild(button);
    }
    button.dataset.uploadAction = action;
    button.textContent = label;
    button.style.display = '';
    return button;
  }

  function renderUploadQueue(st) {
    if (!docsUploadsBox) return;
    const jobs = st && Array.isArray(st.uploads) ? st.uploads : [];
    if (!jobs.length) {
      docsUploadsBox.style.display = 'none';
      for (const row of docsUploadRows.values()) row.box.remove();
      docsUploadRows = new Map();
      docsUploadAnnounced = new Map();
      const note = docsUploadsBox.querySelector('.vk7tv-docs-uploads-note');
      if (note) note.remove();
      if (docsUploadsLive) docsUploadsLive.textContent = '';
      return;
    }

    docsUploadsBox.style.display = '';
    const alive = new Set();
    for (const job of jobs) {
      alive.add(job.id);
      const row = uploadRow(job.id);
      if (!row.box.isConnected) docsUploadsBox.appendChild(row.box);
      row.name.textContent = job.name;
      row.name.title =
        (job.originalName && job.originalName !== job.name
          ? job.originalName + ' → '
          : '') +
        job.name +
        (job.size ? ' · ' + formatBytes(job.size) : '');
      let text = uploadStageText(job);
      const filtered = uploadFiltered(job);
      if (filtered) text = 'Файл загружен, но скрыт поиском';
      row.stage.textContent = text;
      row.stage.title = text;
      const hint = job.note || '';
      row.hint.textContent = hint;
      row.hint.title = hint;
      row.hint.style.display = hint ? '' : 'none';
      row.box.classList.toggle('is-error', job.stage === 'error' || job.stage === 'unconfirmed');
      row.box.classList.toggle('is-success', job.stage === 'success' && !filtered);
      row.box.classList.toggle('is-muted', job.stage === 'canceled');
      row.box.classList.toggle('is-converting', job.stage === 'converting');

      for (const button of row.buttons.values()) button.style.display = 'none';
      if (job.canCancel) uploadButton(row, 'cancel', 'Отменить');
      if (job.canRetry) {
        // Для неподтверждённого сохранения повтор сначала проверяет
        // библиотеку, чтобы не создать дубликат.
        const button = uploadButton(
          row,
          'retry',
          job.stage === 'unconfirmed' ? 'Проверить и повторить' : 'Повторить'
        );
        if (job.stage === 'unconfirmed') {
          button.title = 'Сначала проверит, не сохранился ли документ, затем повторит';
        } else {
          button.removeAttribute('title');
        }
      }
      if (job.stage === 'unconfirmed') uploadButton(row, 'verify', 'Проверить библиотеку');
      if (job.canUploadOriginal) {
        const button = uploadButton(row, 'upload-original', 'Загрузить исходное видео');
        button.title = 'Отправить исходный MP4 без преобразования в GIF';
      }
      if (filtered) uploadButton(row, 'clear-search', 'Очистить поиск');
      if (job.canDismiss) uploadButton(row, 'dismiss', 'Скрыть');

      const announceKey = `${job.stage}|${text}|${job.error ? job.error.message : ''}`;
      if (job.stage !== 'queued' && job.stage !== 'checking' && job.stage !== 'converting' &&
          job.stage !== 'server' && job.stage !== 'uploading' && job.stage !== 'saving') {
        if (docsUploadAnnounced.get(job.id) !== announceKey) {
          docsUploadAnnounced.set(job.id, announceKey);
          if (docsUploadsLive) {
            docsUploadsLive.textContent =
              `${job.name}: ${text}` +
              (job.stage === 'unconfirmed' ? ' Повтор сначала проверит документы VK.' : '');
          }
        }
      } else {
        docsUploadAnnounced.delete(job.id);
      }
    }

    for (const [id, row] of [...docsUploadRows]) {
      if (alive.has(id)) continue;
      row.box.remove();
      docsUploadRows.delete(id);
      docsUploadAnnounced.delete(id);
    }

    if (st && st.uploadsPaused && st.uploadsPaused.kind === 'auth') {
      let note = docsUploadsBox.querySelector('.vk7tv-docs-uploads-note');
      if (!note) {
        note = document.createElement('div');
        note.className = 'vk7tv-docs-uploads-note';
      }
      note.textContent = st.uploadsPaused.message;
      docsUploadsBox.appendChild(note);
    } else {
      const note = docsUploadsBox.querySelector('.vk7tv-docs-uploads-note');
      if (note) note.remove();
    }
  }

  function bindUploadActions() {
    if (!docsUploadsBox) return;
    docsUploadsBox.addEventListener('click', (e) => {
      const button = e.target.closest('.vk7tv-docs-upload-action');
      if (!button) return;
      e.preventDefault();
      e.stopPropagation();
      const row = button.closest('.vk7tv-docs-upload-row');
      const id = row && row.dataset.uploadId;
      if (!id || !DOCS) return;
      const action = button.dataset.uploadAction;
      if (action === 'cancel') DOCS.cancelUpload(id);
      else if (action === 'retry') DOCS.retryUpload(id);
      else if (action === 'upload-original') DOCS.uploadOriginal(id);
      else if (action === 'dismiss') DOCS.dismissUpload(id);
      else if (action === 'verify') refreshDocs();
      else if (action === 'clear-search') {
        searchInput.value = '';
        applyFilter();
      }
    });
  }

  function syncDocsMediaSession(st) {
    if (!DOCS_MEDIA || !st) return;
    const epoch = st.accountEpoch || 0;
    if (docsMediaEpoch === null) {
      docsMediaEpoch = epoch;
      return;
    }
    if (epoch !== docsMediaEpoch) {
      docsMediaEpoch = epoch;
      hidePreview();
      resetDrop();
      cleanupDocCells();
      DOCS_MEDIA.clear();
    }
  }

  function renderDocsSection() {
    if (!docsSection || !docsSection.isConnected) return;
    const st = docsSnapshot();
    syncDocsMediaSession(st);
    syncDocDeleteSession(st);
    docsSection.classList.toggle('vk7tv-collapsed', docsCollapsed);
    if (docsCount) docsCount.textContent = docsCountText();
    renderUploadQueue(st);

    if (!docsStatus) return;
    const retry = docsStatus._retry;
    if (docsCollapsed) {
      docsStatus.style.display = 'none';
      if (docsLoadingTail) docsLoadingTail.style.display = 'none';
      if (docsObserver) docsObserver.disconnect();
      return;
    }

    if (st && DOCS && DOCS_MEDIA) {
      try {
        DOCS_MEDIA.retainDocs(docsAccountKey(st), DOCS.getItems());
      } catch (e) {
        // кэш не должен ломать отрисовку
      }
    }

    docsStatus.style.display = 'flex';
    const text = docsStatusText();
    docsStatus._text.textContent = text;
    const showRetry = !!st && !!st.error && !st.loading && st.error.kind !== 'auth';
    retry.style.display = showRetry ? '' : 'none';
    retry.textContent = 'Повторить';
    retry.dataset.action = 'retry';
    if (!text && !showRetry) docsStatus.style.display = 'none';

    if (docsLoadingTail) {
      docsLoadingTail.style.display = docsLoadingVisible(st) ? '' : 'none';
    }

    if (docsCollapsed) return;
    // Обновление прогресса загрузки не меняет библиотеку: сетку трогаем
    // только когда изменился её состав.
    if (st && st.libraryVersion !== docsRenderedVersion) renderDocsGrid();
    else {
      observeDocs();
      maybeLoadNext();
    }
    refreshDocDeleteStates(st);
    if (DOCS && st && st.status === 'idle') ensureDocsLoad();
  }

  function renderDocsGrid() {
    const token = ++docsBuildToken;
    if (!docsGrid) return;
    if (!DOCS || docsCollapsed) {
      cancelDocHold('rebuild');
      cleanupDocCells();
      docsGrid.innerHTML = '';
      docsRenderedQuery = null;
      docsRenderedGen = -1;
      docsRenderedVersion = -1;
      docsRenderedKeys = new Set();
      return;
    }

    const st = docsSnapshot();
    const q = searchInput ? searchInput.value : '';
    let found = [];
    try {
      found = DOCS.filterItems(q);
    } catch (e) {
      found = [];
    }
    const gen = st ? st.generation : -1;
    if (docsRenderedQuery !== q || docsRenderedGen !== gen) {
      cancelDocHold('rebuild');
      if (selCell && selCell.classList.contains('vk7tv-doc-cell')) selectCell(null);
      cleanupDocCells();
      docsGrid.innerHTML = '';
      docsRenderedQuery = q;
      docsRenderedGen = gen;
      docsRenderedKeys = new Set();
    }
    if (selCell && selCell.classList.contains('vk7tv-doc-cell')) {
      if (!found.some((d) => d.key === selCell.dataset.key)) selectCell(null);
    }

    // Удалённые ключи убираем из уже нарисованной сетки. Раньше инкрементальный
    // рендер только добавлял карточки, и удалённый документ оставался висеть
    // до полной пересборки.
    const present = new Set(found.map((doc) => doc.key));
    let removed = false;
    for (const cell of [...docsGrid.querySelectorAll('.vk7tv-doc-cell')]) {
      const key = cell.dataset.key;
      if (present.has(key)) continue;
      removed = true;
      if (previewCell === cell) hidePreview();
      if (selCell === cell) selectCell(null);
      const holdCell = docHoldCell(docHold);
      if (holdCell === cell) cancelDocHold('removed');
      cleanupDocCell(cell);
      cell.remove();
      docsRenderedKeys.delete(key);
    }

    docsRenderedVersion = st ? st.libraryVersion : -1;
    const fresh = found.filter((d) => !docsRenderedKeys.has(d.key));
    if (!fresh.length) {
      if (removed) refreshDocDeleteStates(st);
      observeDocs();
      maybeLoadNext();
      return;
    }

    // Новая локальная загрузка встаёт в начало, а серверные страницы
    // дописываются в конец. Ставим ячейку перед ближайшей уже нарисованной,
    // которая идёт после неё, вместо полной пересборки сетки.
    function placeCell(cell, doc) {
      const start = found.indexOf(doc) + 1;
      for (let i = start; i < found.length; i++) {
        const next = docsGrid.querySelector(
          `.vk7tv-doc-cell[data-key="${CSS.escape(found[i].key)}"]`
        );
        if (next) {
          docsGrid.insertBefore(cell, next);
          return;
        }
      }
      docsGrid.appendChild(cell);
    }

    let at = 0;
    const step = () => {
      if (token !== docsBuildToken) return;
      const frag = document.createDocumentFragment();
      let budget = CHUNK;
      const initial = docsRenderedKeys.size === 0;
      while (at < fresh.length && budget > 0) {
        const doc = fresh[at];
        docsRenderedKeys.add(doc.key);
        const cell = makeDocCell(doc);
        if (initial) frag.appendChild(cell);
        else placeCell(cell, doc);
        at++;
        budget--;
      }
      if (frag.childNodes.length) docsGrid.appendChild(frag);
      if (at < fresh.length) requestAnimationFrame(step);
      else {
        observeDocs();
        maybeLoadNext();
      }
    };
    step();
  }

  function observeDocs() {
    if (!docsObserver || !docsSentinel || docsCollapsed || !open) return;
    docsObserver.disconnect();
    docsObserver.observe(docsSentinel);
  }

  function docImageFailed(img) {
    const cell = img.closest('.vk7tv-doc-cell');
    // Поздняя ошибка старого постера не должна скрывать уже готовую анимацию.
    if (!cell || cell._mediaReady) return;
    const doc = DOCS ? DOCS.getDocument(cell.dataset.key) : null;
    const staticImage =
      doc && (doc.ext === 'png' || doc.ext === 'jpg' || doc.ext === 'jpeg');
    // Миниатюра могла отвалиться, а оригинал ещё доступен: пробуем один раз.
    if (
      staticImage &&
      doc.url &&
      !img.dataset.triedOriginal &&
      img.currentSrc !== doc.url &&
      img.src !== doc.url
    ) {
      img.dataset.triedOriginal = '1';
      img.src = doc.url;
      return;
    }
    img.dataset.failed = '1';
    img.style.display = 'none';
    const fallback = cell.querySelector('.vk7tv-doc-fallback');
    if (fallback) fallback.style.display = 'flex';
  }

  function activateCell(cell) {
    if (cell.classList.contains('vk7tv-doc-cell')) {
      attachDocFromCell(cell);
      return;
    }
    insertEmote(cell.dataset.name);
  }

  function flashContextError(context) {
    const reason = context && context.reason;
    if (reason === 'editing' || reason === 'unsupported') {
      flash('Здесь нельзя прикрепить файл — открой обычный диалог');
    } else if (reason === 'bad-doc') {
      flash('Не удалось прикрепить файл');
    } else {
      flash('Открой диалог в ВК, чтобы прикрепить файл');
    }
  }

  function attachDocFromCell(cell) {
    if (!DOCS) return;
    const key = cell.dataset.key;
    if (!key || docsAttaching.has(key)) return;
    const deletion = DOCS.getDeletion(key);
    if (deletion && deletion.status === 'pending') {
      flash('Документ удаляется');
      return;
    }
    docsAttaching.add(key);
    cell.classList.add('vk7tv-doc-busy');

    // Контекст берём в момент клика, а не когда дойдёт очередь: иначе
    // переключение чата до начала операции прикрепило бы файл в новый чат.
    let contextPromise;
    try {
      contextPromise = DOCS.composer.getContext();
    } catch (e) {
      contextPromise = Promise.resolve({ ok: false, reason: 'error' });
    }

    // Разные документы добавляем строго по очереди: ВК меняет один и тот же
    // черновик, и параллельные dispatch-и могли потерять вложение.
    const job = docsAttachQueue.then(async () => {
      let doc = null;
      try {
        doc = DOCS.getDocument(key);
      } catch (e) {
        doc = null;
      }
      if (!doc) {
        flash('Файл больше не доступен');
        return;
      }
      const context = await contextPromise;
      if (!context.ok) {
        flashContextError(context);
        return;
      }
      await attachDocNow(doc, context);
    });
    docsAttachQueue = job.catch(() => {});
    job.finally(() => {
      docsAttaching.delete(key);
      cell.classList.remove('vk7tv-doc-busy');
    });
  }

  async function attachDocNow(doc, context) {
    try {
      if (!DOCS.checkAuth()) {
        const state = DOCS.getState();
        flash(
          (state.error && state.error.message) ||
            'Расширение не видит вход VK на этой странице. Обнови страницу VK и повтори.'
        );
        return;
      }

      // Пока файл ждал своей очереди, могли сменить аккаунт или обновить
      // список. Прикрепляем только документ, который всё ещё принадлежит
      // текущей сессии.
      const current = DOCS.getDocument(doc.key);
      if (!current) {
        flash('Файл больше не доступен');
        return;
      }
      doc = current;

      const deletion = DOCS.getDeletion(doc.key);
      if (deletion && deletion.status === 'pending') {
        flash('Документ удаляется');
        return;
      }

      const state = DOCS.getState();
      if (!context || !context.ok) {
        flashContextError(context);
        return;
      }

      if (state.auth.userId && context.userId && state.auth.userId !== context.userId) {
        DOCS.checkAuth();
        flash('Аккаунт сменился — файл не прикреплён');
        return;
      }

      const result = await DOCS.composer.attach(context, doc);
      if (result.ok && result.status === 'added') {
        flash('Файл прикреплён');
        return;
      }
      if (result.ok && result.status === 'already') {
        flash('Файл уже прикреплён');
        return;
      }
      if (result.reason === 'stale-context') {
        flash('Чат сменился — файл не прикреплён');
        return;
      }
      if (result.reason === 'not-added') {
        flash('Не удалось прикрепить файл — возможно, достигнут лимит вложений');
        return;
      }
      if (result.reason === 'no-fastchat' || result.reason === 'no-peer' || result.reason === 'no-editor') {
        flash('Открой диалог в ВК, чтобы прикрепить файл');
        return;
      }
      if (result.reason === 'editing' || result.reason === 'unsupported') {
        flash('Здесь нельзя прикрепить файл — открой обычный диалог');
        return;
      }
      flash('ВК не принял файл — попробуй ещё раз');
    } catch (e) {
      flash('ВК не принял файл — попробуй ещё раз');
    }
  }

  function bindGrid() {
    picker.addEventListener('click', (e) => {
      const remove = e.target.closest('.vk7tv-doc-delete');
      if (remove) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const verify = e.target.closest('.vk7tv-doc-verify');
      if (verify) {
        e.preventDefault();
        e.stopPropagation();
        const cell = verify.closest('.vk7tv-doc-cell');
        const key = cell && cell.dataset.key;
        if (key && DOCS) {
          DOCS.verifyDeletion(key)
            .then((answer) => {
              if (!answer) return;
              if (answer.found) flash('Документ не удалён');
              else if (answer.deleted) flash('Документ удалён из документов VK');
              else if (answer.reason === 'incomplete') flash('Не удалось проверить библиотеку');
            })
            .catch(() => {});
        }
        return;
      }
      const star = e.target.closest('.vk7tv-fav');
      if (star) {
        e.stopPropagation();
        toggleFav(star.parentElement.dataset.name);
        return;
      }
      const docsAction = e.target.closest(
        '.vk7tv-docs-action, .vk7tv-docs-refresh, .vk7tv-docs-upload'
      );
      if (docsAction) {
        e.preventDefault();
        e.stopPropagation();
        if (docsAction.dataset.action === 'refresh') refreshDocs();
        else if (docsAction.dataset.action === 'upload') {
          if (!DOCS) flash('Не удалось загрузить файлы');
          else {
            docsUploadInput.value = '';
            docsUploadInput.click();
          }
        } else if (DOCS) {
          DOCS.setPaused(false);
          if (searchInput.value.trim()) DOCS.loadAll();
          else DOCS.loadMore();
        }
        return;
      }
      const head = e.target.closest('.vk7tv-picker-group-title');
      if (head) {
        if (justDragged) justDragged = false; // это хвост перетаскивания
        else if (head.parentElement.classList.contains('vk7tv-docs-group')) toggleDocs();
        else toggleGroup(head.parentElement);
        return;
      }
      const cell = e.target.closest('.vk7tv-picker-cell');
      if (!cell) return;
      // зажали ради превью — вставлять не надо
      if (previewShown) {
        previewShown = false;
        return;
      }
      activateCell(cell);
    });

    // Фокус не забираем: вставка идёт в поле ВК, а перебор стрелками — из
    // поиска, и клик по ячейке не должен его гасить. Уголок ресайза сюда
    // не попадает — иначе поповер перестал бы растягиваться.
    const NO_FOCUS =
      '.vk7tv-fav, .vk7tv-picker-group-title, .vk7tv-strip-tab, .vk7tv-picker-cell, ' +
      '.vk7tv-docs-action, .vk7tv-docs-refresh, .vk7tv-docs-upload, ' +
      '.vk7tv-docs-upload-action';

    // Наведение на файл сразу запускает загрузку анимации и открывает
    // большое превью. Задержек нет: документы не участвуют в удержании
    // кнопки, и ожидание здесь только мешало.
    picker.addEventListener('pointerover', (e) => {
      const remove = e.target.closest('.vk7tv-doc-delete');
      if (remove) {
        const docCell = remove.closest('.vk7tv-doc-cell');
        if (docCell && previewCell === docCell) hidePreview();
        return;
      }
      const cell = e.target.closest('.vk7tv-doc-cell');
      if (!cell) return;
      if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
      activateDocMedia(cell, false);
      showDocPreview(cell);
    });
    picker.addEventListener('pointerout', (e) => {
      const cell = e.target.closest('.vk7tv-doc-cell');
      if (!cell) return;
      if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
      // Переход на соседнюю карточку сразу переключит превью новым
      // pointerover; здесь закрываем только уход из сетки.
      const next =
        e.relatedTarget && e.relatedTarget.closest
          ? e.relatedTarget.closest('.vk7tv-doc-cell')
          : null;
      if (next && next !== cell) return;
      if (previewCell === cell && !pressing) hidePreview();
    });

    picker.addEventListener('pointerdown', (e) => {
      const remove = e.target.closest('.vk7tv-doc-delete');
      if (remove) {
        e.stopPropagation();
        if (e.button !== 0) return;
        if (startDocHold(remove, e, 'pointer') && e.pointerType === 'mouse') {
          e.preventDefault();
        }
        return;
      }
      if (e.target.closest('.vk7tv-doc-verify')) {
        e.stopPropagation();
        return;
      }
      if (e.target.closest(NO_FOCUS)) e.preventDefault();
      if (e.target.closest('.vk7tv-fav')) return; // звезда превью не открывает
      if (e.target.closest('.vk7tv-docs-action, .vk7tv-docs-refresh, .vk7tv-docs-upload')) {
        return;
      }
      const head = e.target.closest('.vk7tv-picker-group-title');
      if (head) {
        if (e.button === 0) dragStart(head, e);
        return;
      }
      const cell = e.target.closest('.vk7tv-picker-cell');
      if (!cell) return;
      // У документа превью уже открыто наведением; клик должен прикреплять.
      if (cell.classList.contains('vk7tv-doc-cell')) {
        previewShown = false;
        pressing = false;
        return;
      }
      previewShown = false;
      pressing = true;
      armedCell = cell;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showPreview(cell), PREVIEW_DELAY);
    });

    // Поиск, прокрутка и пересборка карточки отменяют удержание. Эти
    // события приходят мимо кнопки, поэтому слушаем их отдельно.
    picker.addEventListener('pointermove', (e) => {
      const hold = docHold;
      if (!hold || hold.source !== 'pointer' || !hold.button) return;
      if (hold.pointerId != null && e.pointerId !== hold.pointerId) return;
      const r = hold.button.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      ) {
        if (docNow() - hold.startedAt >= DOC_DELETE_HOLD_MS) finishDocHold(hold);
        else cancelDocHold('outside');
      }
    });
    picker.addEventListener(
      'pointerout',
      (e) => {
        const hold = docHold;
        if (!hold || hold.source !== 'pointer' || hold.button !== e.target) return;
        if (e.relatedTarget && hold.button.contains(e.relatedTarget)) return;
        if (docNow() - hold.startedAt >= DOC_DELETE_HOLD_MS) finishDocHold(hold);
        else cancelDocHold('outside');
      },
      true
    );
    picker.addEventListener(
      'lostpointercapture',
      (e) => {
        if (docHold && docHold.source === 'pointer' && docHold.button === e.target) {
          cancelDocHold('capture');
        }
      },
      true
    );
    document.addEventListener(
      'pointerup',
      (e) => {
        const hold = docHold;
        if (!hold || hold.source !== 'pointer') return;
        if (hold.pointerId != null && e.pointerId !== hold.pointerId) return;
        if (hold.done) return;
        // Таймер мог задержаться: секунда по монотонным часам уже прошла,
        // поэтому отпускание в этот момент не отменяет операцию.
        if (docNow() - hold.startedAt >= DOC_DELETE_HOLD_MS) finishDocHold(hold);
        else cancelDocHold('up');
      },
      true
    );
    document.addEventListener(
      'pointercancel',
      (e) => {
        const hold = docHold;
        if (!hold || hold.source !== 'pointer') return;
        if (hold.pointerId != null && e.pointerId !== hold.pointerId) return;
        cancelDocHold('cancel');
      },
      true
    );

    picker.addEventListener(
      'keydown',
      (e) => {
        const remove = e.target.closest('.vk7tv-doc-delete');
        if (!remove) return;
        if (e.key !== ' ' && e.key !== 'Enter' && e.code !== 'Space') return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const hold = docHold;
        if (hold) return;
        startDocHold(remove, e, 'keyboard');
        if (docHold) docHold.keyName = e.key;
      },
      true
    );
    document.addEventListener(
      'keyup',
      (e) => {
        const hold = docHold;
        if (!hold || hold.source !== 'keyboard') return;
        if (hold.keyName && e.key !== hold.keyName) return;
        if (!hold.done) cancelDocHold('keyup');
      },
      true
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && docHold) cancelDocHold('escape');
      },
      true
    );
    picker.addEventListener('focusout', (e) => {
      const hold = docHold;
      if (!hold || hold.source !== 'keyboard') return;
      if (e.target === hold.button) cancelDocHold('focus');
    });
    picker.addEventListener(
      'dblclick',
      (e) => {
        if (!e.target.closest('.vk7tv-doc-delete')) return;
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );

    body.addEventListener('scroll', () => cancelDocHold('scroll'), { passive: true });

    picker.addEventListener('pointermove', dragMove);
    picker.addEventListener('pointerup', dragEnd);
    picker.addEventListener('pointercancel', dragEnd);

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

        const docCell = img.closest('.vk7tv-doc-cell');
        if (docCell) {
          // Документ уже есть в VK, даже если превью не загрузилось:
          // ячейку не удаляем, оставляем расширение файла. Ошибка готовой
          // анимации обрабатывается отдельно и постер не трогает.
          if (img.classList.contains('vk7tv-doc-anim')) handleDocAnimError(docCell, 'image');
          else if (!img.dataset.failed) docImageFailed(img);
          return;
        }

        const cell = img.parentElement;
        if (!cell || !cell.classList.contains('vk7tv-picker-cell')) return;
        if (img.dataset.fb) return cell.remove();
        img.dataset.fb = '1';
        const st = window.__vk7tv;
        if (!st || !st.resolveEmote) {
          // на загрузке страницы контент-скрипт мог ещё не выложить состояние —
          // жалуемся только на честно отвалившуюся вкладку
          if (detached()) staleNote();
          return cell.remove();
        }
        const url = img.src;
        const name = cell.dataset.name;
        st.resolveEmote(url).then((u) => {
          if (!u) return cell.remove();
          img.src = u;
          // Запоминаем рабочий blob: — и полоса, и пересобранная сетка возьмут
          // его сразу, без заведомо мёртвого запроса к CDN. Адрес на CDN
          // оставляем рядом: из него берётся версия 4x для превью.
          const em = emoteIndex.get(name);
          if (em && em.u === url) {
            em.cdn = url;
            em.u = u;
          }
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

  function refreshIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const box = document.createElementNS(NS, 'path');
    box.setAttribute('d', 'M0 0h24v24H0z');
    box.setAttribute('fill', 'none');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute(
      'd',
      'M1.75 16.002C3.353 20.098 7.338 23 12 23c6.075 0 11-4.925 11-11m-.75-4.002C20.649 3.901 16.663 1 12 1C5.925 1 1 5.925 1 12m8 4H1v8M23 0v8h-8'
    );
    svg.append(box, path);
    return svg;
  }

  function uploadIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1024 1024');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const box = document.createElementNS(NS, 'path');
    box.setAttribute('d', 'M0 0h1024v1024H0z');
    box.setAttribute('fill', 'none');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute(
      'd',
      'M400 317.7h73.9V656c0 4.4 3.6 8 8 8h60c4.4 0 8-3.6 8-8V317.7H624c6.7 0 10.4-7.7 6.3-12.9L518.3 163a8 8 0 0 0-12.6 0l-112 141.7c-4.1 5.3-.4 13 6.3 13M878 626h-60c-4.4 0-8 3.6-8 8v154H214V634c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v198c0 17.7 14.3 32 32 32h684c17.7 0 32-14.3 32-32V634c0-4.4-3.6-8-8-8'
    );
    svg.append(box, path);
    return svg;
  }

  function deleteIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    svg.appendChild(path);
    return svg;
  }

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
    // порядок здесь свой — свежесть вставки и порядок добавления в избранное,
    // по размеру полосу не пересортировываем
    for (const name of stripTab === 'fav' ? favorites : recent) {
      const em = emoteIndex.get(name);
      if (!em) continue; // набор отключили — эмоут просто не показываем
      stripGrid.appendChild(makeCell(name, em));
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
  // что находки по поиску там есть. Стрелки двигают набор по списку;
  // у глобального набора и «своих» их нет — они стоят на своих местах.
  function groupTitle(g, count) {
    const h = document.createElement('div');
    h.className = 'vk7tv-picker-group-title';
    h.title = 'Свернуть или развернуть набор';
    const chevron = document.createElement('span');
    chevron.className = 'vk7tv-picker-chevron';
    chevron.textContent = '▾';
    const name = document.createElement('span');
    name.className = 'vk7tv-picker-group-name';
    name.textContent = g.title;
    const cnt = document.createElement('span');
    cnt.className = 'vk7tv-picker-group-count';
    cnt.textContent = count;
    h.append(chevron, name, cnt);
    if (g.setId) {
      h.classList.add('vk7tv-movable');
      h.title = 'Перетащи, чтобы поменять наборы местами; клик — свернуть';
    }
    return h;
  }

  // --- перетаскивание наборов ---

  let drag = null;
  let justDragged = false; // чтобы клик после перетаскивания не свернул набор

  // Секции наборов сверху вниз; глобальный и «свои» не двигаются.
  function setSections() {
    return [...body.querySelectorAll('.vk7tv-picker-group')].filter((s) => s._vk7tvSetId);
  }

  function dragStart(head, e) {
    const sec = head.parentElement;
    if (!sec._vk7tvSetId) return;
    drag = { sec, head, y: e.clientY, moved: false };
    head.setPointerCapture(e.pointerId);
  }

  function dragMove(e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y) < 4) return;
      drag.moved = true;
      // Сетки прячем на время перетаскивания: иначе, чтобы поднять набор
      // на одну позицию, заголовок пришлось бы тащить через тысячу ячеек.
      body.classList.add('vk7tv-reorder');
      drag.sec.classList.add('vk7tv-dragging');
    }
    for (const s of setSections()) {
      if (s === drag.sec) continue;
      const r = s.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) continue;
      body.insertBefore(drag.sec, e.clientY < r.top + r.height / 2 ? s : s.nextSibling);
      break;
    }
  }

  function dragEnd() {
    if (!drag) return;
    const { sec, moved } = drag;
    drag = null;
    body.classList.remove('vk7tv-reorder');
    sec.classList.remove('vk7tv-dragging');
    if (!moved) return; // не тащили — это обычный клик по заголовку
    justDragged = true;
    saveOrder();
  }

  // Порядок наборов хранится в самом списке наборов: его же читают попап
  // и модуль для приложения. Он задаёт и приоритет: при коллизии кодов
  // голое имя достаётся набору выше по списку.
  async function saveOrder() {
    const ids = setSections().map((s) => s._vk7tvSetId);
    const { sets } = await chrome.storage.sync.get({ sets: [] });
    const byId = new Map(sets.map((s) => [s.id, s]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    // Набор без единого эмоута секции не получил (не докачался) — его в
    // списке нет, и он должен остаться, а не пропасть при перестановке.
    for (const s of sets) if (!ids.includes(s.id)) next.push(s);
    // сетку пересоберёт слушатель хранилища — он же обновит попап
    await chrome.storage.sync.set({ sets: next });
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
    cancelDocHold('rerender');
    selCell = null;
    hidePreview();
    nearObserver.disconnect();
    cleanupDocCells();
    body.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();
    if (DOCS) {
      try {
        DOCS.setQuery(q);
      } catch (e) {
        // ошибка поиска по файлам не должна оставлять пикер без эмоутов
      }
    }

    // «Файлы» всегда первыми: при поиске они раскрываются, чтобы совпадения
    // по документам были видны сразу.
    try {
      body.appendChild(buildDocsSection());
      renderDocsSection();
    } catch (e) {
      // без раздела файлов эмоуты должны остаться рабочими
    }

    const jobs = [];
    let reached = false; // набор, к которому ведём прокрутку, уже встретился
    for (const g of groups) {
      const found = [];
      for (const [name, em] of Object.entries(g.emotes)) {
        const full = fullName(g, name, em);
        const low = full.toLowerCase();
        if (q && !low.includes(q)) continue;
        found.push([full, em, low, cellWidth(em)]);
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
      } else {
        // Порядок как в 7TV на твиче: по ширине ячейки, от узких к широким —
        // сперва квадратные, потом растяжки. В строке тогда стоят эмоуты
        // одного размера, а не квадраты вперемешку с растяжками, после
        // которых справа остаётся пустое место.
        // Сортировка устойчивая — внутри одной ширины порядок набора цел.
        found.sort((a, b) => a[3] - b[3]);
      }
      const sec = document.createElement('div');
      sec.className = 'vk7tv-picker-group';
      const grid = document.createElement('div');
      grid.className = 'vk7tv-picker-grid';
      sec.append(groupTitle(g, found.length), grid);
      // работа по сборке живёт на самой секции: раскрыли набор или он
      // подошёл к видимой части — берём её оттуда и досоздаём ячейки
      sec._vk7tvJob = { key: g.key, sec, grid, found, at: 0, filled: false, running: false };
      sec._vk7tvSetId = g.setId || ''; // пусто у глобального и «своих» — их не двигаем
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
    if (!body.querySelector('.vk7tv-picker-group:not(.vk7tv-docs-group)')) {
      body.appendChild(emptyNote(q));
    }
    fillJobs(jobs, token);
  }

  // Пустой список: без пояснения непонятно, то ли не нашлось, то ли
  // расширение не загрузило наборы. Причины разные, и действия тоже:
  // набор ещё не добавлен — идти в настройки; набор добавлен, а эмоуты
  // не скачались (7tv.io был недоступен) — нажать «↻ Обновить наборы».
  function emptyNote(q) {
    const el = document.createElement('div');
    el.className = 'vk7tv-picker-empty';
    el.textContent = q
      ? 'Ничего не найдено'
      : missingSets
        ? `Эмоуты не скачались (наборов без эмоутов: ${missingSets}) — открой настройки расширения и нажми «↻ Обновить наборы»`
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
    // Клавиатурный выбор файла запускает его медиа так же, как наведение.
    if (selCell.classList.contains('vk7tv-doc-cell')) activateDocMedia(selCell, false);
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
      for (const [n, em] of Object.entries(g.emotes)) {
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
    const q = searchInput.value.trim();
    // Поиск по файлам должен показывать находки сразу, поэтому при первом
    // вводе раскрываем секцию. Пользователь может свернуть её обратно.
    if (DOCS && q) {
      try {
        DOCS.checkAuth();
        DOCS.setPaused(false);
        if (docsCollapsed) {
          setDocsCollapsed(false);
          ensureDocsLoad();
        }
      } catch (e) {
        // ошибка раздела файлов не должна ломать поиск эмоутов
      }
    }
    filterStrip();
    renderBody();
  }

  // --- позиционирование и перетаскивание ---

  const WIDGET_MARGIN = 4;

  function setWidgetPos(left, top) {
    left = Math.max(WIDGET_MARGIN, Math.min(left, window.innerWidth - WIDGET_SIZE - WIDGET_MARGIN));
    top = Math.max(WIDGET_MARGIN, Math.min(top, window.innerHeight - WIDGET_SIZE - WIDGET_MARGIN));
    widget.style.left = left + 'px';
    widget.style.top = top + 'px';
  }

  // Привязка к ближайшему краю по каждой оси. При равном расстоянии
  // оставляем левый и верхний край: иначе привязка менялась бы скачком,
  // когда окно совпадает по размеру с положением кнопки.
  function widgetAnchor(left, top) {
    const right = window.innerWidth - WIDGET_SIZE - left;
    const bottom = window.innerHeight - WIDGET_SIZE - top;
    const edgeX = left <= right ? 'left' : 'right';
    const edgeY = top <= bottom ? 'top' : 'bottom';
    return {
      left,
      top,
      edgeX,
      edgeY,
      offsetX: edgeX === 'left' ? left : right,
      offsetY: edgeY === 'top' ? top : bottom,
    };
  }

  function hasWidgetAnchor(pos) {
    return (
      !!pos &&
      (pos.edgeX === 'left' || pos.edgeX === 'right') &&
      (pos.edgeY === 'top' || pos.edgeY === 'bottom') &&
      Number.isFinite(pos.offsetX) &&
      Number.isFinite(pos.offsetY)
    );
  }

  // Старая запись { left, top } не знает, к какому краю была привязана
  // кнопка. Выводим привязку из сохранённых координат до ограничения:
  // после сужения окна они могли быть уже сдвинуты, и прежний замысел
  // пользователя восстановить нельзя — исходной считаем эту позицию.
  function normalizeWidgetPos(pos) {
    if (!pos || typeof pos !== 'object') return null;
    if (hasWidgetAnchor(pos)) {
      const left = Number.isFinite(pos.left)
        ? pos.left
        : pos.edgeX === 'right'
          ? window.innerWidth - WIDGET_SIZE - pos.offsetX
          : pos.offsetX;
      const top = Number.isFinite(pos.top)
        ? pos.top
        : pos.edgeY === 'bottom'
          ? window.innerHeight - WIDGET_SIZE - pos.offsetY
          : pos.offsetY;
      return {
        left,
        top,
        edgeX: pos.edgeX,
        edgeY: pos.edgeY,
        offsetX: pos.offsetX,
        offsetY: pos.offsetY,
      };
    }
    const left = Number.isFinite(pos.left)
      ? pos.left
      : window.innerWidth - WIDGET_SIZE - 20;
    const top = Number.isFinite(pos.top) ? pos.top : window.innerHeight - 170;
    return widgetAnchor(left, top);
  }

  function applyWidgetPos() {
    if (!widgetPos) return;
    const left =
      widgetPos.edgeX === 'right'
        ? window.innerWidth - WIDGET_SIZE - widgetPos.offsetX
        : widgetPos.offsetX;
    const top =
      widgetPos.edgeY === 'bottom'
        ? window.innerHeight - WIDGET_SIZE - widgetPos.offsetY
        : widgetPos.offsetY;
    setWidgetPos(left, top);
  }

  function saveWidgetPos(left, top) {
    widgetPos = widgetAnchor(left, top);
    chrome.storage.local.set({ widgetPos });
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
        saveWidgetPos(r.left, r.top);
        if (open) positionPicker();
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
    if (!open) cancelDocHold('close');
    hidePreview();
    resetDrop();
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
      revalidate();
      if (DOCS) {
        try {
          DOCS.checkAuth();
          if (!docsCollapsed) {
            DOCS.setPaused(false);
            ensureDocsLoad();
            maybeLoadNext();
          }
        } catch (e) {
          // сбой файлов не должен закрывать поповер с эмоутами
        }
      }
      resumeDocMedia();
    } else {
      hideDocsBatch();
      pauseDocMedia();
      if (DOCS_MEDIA) DOCS_MEDIA.cancelPending();
      if (DOCS) {
        try {
          DOCS.setPaused(true);
        } catch (e) {}
      }
    }
  }

  // Наборы могли измениться, пока страница висела открытой, а вкладка об этом
  // не узнала: событие хранилища до неё не дошло. Так бывает после
  // переустановки или обновления расширения — старый контент-скрипт от него
  // уже отключён, onChanged в нём молчит навсегда, и поповер показывает
  // наборы, которых в хранилище давно нет (или наоборот). Поэтому на каждое
  // открытие перечитываем хранилище и, если список разошёлся с показанным,
  // собираем сетку заново.
  function groupsSignature() {
    return groups.map((g) => `${g.key}:${Object.keys(g.emotes).length}`).join('|');
  }

  // Вкладка осталась от прошлой версии расширения: расширение обновили или
  // переустановили, пока страница висела открытой. В таком контент-скрипте
  // chrome.runtime пропадает — картинки эмоутов через фон уже не приходят,
  // а без них обработчик error убирает ячейку за ячейкой, и поповер стоит
  // с заголовками наборов и без единого эмоута. Само это не лечится, поэтому
  // не молчим, а просим перезагрузить страницу.
  function detached() {
    try {
      return !chrome.runtime || !chrome.runtime.id;
    } catch (e) {
      return true;
    }
  }

  function staleNote() {
    clearTimeout(flashTimer);
    foot.textContent = 'Расширение обновилось — обнови страницу ВК (F5)';
    // в подвал влезает одна строка, поэтому подробности — в подсказке
    foot.title =
      'Расширение обновили или переустановили, пока страница была открыта: эта ' +
      'вкладка с ним больше не связана. Если после F5 сообщение осталось — ' +
      'значит расширение выключено или сломано, проверь его на chrome://extensions.';
    foot.classList.add('vk7tv-flash');
  }

  async function revalidate() {
    if (detached()) return staleNote();
    const before = groupsSignature();
    let show;
    try {
      show = await loadGroups();
    } catch (e) {
      staleNote(); // «Extension context invalidated» — то же самое
      return;
    }
    widget.style.display = show ? 'flex' : 'none';
    if (!show) return setOpen(false);
    if (groupsSignature() !== before) refreshGrid();
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
      if (docsDndVisible) placeDropOverlay();
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

  // Скрытая вкладка не должна крутить видео и GIF в фоне. Постеры остаются
  // на месте, поэтому карточки не дёргаются при возврате.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelDocHold('hidden');
      pauseDocMedia();
      hidePreview();
      resetDrop();
    } else {
      resumeDocMedia();
    }
  });
  window.addEventListener('pagehide', () => {
    cancelDocHold('unload');
    pauseDocMedia();
    if (DOCS_MEDIA) DOCS_MEDIA.cancelPending();
  });
  window.addEventListener('blur', () => cancelDocHold('blur'));

  window.addEventListener('resize', () => {
    applyWidgetPos();
    if (open) positionPicker();
    if (docsDndVisible) placeDropOverlay();
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
      docsKnown: false,
      recent: [],
      stripTab: 'recent',
    });
    const { widgetPos: savedPos, pickerSize } = stored;
    collapsedKeys = new Set(Array.isArray(stored.collapsedGroups) ? stored.collapsedGroups : []);
    // «Файлы» по умолчанию свёрнуты: открытие панели не должно тянуть
    // документы. Флаг docsKnown отличает старые настройки от ручного
    // раскрытия; остальные ключи не перезаписываем.
    if (!stored.docsKnown) {
      collapsedKeys.add(DOCS_KEY);
      docsCollapsed = true;
      await chrome.storage.local.set({
        collapsedGroups: [...collapsedKeys],
        docsKnown: true,
      });
    } else {
      docsCollapsed = collapsedKeys.has(DOCS_KEY);
    }
    recent = Array.isArray(stored.recent) ? stored.recent : [];
    stripTab = stored.stripTab === 'fav' ? 'fav' : 'recent';
    if (pickerSize) {
      picker.style.width = pickerSize.w + 'px';
      picker.style.height = pickerSize.h + 'px';
    }
    const legacyPos = !!savedPos && !hasWidgetAnchor(savedPos);
    widgetPos = normalizeWidgetPos(savedPos);
    if (!widgetPos) {
      // начальная позиция: 20px от правого края, по вертикали — как раньше
      widgetPos = widgetAnchor(
        window.innerWidth - WIDGET_SIZE - 20,
        window.innerHeight - 170
      );
    }
    applyWidgetPos();
    // Старый формат пересохраняем один раз: дальше окно уже не сможет
    // сдвинуть координаты, не затронув привязку.
    if (legacyPos) chrome.storage.local.set({ widgetPos });
    const show = await loadGroups();
    widget.style.display = show ? 'flex' : 'none';
    refreshGrid();
  }

  init();
})();
