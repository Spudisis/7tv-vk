// VK7TV — виджет-пикер эмоутов на странице ВК.
// Круглая кнопка в углу; клик раскрывает поповер с поиском по всем
// подключённым наборам (сгруппированы по сетам). Кнопку можно таскать
// за неё саму или за шапку поповера — они двигаются вместе, позиция
// запоминается. Клик по эмоуту вставляет его имя в последнее активное
// поле ввода ВК; если поля нет — копирует имя в буфер.

(() => {
  if (window.top !== window) return; // только в основном фрейме

  const WIDGET_SIZE = 46;

  let widget = null;
  let picker = null;
  let searchInput = null;
  let body = null;
  let foot = null;
  let open = false;
  let groups = [];
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

  function insertEmote(name) {
    if (lastInput && lastInput.isConnected) {
      lastInput.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      if (lastRange && lastInput.contains(lastRange.startContainer)) {
        sel.addRange(lastRange);
      } else {
        const r = document.createRange();
        r.selectNodeContents(lastInput);
        r.collapse(false);
        sel.addRange(r);
      }
      document.execCommand('insertText', false, name + ' ');
      flash(`${name} — вставлено`);
    } else {
      navigator.clipboard.writeText(name);
      flash(`${name} — скопировано, поле ввода не открыто`);
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
      if (m && Object.keys(m).length) groups.push({ title: s.name, emotes: m });
    }
    if (Object.keys(sync.customEmotes).length) {
      groups.push({ title: 'Свои', emotes: sync.customEmotes });
    }
    return sync.enabled && sync.widget;
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
    const close = document.createElement('span');
    close.className = 'vk7tv-picker-close';
    close.textContent = '✕';
    close.addEventListener('click', () => setOpen(false));
    head.append(title, close);

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

    body = document.createElement('div');
    body.className = 'vk7tv-picker-body';

    foot = document.createElement('div');
    foot.className = 'vk7tv-picker-foot';
    foot.textContent = FOOT_HINT;

    picker.append(head, searchInput, body, foot);
    document.body.append(widget, picker);

    makeDraggable(widget, true);
    makeDraggable(head, false);
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
      for (const [name, url] of Object.entries(g.emotes)) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = name;
        img.title = name;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.draggable = false;
        img.addEventListener('click', () => insertEmote(name));
        img.addEventListener('error', () => img.remove());
        grid.appendChild(img);
      }
      sec.append(h, grid);
      body.appendChild(sec);
    }
    applyFilter();
  }

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    for (const sec of body.querySelectorAll('.vk7tv-picker-group')) {
      let shown = 0;
      for (const img of sec.querySelectorAll('img')) {
        const hit = !q || img.alt.toLowerCase().includes(q);
        img.style.display = hit ? '' : 'none';
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
      if (e.target.classList.contains('vk7tv-picker-close')) return;
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
  new ResizeObserver(() => {
    if (!open) return;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const r = picker.getBoundingClientRect();
      if (!r.width || !r.height) return;
      chrome.storage.local.set({ pickerSize: { w: Math.round(r.width), h: Math.round(r.height) } });
      clampPicker();
    }, 250);
  }).observe(picker);

  // --- реакция на настройки и ресайз ---

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    // позиция и размер — наши же записи, сетку из-за них не перерисовываем
    if (area === 'local' && !changes.setEmotes && !changes.globalEmotes) return;
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
