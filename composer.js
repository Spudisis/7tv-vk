// VK7TV — кнопка «спойлер» в панели форматирования ВК.
// Выделил текст в поле ввода — ВК показывает поповер с кнопками
// (ComposerFormattingMenu_panel, кнопки — ComposerFormattingMenu_button).
// Встаём первой кнопкой и оборачиваем выделение в [spoiler]…[/spoiler].
//
// Классы ВК опознаём по кускам имени, а не целиком: написание у панели
// от сборки к сборке разное, и точное имя пережило бы не всякое обновление.

(() => {
  const MARK = 'vk7tv-fmt';
  const SPOILER_OPEN = '[spoiler]';
  const SPOILER_CLOSE = '[/spoiler]';

  // Дешёвый отсев для обработчика мутаций: он видит все узлы, которые ВК
  // добавляет на страницу, поэтому до toLowerCase доходить нельзя.
  // «omposer» без первой буквы — чтобы не зависеть от регистра.
  const PANEL_SEL = '[class*="omposer"]';

  function looks(el) {
    const c = el.getAttribute && el.getAttribute('class');
    return !!c && c.indexOf('omposer') >= 0;
  }

  function has(el, kind) {
    if (!looks(el)) return false;
    const c = el.getAttribute('class').toLowerCase();
    return c.includes('format') && c.includes(kind);
  }

  const isPanel = (el) => has(el, 'panel');
  const isButton = (el) => has(el, 'button');

  /** Панель, в которой лежит узел (или он сам). */
  function panelOf(el) {
    for (let n = el, depth = 0; n && n.getAttribute && depth < 6; n = n.parentElement, depth++) {
      if (isPanel(n)) return n;
    }
    return null;
  }

  function findButton(panel) {
    for (const el of panel.querySelectorAll(PANEL_SEL)) if (isButton(el)) return el;
    return null;
  }

  function eyeIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const eye = document.createElementNS(ns, 'path');
    eye.setAttribute('d', 'M2.5 12S6.6 6 12 6s9.5 6 9.5 6-4.1 6-9.5 6-9.5-6-9.5-6z');
    const pupil = document.createElementNS(ns, 'circle');
    pupil.setAttribute('cx', '12');
    pupil.setAttribute('cy', '12');
    pupil.setAttribute('r', '2.6');
    for (const el of [eye, pupil]) {
      el.setAttribute('stroke', 'currentColor');
      el.setAttribute('stroke-width', '1.7');
      el.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(el);
    }
    return svg;
  }

  /** Поле ввода, в котором лежит выделение; наш собственный UI не считается. */
  function editableOf(node) {
    const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!(el instanceof Element)) return null;
    const host = el.closest('[contenteditable="true"]');
    if (!host || host.closest('.vk7tv-picker,.vk7tv-widget,.vk7tv-ac')) return null;
    return host;
  }

  // Правим текст через execCommand: прямую правку DOM фреймворк ВК
  // не видит (та же причина, что в autocomplete.js и picker.js), а так
  // сохраняется ещё и отмена по Ctrl+Z.
  function wrapSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const host = editableOf(sel.anchorNode);
    if (!host) return;
    const text = sel.toString();
    if (!text) return;
    host.focus();
    document.execCommand('insertText', false, SPOILER_OPEN + text + SPOILER_CLOSE);
  }

  function makeButton(sample) {
    // Тег и классы забираем у соседней кнопки: у панели свои стили,
    // и собственная вёрстка выглядела бы в ней чужой.
    const btn = document.createElement(sample ? sample.tagName : 'button');
    if (sample) {
      btn.className = sample.getAttribute('class') || '';
      const role = sample.getAttribute('role');
      if (role) btn.setAttribute('role', role);
    }
    btn.classList.add(MARK);
    if (btn.tagName === 'BUTTON') btn.type = 'button';
    btn.title = 'Спойлер';
    btn.setAttribute('aria-label', 'Спойлер');
    btn.appendChild(eyeIcon());
    // Выделение должно пережить нажатие: с фокусом уходит и оно,
    // а оборачивать после этого будет нечего.
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrapSelection();
    });
    return btn;
  }

  function inject(panel) {
    if (panel.querySelector('.' + MARK)) return;
    const sample = findButton(panel);
    const btn = makeButton(sample);
    // первой кнопкой — рядом с остальными, а не в угол панели
    if (sample && sample.parentElement) sample.parentElement.insertBefore(btn, sample);
    else panel.insertBefore(btn, panel.firstChild);
  }

  function sweep(el) {
    const up = panelOf(el);
    if (up) inject(up);
    if (!el.querySelectorAll) return;
    for (const c of el.querySelectorAll(PANEL_SEL)) if (isPanel(c)) inject(c);
  }

  // Панель ВК пересобирает на каждое выделение, а иногда меняет только
  // её содержимое — поэтому смотрим и на сам добавленный узел, и на то,
  // в какой панели он оказался.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE) sweep(n);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  sweep(document.documentElement);
})();
