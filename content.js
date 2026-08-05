// VK7TV — контент-скрипт.
// Ищет в тексте страницы слова-коды эмоутов и заменяет их на <img>.
// Текст сообщения при этом остаётся текстом на сервере ВК — картинку
// видит каждый, у кого стоит расширение с тем же набором эмоутов.

(() => {
  const EMOTE_CLASS = 'vk7tv-emote';

  let enabled = true;
  let suggestOn = true;
  let everywhere = false; // по умолчанию только в переписке; тогл включает везде
  let emoteMap = new Map(); // имя -> URL картинки
  let testRegex = null; // быстрый префильтр текстовых узлов
  let stateSig = ''; // подпись набора эмоутов и настроек

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Границы слов — как у /\s/ в регекспе, но без создания строки на символ
  function isWs(c) {
    return (
      c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
      c === 8287 || c === 12288 || c === 65279
    );
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

  // слово-кандидат: буквы/цифры/«_» и немного пунктуации имени эмоута
  // (-F, ellen?, (7TV), D:), с разделителем внутри и не короче «xx_yyy».
  // Хвостовые и подряд идущие «_» допускаем — ник бывает таким
  // (peeb_iluci____). Точку/запятую/слэш/собаку не берём: это обычный
  // текст или ссылка. Границу «эмоут|ник» разбирает splitCandidates
  // в фоне, а сам ник от пунктуации защищает его собственная проверка.
  const SUGGEST_RE = /^[\w()!?:-]{5,60}$/;
  const looksLikeSetEmote = (w) => SUGGEST_RE.test(w) && w.includes('_');

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
      everywhere: false,
      sets: [],
      customEmotes: {},
    });
    const local = await chrome.storage.local.get({ setEmotes: {}, globalEmotes: null });

    enabled = sync.enabled;
    suggestOn = sync.suggest;
    everywhere = sync.everywhere;
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
    // а набору стримера достаётся: если код есть в одном наборе — ему, а при
    // коллизии (код в нескольких наборах) — набору, чей слаг первый по
    // алфавиту. «67» покажет «67» из этого набора, а конкретный «67_stream»
    // доступен явно. По алфавиту, а не случайно, — тогда у всех с одинаковыми
    // наборами картинка под «67» совпадает (слаг у всех один, в отличие
    // от переименованного названия).
    // a — голое имя эмоута, пометка «это алиас» для автозаполнения.
    const fromSets = new Map(); // голое имя -> [{slug, em}] из наборов с этим кодом
    for (const s of sync.sets) {
      const m = local.setEmotes[s.id];
      if (!m) continue;
      for (const [n, v] of Object.entries(m)) {
        const em = normEmote(v);
        if (s.slug) emoteMap.set(`${n}_${s.slug}`, { u: em.u, z: em.z, a: n });
        const cand = { slug: s.slug || '', em };
        const list = fromSets.get(n);
        if (list) list.push(cand);
        else fromSets.set(n, [cand]);
      }
    }
    for (const [n, list] of fromSets) {
      if (emoteMap.has(n)) continue; // занято глобальным или своими
      // первый по алфавиту слаг; url — тай-брейк на случай равных слагов
      list.sort((a, b) => a.slug.localeCompare(b.slug) || a.em.u.localeCompare(b.em.u));
      emoteMap.set(n, list[0].em);
    }
    for (const [n, v] of Object.entries(sync.customEmotes)) emoteMap.set(n, normEmote(v));

    // Префильтр строим по голым именам: имя с постфиксом содержит голое
    // как подстроку, поэтому такой текст регексп поймает и без него. Голое
    // имя теперь есть у любого кода из наборов, так что постфиксные имена
    // в префильтр можно не класть.
    //
    // Одна альтернатива из всех имён выглядит тяжело, но пробовали заменить
    // её проходом по словам с отсевом по длине и первому символу — на тексте
    // страницы это оказалось в разы медленнее и на 1000 имён, и на 20000:
    // движок регекспов отсеивает по первым символам сразу по всей строке.
    const probes = [];
    for (const [n, v] of emoteMap) if (!v.a || !emoteMap.has(v.a)) probes.push(n);
    testRegex = probes.length ? new RegExp(probes.map(escapeRegex).join('|')) : null;

    // общее состояние для autocomplete.js и picker.js (один isolated world)
    window.__vk7tv = { emoteMap, enabled, resolveEmote, chain };

    // Подпись состояния: по ней видно, надо ли перерисовывать уже
    // показанные сообщения. Фоновое обновление наборов раз в полчаса
    // пишет в хранилище то же самое, и трогать из-за него страницу незачем.
    const sig = [
      enabled,
      suggestOn,
      everywhere,
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
    // адрес с CDN, а не итоговый src: в src может лежать blob:, а пикер
    // ищет набор по тому же адресу, что записан в хранилище
    img._vk7tvUrl = url;
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

  // Клик по эмоуту в сообщении открывает пикер на наборе, из которого этот
  // эмоут: увидел картинку в чате — сразу видно, откуда она и что рядом.
  // Событие ловит picker.js — оба скрипта живут в одном isolated world.
  //
  // Слушаем на перехвате и гасим событие: у ВК свои обработчики и на
  // сообщении, и на строке списка диалогов, а клик по эмоуту не должен
  // заодно открывать переписку. Нажатие гасим тоже — строку диалога ВК
  // открывает по нему, до click дело не доходит.
  function onEmotePointer(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains(EMOTE_CLASS)) return;
    e.preventDefault(); // заодно не забираем фокус у поля ввода ВК
    e.stopPropagation();
    if (e.type !== 'click') return;
    document.dispatchEvent(
      new CustomEvent('vk7tv-reveal-emote', {
        detail: { name: img.alt, url: img._vk7tvUrl || '' },
      })
    );
  }
  // только в основном фрейме: пикер живёт там же, и во фрейме клик было бы
  // некому обработать — гасить его незачем
  if (window.top === window) {
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      document.addEventListener(type, onEmotePointer, true);
    }
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

  // --- ограничение области: по умолчанию только переписка ---
  // Без галки «Показывать эмоуты везде» подменяем не «где-то в разделе
  // сообщений», а внутри самого контейнера текста сообщения. Раньше весь
  // раздел /im считался перепиской целиком, и картинки вставали в левое меню,
  // в шапку чата и в счётчики; запрещать обвязку по списку не вышло — её
  // контейнеры лежат выше сообщений и глушили подмену вообще везде.
  //
  // Разметка ВК: <div class="MessageText"> — текст сообщения в открытом
  // диалоге, <span class="MessagePreview"> — превью последнего сообщения
  // в списке диалогов. Опознаём их парой кусков в имени: «про переписку»
  // (message, im, msg, dialog…) и «это текст» (text, preview, body…).
  // Пара, а не точное имя: у ВК несколько сборок разметки (MessageText,
  // im-mess--text, nim-dialog--text), и все они под это правило подходят,
  // а шапка чата (ConvoTitle) и счётчики — нет.
  const MSG_TOKENS = new Set([
    'im', 'msg', 'msgs', 'mess', 'message', 'messages', 'messaging',
    'dialog', 'dialogs', 'chat', 'chats', 'convo', 'conversation',
    'conversations', 'peer', 'bubble', 'history',
  ]);

  const CONTENT_TOKENS = new Set([
    'text', 'texts', 'preview', 'previews', 'body', 'content', 'contents',
    'caption', 'snippet',
  ]);

  // Счётчик внутри строки диалога: <div class="UnreadCounter">40</div>.
  // Сам он под правило выше не подходит, но строка диалога, в которой он
  // лежит, — подходит (ConvoListItem__body: convo + body), и при подъёме
  // разрешение доставалось и счётчику. В наборах есть эмоуты с числовыми
  // именами, и «40» непрочитанных превращалось в картинку. Поэтому счётчик
  // перебивает разрешение: он ближе к тексту, чем строка диалога.
  const COUNTER_TOKENS = new Set([
    'counter', 'counters', 'count', 'counts', 'badge', 'badges', 'unread', 'unseen',
  ]);

  // «im-mess--text» → im mess text, «MessagePreview» → message preview;
  // режем по границам, чтобы «time»/«image» не читались как «im»
  function tokensOf(el) {
    if (!el.getAttribute) return null;
    const raw =
      (el.getAttribute('class') || '') + ' ' +
      (el.getAttribute('data-testid') || '') + ' ' + (el.id || '');
    if (!raw.trim()) return null;
    return raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  }

  function isMessageText(el) {
    const tokens = tokensOf(el);
    if (!tokens) return false;
    let msg = false;
    let content = false;
    for (const t of tokens) {
      if (MSG_TOKENS.has(t)) msg = true;
      else if (CONTENT_TOKENS.has(t)) content = true;
    }
    return msg && content;
  }

  function isCounter(el) {
    const tokens = tokensOf(el);
    if (!tokens) return false;
    for (const t of tokens) if (COUNTER_TOKENS.has(t)) return true;
    return false;
  }

  // Текст сообщения ВК разбивает на куски (ссылки, упоминания, переносы),
  // поэтому идём вверх: сам контейнер бывает и через несколько уровней.
  // Кто встретился первым, тот и решает: превью в непрочитанном диалоге
  // подменяем (MessagePreview ближе, чем строка с «unread» в классе),
  // а число в счётчике — нет.
  function inMessenger(el) {
    for (let n = el, depth = 0; n && n !== document.body && depth < 12; n = n.parentElement, depth++) {
      if (isCounter(n)) return false;
      if (isMessageText(n)) return true;
    }
    return false;
  }

  // Диагностика области: в инспекторе выбрать узел и позвать в консоли
  // __vk7tv.chain($0). Печатает цепочку контейнеров вверх — по ней видно,
  // каким куском разметки ВК отличает текст сообщения от обвязки.
  function chain(el) {
    const out = [];
    for (let n = el, depth = 0; n && n !== document.documentElement && depth < 12; n = n.parentElement, depth++) {
      const attrs = [n.getAttribute('class'), n.getAttribute('data-testid'), n.id]
        .filter(Boolean)
        .join(' | ');
      const mark = isCounter(n) ? '  ← счётчик' : isMessageText(n) ? '  ← сообщение' : '';
      out.push(`${depth}: ${n.tagName}${attrs ? ' ' + attrs : ''}${mark}`);
    }
    return out.join('\n');
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
    // включён режим «только мессенджер» — вне текста сообщения не трогаем.
    // Счётчики, меню и шапка отсекаются этой же проверкой: они лежат вне
    // контейнера сообщения.
    if (!everywhere && !inMessenger(parent)) return;

    // Эмоут — это отдельное «слово», разделённое пробелами (как в 7TV);
    // zero-width эмоут после обычного накладывается поверх него, пробел
    // между ними при рендере съедается.
    //
    // Идём по словам сами, а не через split: фрагмент создаётся только
    // с первой находки, а текст до неё переносится одним куском (flushed —
    // граница уже перенесённого). Слова без находок не стоят ни одной
    // аллокации.
    const n = text.length;
    const frag = document.createDocumentFragment();
    let changed = false;
    let flushed = 0;
    let lastStack = null;
    let seen = null; // одно и то же слово в сообщении — один чип
    let i = 0;
    while (i < n) {
      while (i < n && isWs(text.charCodeAt(i))) i++;
      if (i >= n) break;
      const start = i;
      let underscore = false;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (isWs(c)) break;
        if (c === 95) underscore = true;
        i++;
      }
      const end = i;
      const em = emoteMap.get(text.slice(start, end));

      if (em) {
        if (em.z && lastStack) {
          lastStack.appendChild(makeEmote(text.slice(start, end), em.u, true));
          flushed = end; // пробел перед zero-width во фрагмент не попадает
          changed = true;
          continue;
        }
        if (start > flushed) frag.appendChild(document.createTextNode(text.slice(flushed, start)));
        lastStack = document.createElement('span');
        lastStack.className = 'vk7tv-stack';
        lastStack.appendChild(makeEmote(text.slice(start, end), em.u, false));
        frag.appendChild(lastStack);
        flushed = end;
        changed = true;
        continue;
      }

      lastStack = null;
      // эмоута нет — может, он из набора, который у нас не подключён
      if (!suggestOn || !underscore) continue;
      if (!seen) seen = new Set();
      const chip = suggestFor(text.slice(start, end), seen);
      if (!chip) continue;
      frag.appendChild(document.createTextNode(text.slice(flushed, end)));
      frag.appendChild(chip);
      flushed = end;
      changed = true;
    }
    if (!changed) return;
    if (flushed < n) frag.appendChild(document.createTextNode(text.slice(flushed)));

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
    'enabled', 'useGlobal', 'suggest', 'everywhere',
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
