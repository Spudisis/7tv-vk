// VK7TV — автозаполнение эмоутов в поле ввода (Twitch-стиль).
// Набрал 3+ символа слова — всплывает панель с подходящими эмоутами.
// Tab/Enter/клик — вставить, стрелки — выбор, Esc — закрыть.
// Вставка через execCommand('insertText'), чтобы фреймворк ВК
// увидел изменение текста (прямая правка DOM им игнорируется).

(() => {
  const MIN_CHARS = 3;
  const MAX_ITEMS = 10;

  let menu = null;
  let items = []; // [{name, url}]
  let selected = 0;
  let ctx = null; // {node, start, end} — участок текста, который заменяем

  const state = () => window.__vk7tv || null;

  function ensureMenu() {
    if (menu && menu.isConnected) return menu;
    menu = document.createElement('div');
    menu.className = 'vk7tv-ac';
    // не отдаём фокус при клике по панели — иначе поле ввода закроется раньше клика
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(menu);
    return menu;
  }

  function hide() {
    if (menu) menu.style.display = 'none';
    items = [];
    ctx = null;
  }

  function isOpen() {
    return menu && menu.style.display === 'block' && items.length > 0;
  }

  function render() {
    const el = ensureMenu();
    el.innerHTML = '';
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'vk7tv-ac-item' + (i === selected ? ' active' : '');
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      const span = document.createElement('span');
      span.textContent = it.name;
      row.append(img, span);
      row.addEventListener('mouseenter', () => {
        if (selected !== i) {
          selected = i;
          render();
        }
      });
      row.addEventListener('click', () => accept(i));
      el.appendChild(row);
    });
  }

  function position(rect) {
    const el = menu;
    el.style.visibility = 'hidden';
    el.style.display = 'block';
    const mh = el.offsetHeight;
    const mw = el.offsetWidth;
    let top = rect.top - mh - 6;
    if (top < 8) top = rect.bottom + 6;
    let left = Math.min(rect.left, window.innerWidth - mw - 8);
    if (left < 8) left = 8;
    el.style.top = top + 'px';
    el.style.left = left + 'px';
    el.style.visibility = '';
  }

  function accept(i) {
    const it = items[i];
    if (!it || !ctx || !ctx.node.isConnected) return hide();
    const sel = window.getSelection();
    const range = document.createRange();
    const len = ctx.node.nodeValue.length;
    range.setStart(ctx.node, Math.min(ctx.start, len));
    range.setEnd(ctx.node, Math.min(ctx.end, len));
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, it.name + ' ');
    hide();
  }

  function onInput(e) {
    const st = state();
    if (!st || !st.enabled || !st.emoteMap.size) return hide();
    const target = e.target;
    if (!(target instanceof Element) || !target.isContentEditable) return hide();

    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return hide();
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return hide();

    // слово — от последнего пробела до курсора
    const offset = sel.anchorOffset;
    const m = node.nodeValue.slice(0, offset).match(/(\S+)$/);
    if (!m || m[1].length < MIN_CHARS) return hide();
    const word = m[1];
    const lower = word.toLowerCase();

    const matches = [];
    for (const [name, v] of st.emoteMap) {
      if (name.toLowerCase().startsWith(lower)) matches.push({ name, url: v.u });
    }
    if (!matches.length) return hide();

    // точное совпадение регистра выше, потом короткие, потом по алфавиту
    matches.sort((a, b) => {
      const ax = a.name.startsWith(word) ? 0 : 1;
      const bx = b.name.startsWith(word) ? 0 : 1;
      if (ax !== bx) return ax - bx;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    });

    items = matches.slice(0, MAX_ITEMS);
    selected = 0;
    ctx = { node, start: offset - word.length, end: offset };

    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    ensureMenu();
    render();
    position(rect);
  }

  function onKeydown(e) {
    if (!isOpen()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      selected = (selected + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation(); // не даём ВК отправить сообщение по Enter
      accept(selected);
    } else if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      hide();
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      // курсор уходит из слова — позиция вставки устарела
      hide();
    }
  }

  // capture: true — чтобы отработать раньше обработчиков ВК
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusout', hide, true);
  document.addEventListener('scroll', hide, true);
})();
