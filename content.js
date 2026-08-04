// VK7TV — контент-скрипт.
// Ищет в тексте страницы слова-коды эмоутов и заменяет их на <img>.
// Текст сообщения при этом остаётся текстом на сервере ВК — картинку
// видит каждый, у кого стоит расширение с тем же набором эмоутов.

(() => {
  const EMOTE_CLASS = 'vk7tv-emote';

  let enabled = true;
  let suggestOn = true;
  let messengerOnly = false; // подменять коды только в переписке
  let emoteMap = new Map(); // имя -> URL картинки
  let testRegex = null; // быстрый префильтр текстовых узлов
  let stateSig = ''; // подпись набора эмоутов и настроек

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // старый кэш и «свои» эмоуты хранят просто строку-URL
  function normEmote(v) {
    return typeof v === 'string' ? { u: v, z: 0 } : v;
  }

  // CSP ВК не пускает картинки с cdn.7tv.app, но разрешает blob: и data:.
  // Фоновый скрипт качает картинку, здесь она превращается в blob:-URL;
  // кэш по URL — повторные эмоуты в чате не ходят в сеть.
  const blobCache = new Map(); // url -> Promise<string|null>
  // На vk.com прямая загрузка с CDN не проходит никогда. Первая картинка
  // это выясняет, остальные уже не тратят время на заведомо мёртвый запрос.
  let cdnBlocked = false;
  function resolveEmote(url) {
    if (blobCache.has(url)) return blobCache.get(url);
    const p = new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'fetch-emote', url }, (resp) => {
        if (!resp || !resp.dataUrl) return resolve(null);
        try {
          const comma = resp.dataUrl.indexOf(',');
          const meta = resp.dataUrl.slice(0, comma);
          const mime = meta.slice(5, meta.indexOf(';'));
          const bin = atob(resp.dataUrl.slice(comma + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          resolve(URL.createObjectURL(new Blob([bytes], { type: mime })));
        } catch (e) {
          resolve(resp.dataUrl);
        }
      });
    });
    blobCache.set(url, p);
    return p;
  }

  // --- предложение подключить набор стримера ---
  // Прилетело non_nicosl, а такого эмоута у нас нет: слово с разделителем
  // выглядит как имя_стример, значит у собеседника подключён набор, которого
  // нет у нас. Проверять сами не можем — спрашиваем фоновый скрипт, он ходит
  // в API 7TV и отвечает, есть ли такой стример и лежит ли эмоут в его наборе.
  // Ответ кладём в кэш (в том числе отрицательный), чтобы одно и то же слово
  // не дёргало API на каждое сообщение.
  const PENDING = 'pending';
  const suggestCache = new Map(); // слово -> PENDING | null | {slug, name, url, …}
  let probes = 0;
  const MAX_PROBES = 120; // потолок на вкладку: чат не должен спамить в API

  // слово целиком из букв/цифр/подчёркиваний, с разделителем внутри
  // и не короче, чем «xx_yyy»
  const SUGGEST_RE = /^[A-Za-z0-9][A-Za-z0-9_]{4,59}$/;
  const looksLikeSetEmote = (w) =>
    SUGGEST_RE.test(w) && w.includes('_') && !w.endsWith('_') && !w.includes('__');

  function probeSuggest(word) {
    if (probes >= MAX_PROBES) return;
    probes++;
    suggestCache.set(word, PENDING);
    chrome.runtime.sendMessage({ type: 'probe-set', word }, (resp) => {
      const hit = resp && resp.found ? resp : null;
      suggestCache.set(word, hit);
      // Слово могло встретиться в десятке сообщений, а ответ пришёл уже
      // после их отрисовки — проще перерисовать страницу целиком, чем
      // помнить все узлы. Ответы на пачку слов сходятся в одну перерисовку.
      if (hit) scheduleRerender();
    });
  }

  let rerenderTimer = null;
  function scheduleRerender() {
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => {
      unrender();
      if (enabled) scan(document.body);
    }, 300);
  }

  async function loadState() {
    const sync = await chrome.storage.sync.get({
      enabled: true,
      useGlobal: true,
      suggest: true,
      messengerOnly: false,
      sets: [],
      customEmotes: {},
    });
    const local = await chrome.storage.local.get({ setEmotes: {}, globalEmotes: null });

    enabled = sync.enabled;
    suggestOn = sync.suggest;
    messengerOnly = sync.messengerOnly;
    emoteMap = new Map();
    if (sync.useGlobal) {
      const g =
        local.globalEmotes && Object.keys(local.globalEmotes).length
          ? local.globalEmotes
          : DEFAULT_EMOTES;
      for (const [n, v] of Object.entries(g)) emoteMap.set(n, normEmote(v));
    }
    // У эмоута из набора есть второе имя — с постфиксом набора:
    // ok_bratishkinoff. Голое имя остаётся за глобальным набором и «своими»,
    // а набору стримера достаётся, только если такой код есть ровно в одном
    // подключённом наборе. Есть в нескольких — голое имя ничьё, пишем
    // с постфиксом: иначе картинка зависела бы от того, какой набор
    // подключён последним.
    // a — голое имя эмоута, пометка «это алиас» для автозаполнения.
    const fromSets = new Map(); // голое имя -> {em, count}
    for (const s of sync.sets) {
      const m = local.setEmotes[s.id];
      if (!m) continue;
      for (const [n, v] of Object.entries(m)) {
        const em = normEmote(v);
        if (s.slug) emoteMap.set(`${n}_${s.slug}`, { u: em.u, z: em.z, a: n });
        const prev = fromSets.get(n);
        if (prev) prev.count++;
        else fromSets.set(n, { em, count: 1 });
      }
    }
    for (const [n, o] of fromSets) {
      if (o.count === 1 && !emoteMap.has(n)) emoteMap.set(n, o.em);
    }
    for (const [n, v] of Object.entries(sync.customEmotes)) emoteMap.set(n, normEmote(v));

    // Префильтр строим по голым именам: имя с постфиксом содержит голое
    // как подстроку, поэтому такой текст регексп поймает и без него.
    // Исключение — коллизии: там голого имени нет, и алиас нужен явно.
    const probes = [];
    for (const [n, v] of emoteMap) if (!v.a || !emoteMap.has(v.a)) probes.push(n);
    testRegex = probes.length ? new RegExp(probes.map(escapeRegex).join('|')) : null;

    // общее состояние для autocomplete.js и picker.js (один isolated world)
    window.__vk7tv = { emoteMap, enabled, resolveEmote };

    // Подпись состояния: по ней видно, надо ли перерисовывать уже
    // показанные сообщения. Фоновое обновление наборов раз в полчаса
    // пишет в хранилище то же самое, и трогать из-за него страницу незачем.
    const sig = [
      enabled,
      suggestOn,
      messengerOnly,
      sync.useGlobal,
      emoteMap.size,
      sync.sets.map((s) => `${s.id}:${s.count}`).join(','),
    ].join('|');
    const changed = sig !== stateSig;
    stateSig = sig;
    return changed;
  }

  function makeEmote(name, url, zeroWidth) {
    const img = document.createElement('img');
    img.className = EMOTE_CLASS + (zeroWidth ? ' vk7tv-zw' : '');
    img.alt = name;
    img.title = name;
    img.draggable = false;
    img.loading = 'lazy';
    const viaBackground = () => {
      img.dataset.vk7tvFallback = '1';
      resolveEmote(url).then((u) => {
        if (u) img.src = u;
        else img.replaceWith(document.createTextNode(name));
      });
    };
    img.addEventListener('error', () => {
      if (img.dataset.vk7tvFallback) {
        // и blob не загрузился — возвращаем текст, чтобы не терять сообщение
        img.replaceWith(document.createTextNode(name));
        return;
      }
      cdnBlocked = true;
      viaBackground();
    });
    if (cdnBlocked) viaBackground();
    else img.src = url;
    return img;
  }

  // Чип сразу за незнакомым словом: превью эмоута и кнопка «поставить
  // набор». Клик подключает набор — дальше storage.onChanged перерисует
  // страницу, и слово превратится в картинку во всех сообщениях сразу.
  function makeSuggest(hit) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vk7tv-suggest';
    btn.title =
      `«${hit.name}» — эмоут из набора «${hit.setName}» (${hit.count} шт.).` +
      ' Нажми, чтобы подключить набор.';

    const img = document.createElement('img');
    img.className = 'vk7tv-suggest-img';
    img.alt = hit.name;
    img.draggable = false;
    img.addEventListener('error', () => {
      if (img.dataset.vk7tvFallback) return img.remove(); // остаётся текст кнопки
      img.dataset.vk7tvFallback = '1';
      resolveEmote(hit.url).then((u) => (u ? (img.src = u) : img.remove()));
    });
    img.src = hit.url;

    const label = document.createElement('span');
    label.className = 'vk7tv-suggest-label';
    label.textContent = '+ ' + hit.slug;

    btn.append(img, label);
    // ВК вешает свои обработчики на сообщение целиком — клик по чипу
    // не должен ни открывать диалог, ни забирать фокус у поля ввода
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      label.textContent = 'ставлю…';
      chrome.runtime.sendMessage({ type: 'add-set', input: hit.slug }, (resp) => {
        if (!resp || resp.error) {
          btn.disabled = false;
          label.textContent = '+ ' + hit.slug;
          btn.title = (resp && resp.error) || 'Не получилось подключить набор';
          btn.classList.add('vk7tv-suggest-err');
          return;
        }
        label.textContent = 'готово';
      });
    });
    return btn;
  }

  // Возвращает чип для слова, если про него уже известно, что это эмоут
  // из чужого набора. Про незнакомое слово спрашивает фоновый скрипт —
  // ответ придёт позже и вызовет перерисовку.
  function suggestFor(word, seen) {
    if (!suggestOn || seen.has(word) || !looksLikeSetEmote(word)) return null;
    seen.add(word);
    const hit = suggestCache.get(word);
    if (hit === undefined) {
      probeSuggest(word);
      return null;
    }
    return hit && hit !== PENDING ? makeSuggest(hit) : null;
  }

  // Служебные подписи ВК (время сообщения, дата поста, «был в сети…») —
  // не текст пользователя, и менять их нельзя: в наборах попадаются эмоуты
  // с именами вроде «20:00», и без этой проверки время у сообщения
  // превращалось в картинку.
  const SERVICE_TOKENS = new Set([
    'time', 'times', 'timestamp', 'timestamps', 'date', 'dates', 'datetime',
    'clock', 'ago', 'online', 'offline', 'seen', 'lastseen',
    'edited', 'edit', 'changed',
  ]);
  // Подпись целиком: время («20:00», «9:05», «20:00:30») или пометка ВК
  // об изменении («(ред.)», «(edited)»). Скобки у «( ред. )» ВК рисует
  // отдельно от слова, а «(» и «)» в наборах числятся эмоутами —
  // поэтому подпись проверяем и по тексту всего элемента-родителя.
  const SERVICE_TEXT =
    /^\(?\s*(?:\d{1,2}:\d{2}(?::\d{2})?|ред\.?|изменено|отредактировано|edited)\s*\)?$/i;

  // Подпись может быть разбита на куски: «(» + «ред.» + «)». Поднимаемся
  // вверх, пока текст элемента остаётся коротким: как только он длиннее
  // подписи — это уже сообщение, и дальше идти незачем.
  function isServiceText(el, depth) {
    for (let n = el, i = 0; n && i <= depth; n = n.parentElement, i++) {
      const t = (n.textContent || '').trim();
      if (t.length > 24) return false;
      if (SERVICE_TEXT.test(t)) return true;
    }
    return false;
  }

  // --- «эмоуты только в мессенджере» ---
  // Раздел /im — это и список диалогов, и открытый чат: там подменяем всё.
  // Вне его (лента, стена, комментарии, профили) — не трогаем ничего, кроме
  // всплывающих окошек чата, которые ВК показывает поверх других страниц:
  // их опознаём по классам-контейнерам с узнаваемыми кусками (im, msg, chat…).
  const MSG_TOKENS = new Set([
    'im', 'msg', 'msgs', 'message', 'messages', 'messaging',
    'dialog', 'dialogs', 'chat', 'chats', 'convo', 'conversation',
    'conversations', 'peer', 'bubble', 'history',
  ]);

  function inImSection() {
    const p = location.pathname;
    return p === '/im' || p.startsWith('/im/');
  }

  function inMessenger(el) {
    if (inImSection()) return true; // весь раздел мессенджера целиком
    for (let n = el, depth = 0; n && n !== document.body && depth < 20; n = n.parentElement, depth++) {
      if (!n.getAttribute) continue;
      const raw =
        (n.getAttribute('class') || '') + ' ' +
        (n.getAttribute('data-testid') || '') + ' ' + (n.id || '');
      if (!raw.trim()) continue;
      // «im-page» → im page, «MessagesConvo» → messages convo; режем по
      // границам, чтобы «time»/«image» не читались как «im»
      const tokens = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
      for (const t of tokens) if (MSG_TOKENS.has(t)) return true;
    }
    return false;
  }

  function isServiceLabel(el) {
    for (let n = el, depth = 0; n && n !== document.body && depth < 6; n = n.parentElement, depth++) {
      if (n.tagName === 'TIME' || n.hasAttribute('datetime')) return true;
      const raw = (n.getAttribute('class') || '') + ' ' + (n.getAttribute('data-testid') || '');
      if (!raw.trim()) continue;
      // «MessageTime» → message time, «im-mess--time» → im mess time,
      // «_time_1a2b3» → time; при этом «update» словом «date» не считается
      const tokens = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/);
      for (const t of tokens) if (SERVICE_TOKENS.has(t)) return true;
    }
    return false;
  }

  function processTextNode(node) {
    if (!enabled) return;
    if (node._vk7tv) return; // уже отрендерен, текст занулён нами
    const text = node.nodeValue;
    if (!text) return;
    // префильтр: эмоут в тексте или хотя бы слово с разделителем,
    // из которого может выйти предложение подключить набор
    if (!(testRegex && testRegex.test(text)) && !(suggestOn && text.includes('_'))) return;

    const parent = node.parentElement;
    if (!parent) return;
    // не трогаем поле ввода, служебные теги и собственный UI расширения;
    // .vk7tv-text — наш же рендер: без него слово, оставшееся в нём текстом,
    // обрабатывалось бы заново и обрастало чипами до бесконечности
    if (parent.isContentEditable) return;
    if (parent.closest('script,style,textarea,input,title,svg,noscript,template,.vk7tv-ac,.vk7tv-picker,.vk7tv-preview,.vk7tv-widget,.vk7tv-text')) return;
    // подпись ВК, а не текст сообщения — не трогаем ни её саму, ни скобки вокруг
    if (SERVICE_TEXT.test(text.trim())) return;
    if (isServiceText(parent, 3)) return;
    if (isServiceLabel(parent)) return;
    // включён режим «только мессенджер» — вне переписки текст не трогаем
    if (messengerOnly && !inMessenger(parent)) return;

    // эмоут — это отдельное «слово», разделённое пробелами (как в 7TV);
    // zero-width эмоут после обычного накладывается поверх него,
    // пробел между ними при рендере съедается
    const parts = text.split(/(\s+)/);
    let changed = false;
    const frag = document.createDocumentFragment();
    let lastStack = null;
    let pendingWs = '';
    const seen = new Set(); // одно и то же слово в сообщении — один чип
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        pendingWs += part;
        continue;
      }
      const em = emoteMap.get(part);
      if (!em) {
        if (pendingWs) frag.appendChild(document.createTextNode(pendingWs));
        pendingWs = '';
        frag.appendChild(document.createTextNode(part));
        // эмоута нет — может, он из набора, который у нас не подключён
        const chip = suggestFor(part, seen);
        if (chip) {
          frag.appendChild(chip);
          changed = true;
        }
        lastStack = null;
        continue;
      }
      if (em.z && lastStack) {
        lastStack.appendChild(makeEmote(part, em.u, true));
        pendingWs = '';
        changed = true;
        continue;
      }
      if (pendingWs) frag.appendChild(document.createTextNode(pendingWs));
      pendingWs = '';
      lastStack = document.createElement('span');
      lastStack.className = 'vk7tv-stack';
      lastStack.appendChild(makeEmote(part, em.u, false));
      frag.appendChild(lastStack);
      changed = true;
    }
    if (pendingWs) frag.appendChild(document.createTextNode(pendingWs));
    if (!changed) return;

    // ВК — React-приложение: удалять текстовый узел из-под него нельзя,
    // React упадёт на следующей перерисовке (removeChild) и уронит кусок
    // интерфейса. Поэтому узел остаётся на месте с пустым текстом,
    // а рендер вставляется соседним span'ом. Перерисовал React текст
    // обратно — обработчик characterData уберёт span и отрендерит заново.
    const span = document.createElement('span');
    span.className = 'vk7tv-text';
    span.appendChild(frag);
    span._vk7tvSrc = node;
    span._vk7tvText = text;
    node._vk7tv = span;
    node.parentNode.insertBefore(span, node.nextSibling);
    node.nodeValue = '';
  }

  function scan(root) {
    if (!enabled) return;
    if (root.nodeType === Node.TEXT_NODE) {
      processTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) processTextNode(n);
  }

  function unrender() {
    for (const span of document.querySelectorAll('span.vk7tv-text')) {
      const src = span._vk7tvSrc;
      if (src && src.parentNode) {
        src._vk7tv = null;
        src.nodeValue = span._vk7tvText;
        span.remove();
      } else {
        span.replaceWith(document.createTextNode(span._vk7tvText || span.textContent));
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const t = m.target;
        if (t._vk7tv) {
          if (t.nodeValue === '') continue; // это мы сами и занулили
          // React вернул тексту значение — перерисовываем заново
          t._vk7tv.remove();
          t._vk7tv = null;
        }
        processTextNode(t);
      } else {
        for (const n of m.removedNodes) {
          // React убрал текстовый узел — подчищаем наш span-рендер
          if (n.nodeType === Node.TEXT_NODE && n._vk7tv) {
            n._vk7tv.remove();
            n._vk7tv = null;
          }
        }
        for (const n of m.addedNodes) scan(n);
      }
    }
  });

  // Избранное и позиция виджета меняются часто (в том числе из соседней
  // вкладки) — из-за них страницу перебирать незачем.
  const RENDER_KEYS = new Set([
    'enabled', 'useGlobal', 'suggest', 'messengerOnly',
    'sets', 'customEmotes', 'setEmotes', 'globalEmotes',
  ]);

  chrome.storage.onChanged.addListener((changes) => {
    if (!Object.keys(changes).some((k) => RENDER_KEYS.has(k))) return;
    loadState().then((changed) => {
      // Подключили набор — эмоуты должны появиться и в уже показанных
      // сообщениях, а чипы «поставить набор» из них уйти. Поэтому
      // разбираем рендер целиком и собираем заново.
      if (changed) unrender();
      if (enabled) scan(document.body);
    });
  });

  loadState().then(() => {
    scan(document.body);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
})();
