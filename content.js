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
    // коллизии (код в нескольких наборах) — набору, который выше в списке.
    // «67» покажет «67» из него, а конкретный «67_stream» доступен явно.
    // Раньше решал первый по алфавиту слаг, но тогда перестановка наборов
    // ни на что не влияла и выбрать картинку было нельзя.
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
      emoteMap.set(n, list[0].em); // кандидаты складывались в порядке sync.sets
    }
    // Свои эмоуты перебивают наборы и глобальные: их добавил сам
    // пользователь. Второе имя — с id эмоута на 7TV: по нему свой эмоут
    // узнаёт чужое расширение, у которого этого эмоута нет.
    for (const [n, v] of Object.entries(sync.customEmotes)) {
      const em = normEmote(v);
      emoteMap.set(n, em);
      if (em.id) emoteMap.set(`${n}_${em.id}`, { u: em.u, z: em.z, a: n });
    }

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

    // Индекс для автозаполнения: имена в нижнем регистре, разложенные по
    // первой букве. Автозаполнение ищет по началу слова, поэтому нужная
    // корзина всегда одна. Раньше оно перебирало весь emoteMap и звало
    // toLowerCase на каждое имя — на 20 000 эмоутов это тысячи строк
    // на каждое нажатие клавиши.
    // alias — имя с постфиксом набора, у которого есть голое имя: такие
    // прячем, пока в наборе не появится «_» (правило то же, что было
    // в autocomplete.js, но проверка делается один раз здесь).
    // ins — что вставлять в сообщение. У своего эмоута голое имя работает
    // только у автора, поэтому в поле уходит полное имя с id: показываем
    // короткое, вставляем то, что доедет до собеседника.
    acIndex = new Map();
    for (const [n, v] of emoteMap) {
      const l = n.toLowerCase();
      const entry = {
        l,
        n,
        u: v.u,
        alias: !!(v.a && emoteMap.has(v.a)),
        ins: v.id ? `${n}_${v.id}` : n,
      };
      const bucket = acIndex.get(l[0]);
      if (bucket) bucket.push(entry);
      else acIndex.set(l[0], [entry]);
    }

    // общее состояние для autocomplete.js и picker.js (один isolated world)
    window.__vk7tv = { emoteMap, acIndex, enabled, resolveEmote, chain };

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
  // Закрытый спойлер забирает нажатие себе: иначе ВК откроет фото из
  // вложения, а клик по эмоуту внутри — пикер. Раскрываем все закрытые
  // спойлеры над точкой нажатия: текстовый спойлер бывает и внутри
  // сообщения, закрытого целиком.
  const CLOSED_SPOILER =
    '.vk7tv-spoiler:not(.vk7tv-open),.vk7tv-spoiler-media:not(.vk7tv-open)';

  function closedSpoiler(el) {
    return el && el.closest ? el.closest(CLOSED_SPOILER) : null;
  }

  // Сообщение под [spoiler/] открывается целиком: нажал на картинку —
  // открылся и текст, и остальные вложения.
  function openSpoiler(el) {
    el.classList.add('vk7tv-open');
    el._vk7tvOpen = true;
    const rec = el._vk7tvSpoiler;
    if (!rec) return;
    for (const m of rec.media) {
      m.classList.add('vk7tv-open');
      m._vk7tvOpen = true;
    }
    for (const s of rec.spans) s.classList.add('vk7tv-open');
  }

  function onPointer(e) {
    if (closedSpoiler(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type !== 'click') return;
      for (let n = closedSpoiler(e.target); n; n = closedSpoiler(n.parentElement)) {
        openSpoiler(n);
      }
      return;
    }
    // пикер живёт в основном фрейме: во фрейме клик по эмоуту было бы
    // некому обработать, и гасить его незачем. Спойлер выше — наоборот,
    // раскрывается в любом фрейме, обработчик там свой.
    if (window.top !== window) return;
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
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    document.addEventListener(type, onPointer, true);
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

  // --- чужой свой эмоут: имя_<id эмоута на 7TV> ---
  // Постфикс своего эмоута — его id на 7TV, а из id адрес картинки
  // собирается однозначно. Поэтому чужой kek_01H4… рисуется сразу,
  // без подключённых наборов и без запросов к API, а чип рядом кладёт
  // его в свои эмоуты.
  const EMOTE_ID_RE = /^(.+)_([0-9A-HJKMNP-TV-Z]{26})$/i;
  const cdnUrl = (id) => `https://cdn.7tv.app/emote/${id}/2x.webp`;

  // Zero-width — это флаг эмоута на 7TV, в самом слове его нет. Спрашиваем
  // фоновый скрипт один раз на id: пока ответа нет, эмоут рисуется обычным,
  // а с ответом страница перерисовывается и он встаёт поверх предыдущего.
  const idZero = new Map(); // id -> 0 | 1 | PENDING

  function zeroWidthOf(id) {
    const known = idZero.get(id);
    if (known !== undefined) return known === PENDING ? 0 : known;
    idZero.set(id, PENDING);
    chrome.runtime.sendMessage({ type: 'emote-info', id }, (resp) => {
      const z = resp && resp.z ? 1 : 0;
      idZero.set(id, z);
      if (z) scheduleRerender();
    });
    return 0;
  }

  function makeAddCustom(name, id) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vk7tv-suggest';
    btn.title = `«${name}» — чужой свой эмоут. Нажми, чтобы добавить его себе.`;
    const label = document.createElement('span');
    label.className = 'vk7tv-suggest-label';
    label.textContent = '+ себе';
    btn.appendChild(label);
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      label.textContent = 'добавляю…';
      chrome.runtime.sendMessage({ type: 'add-custom', input: id, name }, (resp) => {
        if (!resp || resp.error) {
          btn.disabled = false;
          label.textContent = '+ себе';
          btn.title = (resp && resp.error) || 'Не получилось добавить эмоут';
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

  // Превью последнего сообщения в списке диалогов. Отличаем его от текста
  // в открытом диалоге ради [spoiler/]: закрывать блюром строку диалога
  // вместе с аватаром, именем и временем незачем — вложений в ней всё
  // равно нет, и блюр остаётся на самом тексте.
  const PREVIEW_TOKENS = new Set(['preview', 'previews', 'snippet']);

  function isPreview(el) {
    const tokens = tokensOf(el);
    if (!tokens) return false;
    for (const t of tokens) if (PREVIEW_TOKENS.has(t)) return true;
    return false;
  }

  // Контейнер текста сообщения, в котором лежит узел, или null, если узел
  // вне переписки. Текст сообщения ВК разбивает на куски (ссылки,
  // упоминания, переносы), поэтому идём вверх: сам контейнер бывает
  // и через несколько уровней. Кто встретился первым, тот и решает:
  // превью в непрочитанном диалоге подменяем (MessagePreview ближе, чем
  // строка с «unread» в классе), а число в счётчике — нет.
  function messageTextBox(el) {
    for (let n = el, depth = 0; n && n !== document.body && depth < 12; n = n.parentElement, depth++) {
      if (isCounter(n)) return null;
      if (isMessageText(n)) return n;
    }
    return null;
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

  // --- спойлеры ---
  // [spoiler]текст[/spoiler] прячет под блюром текст, [spoiler/] — всё
  // сообщение вместе с вложениями. На сервере ВК остаётся сам тег обычным
  // текстом, как и коды эмоутов: у кого расширения нет, тот видит тег.
  const SPOILER_ALL = '[spoiler/]';
  const SPOILER_OPEN = '[spoiler]';
  const SPOILER_CLOSE = '[/spoiler]';
  // Сообщение целиком из слова «spoiler» или «спойлер», без скобок, —
  // то же самое, что [spoiler/]. Работает только когда в сообщении больше
  // ничего нет: иначе слово в обычной фразе прятало бы её целиком.
  const SPOILER_WORD = /^\s*(?:spoiler|спойлер)\s*$/i;

  // Префильтр текстового узла. Должен ловить ровно то же, что разбирает
  // parseSpoilers: узел с тегом уходит на разбор всего сообщения, и если
  // разбор тега там не найдёт, эмоуты в сообщении останутся текстом.
  const SPOILER_HINT = /\[spoiler\]|\[\/spoiler\]|\[spoiler\/\]/i;
  const hasSpoilerTag = (t) =>
    (t.includes('[') && SPOILER_HINT.test(t)) || SPOILER_WORD.test(t);

  // Сравнение без учёта регистра и без создания строк: разбор идёт
  // на каждом сообщении, где встретился тег.
  function isTagAt(text, i, tag) {
    if (i + tag.length > text.length) return false;
    for (let k = 0; k < tag.length; k++) {
      let c = text.charCodeAt(i + k);
      if (c >= 65 && c <= 90) c += 32;
      if (c !== tag.charCodeAt(k)) return false;
    }
    return true;
  }

  // Разбор тегов по тексту сообщения. Возвращает куски видимого текста
  // (сами теги вырезаны) с пометкой «под блюром» и флаг «закрыть сообщение
  // целиком». Незакрытый [spoiler] прячет текст до конца сообщения, лишний
  // [/spoiler] выбрасывается.
  function parseSpoilers(text) {
    // всё сообщение — одно слово «spoiler»: прячем содержимое, слово убираем
    if (SPOILER_WORD.test(text)) return { parts: [], all: true };
    const parts = [];
    let all = false;
    let found = false;
    let pos = 0; // начало ещё не разобранного текста
    let open = false;
    for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i)) {
      const tag = isTagAt(text, i, SPOILER_ALL)
        ? SPOILER_ALL
        : isTagAt(text, i, SPOILER_OPEN)
          ? SPOILER_OPEN
          : isTagAt(text, i, SPOILER_CLOSE)
            ? SPOILER_CLOSE
            : null;
      if (!tag) {
        i++;
        continue;
      }
      found = true;
      if (i > pos) parts.push({ from: pos, to: i, spoiler: open });
      pos = i + tag.length;
      i = pos;
      if (tag === SPOILER_ALL) all = true;
      else open = tag === SPOILER_OPEN;
    }
    if (!found) return null;
    if (pos < text.length) parts.push({ from: pos, to: text.length, spoiler: open });
    return { parts, all };
  }

  // Куски текста сообщения, попавшие в узел [base, base+len), —
  // в координатах самого узла.
  function segmentsIn(parts, base, len) {
    const out = [];
    const end = base + len;
    for (const p of parts) {
      if (p.to <= base) continue;
      if (p.from >= end) break;
      out.push({
        from: Math.max(p.from, base) - base,
        to: Math.min(p.to, end) - base,
        spoiler: p.spoiler,
      });
    }
    return out;
  }

  // Сколько уровней над контейнером текста осматриваем в поисках вложений
  // по [spoiler/]. Подниматься надо: они лежат не внутри текста, а рядом
  // с ним — ConvoMessageWithoutBubble__mediaAttachments сосед текста,
  // а не его родитель, и одного уровня хватает. Потолок низкий нарочно:
  // у сообщения без вложений подъём идёт до упора, и чем он выше, тем
  // ближе к соседям — у соседнего сообщения без текста своё фото
  // остановить подъём не может.
  const SPOILER_BOX_DEPTH = 4;
  // Потолок обхода поддерева: выше сообщения лежит вся история переписки,
  // перебирать её целиком незачем. Чужой текст находится в первых же узлах,
  // а если не нашёлся — поддерево для одного сообщения слишком велико.
  const SPOILER_SCAN_LIMIT = 2000;

  // Имя автора над сообщением — не чужой текст, а часть той же строки:
  // в беседах оно стоит рядом с сообщением, и подъём об него спотыкался бы
  // ровно там, где рядом лежит вложение.
  const NAME_TOKENS = new Set([
    'name', 'names', 'author', 'sender', 'nick', 'nickname', 'title', 'from',
  ]);

  function isName(el) {
    const tokens = tokensOf(el);
    if (!tokens) return false;
    for (const t of tokens) if (NAME_TOKENS.has(t)) return true;
    return false;
  }

  // Текст, которого нет в нашем сообщении: по нему видно, что подъём вышел
  // за его пределы. Подписи ВК (время, «ред.»), счётчики и имя автора
  // не в счёт — они стоят при том же сообщении.
  //
  // Границу ищем именно так, а не по классам: у ВК текст и вложения
  // сообщения лежат соседями под родителем с другим именем компонента,
  // и по именам граница сообщения не читается.
  function hasForeignText(box, textRoot) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let seen = 0;
    while (walker.nextNode()) {
      if (++seen > SPOILER_SCAN_LIMIT) return true;
      const t = walker.currentNode;
      if (textRoot.contains(t)) continue;
      const v = (t.nodeValue || '').trim();
      if (!v || SERVICE_TEXT.test(v)) continue;
      const p = t.parentElement;
      if (p && (isServiceLabel(p) || isCounter(p) || isName(p))) continue;
      return true;
    }
    return false;
  }

  // Вложение сообщения: <img class="PhotoItem__img"> внутри
  // Attachments / AttachesGrid / AttachPhotos__link — все они лежат
  // в ConvoMessageWithoutBubble__mediaAttachments. Опознаём по этим кускам
  // имени, потому что аватар собеседника — тоже картинка в том же
  // сообщении, а прятать его не надо.
  const ATTACH_TOKENS = new Set([
    'attach', 'attaches', 'attachment', 'attachments', 'media', 'photo',
    'photos', 'image', 'images', 'video', 'videos', 'gallery', 'sticker',
    'stickers', 'graffiti', 'gif', 'doc', 'docs',
  ]);

  const AVATAR_TOKENS = new Set([
    'avatar', 'avatars', 'userphoto', 'profilephoto', 'thumb', 'thumbs',
  ]);

  // Аватар перебивает вложение: он лежит в том же сообщении и попадается
  // раньше, а его картинка про содержимое ничего не говорит.
  function isAttachment(m, scope) {
    if (m.classList.contains(EMOTE_CLASS) || m.classList.contains('vk7tv-suggest-img')) {
      return false;
    }
    let attach = false;
    for (let n = m, depth = 0; n && n !== scope.parentElement && depth < 8; n = n.parentElement, depth++) {
      const tokens = tokensOf(n);
      if (!tokens) continue;
      for (const t of tokens) {
        if (AVATAR_TOKENS.has(t)) return false;
        if (ATTACH_TOKENS.has(t)) attach = true;
      }
    }
    return attach;
  }

  function eachAttachment(scope, textRoot, fn) {
    for (const m of scope.querySelectorAll('img,video,canvas')) {
      if (textRoot.contains(m)) continue; // эмоуты и чипы — это сам текст
      if (!isAttachment(m, scope)) continue;
      if (fn(m)) return true;
    }
    return false;
  }

  function hasAttachment(scope, textRoot) {
    return eachAttachment(scope, textRoot, () => true);
  }

  // Где искать вложения этого сообщения: от контейнера текста вверх, пока
  // они не попадут внутрь. Дошли до чужого текста, не найдя вложений, —
  // откатываемся на уровень назад: чужое сообщение нам не нужно.
  //
  // Порядок проверок важен: чужой текст смотрим первым. Иначе на уровне
  // списка сообщений нашлось бы фото соседа.
  //
  // Блюр на саму эту область не вешаем: в ней же лежат имя отправителя,
  // время и аватар. Она нужна только чтобы найти вложения — прячем их
  // самих, а текст закрывают наши span'ы.
  function spoilerScope(textRoot) {
    let scope = textRoot;
    let depth = 0;
    for (let n = textRoot.parentElement; n && n !== document.body && depth < SPOILER_BOX_DEPTH; n = n.parentElement, depth++) {
      if (hasForeignText(n, textRoot)) break;
      scope = n;
      if (hasAttachment(n, textRoot)) break;
    }
    return scope;
  }

  // --- вложения под блюром ---

  const SPOILER_MEDIA = 'vk7tv-spoiler-media';

  // Сообщения с [spoiler/], которые сейчас на экране. ВК дорисовывает
  // картинку позже текста (ленивая загрузка, докачка превью), поэтому
  // список вложений пересобирается на каждую пачку изменений страницы.
  const hidden = new Set();

  // React переписывает class у <img>, когда картинка догрузилась
  // (PhotoItem__img--loaded), и вместе со своим стирает наш — блюр
  // слетал прямо при загрузке. Возвращаем его на место.
  const mediaWatcher = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const el = m.target;
      if (!el._vk7tvHidden || el.classList.contains(SPOILER_MEDIA)) continue;
      el.classList.add(SPOILER_MEDIA);
      if (el._vk7tvOpen) el.classList.add('vk7tv-open');
    }
  });

  function hideMedia(rec) {
    eachAttachment(rec.scope, rec.textRoot, (m) => {
      if (m._vk7tvHidden) return false;
      m._vk7tvHidden = true;
      m._vk7tvSpoiler = rec;
      m.classList.add(SPOILER_MEDIA);
      rec.media.push(m);
      mediaWatcher.observe(m, { attributes: true, attributeFilter: ['class'] });
      return false;
    });
  }

  function showMedia(rec) {
    for (const m of rec.media) {
      m._vk7tvHidden = false;
      m._vk7tvOpen = false;
      m._vk7tvSpoiler = null;
      m.classList.remove(SPOILER_MEDIA, 'vk7tv-open');
    }
    rec.media.length = 0;
  }

  // Страница поменялась: у сообщений со спойлером могли появиться новые
  // картинки, а сами сообщения — уехать со страницы.
  function refreshHidden() {
    for (const rec of hidden) {
      if (!rec.scope.isConnected) {
        showMedia(rec);
        hidden.delete(rec);
        continue;
      }
      hideMedia(rec);
    }
  }

  // --- рендер ---

  // Общие запреты: поле ввода, служебные теги и собственный UI расширения;
  // .vk7tv-text — наш же рендер: без него слово, оставшееся в нём текстом,
  // обрабатывалось бы заново и обрастало чипами до бесконечности.
  // Возвращает родителя узла, если узел трогать можно.
  function renderable(node) {
    const parent = node.parentElement;
    if (!parent) return null;
    if (parent.isContentEditable) return null;
    if (parent.closest('script,style,textarea,input,title,svg,noscript,template,.vk7tv-ac,.vk7tv-picker,.vk7tv-preview,.vk7tv-widget,.vk7tv-text')) return null;
    // подпись ВК, а не текст сообщения — не трогаем ни её саму, ни скобки вокруг
    const text = node.nodeValue || '';
    if (SERVICE_TEXT.test(text.trim())) return null;
    if (isServiceText(parent, 3)) return null;
    if (isServiceLabel(parent)) return null;
    // включён режим «только мессенджер» — вне текста сообщения не трогаем.
    // Счётчики, меню и шапка отсекаются этой же проверкой: они лежат вне
    // контейнера сообщения.
    if (!everywhere && !messageTextBox(parent)) return null;
    return parent;
  }

  // Рендер куска текста [from, to) в узел target: слова-коды становятся
  // картинками, остальное переносится текстом. Возвращает true, если хоть
  // одно слово заменили.
  //
  // Эмоут — это отдельное «слово», разделённое пробелами (как в 7TV);
  // zero-width эмоут после обычного накладывается поверх него, пробел
  // между ними при рендере съедается.
  //
  // Идём по словам сами, а не через split: текст между находками
  // переносится одним куском (flushed — граница уже перенесённого).
  // Слова без находок не стоят ни одной аллокации.
  function renderRange(target, text, from, to, seen) {
    let changed = false;
    let flushed = from;
    let lastStack = null;
    let i = from;
    while (i < to) {
      while (i < to && isWs(text.charCodeAt(i))) i++;
      if (i >= to) break;
      const start = i;
      let underscore = false;
      while (i < to) {
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
        if (start > flushed) target.appendChild(document.createTextNode(text.slice(flushed, start)));
        lastStack = document.createElement('span');
        lastStack.className = 'vk7tv-stack';
        lastStack.appendChild(makeEmote(text.slice(start, end), em.u, false));
        target.appendChild(lastStack);
        flushed = end;
        changed = true;
        continue;
      }

      // Стопку обнуляем только на словах, которые эмоутом не стали: чужой
      // эмоут ниже сам решает, лечь ли поверх предыдущего.
      if (!underscore) {
        lastStack = null;
        continue;
      }
      const word = text.slice(start, end);

      // чужой свой эмоут: имя и id — прямо в слове, картинку собираем из id
      const byId = EMOTE_ID_RE.exec(word);
      if (byId) {
        const emName = byId[1];
        const emId = byId[2].toUpperCase();
        if (zeroWidthOf(emId) && lastStack) {
          // как и у эмоута из набора: ложится поверх предыдущего,
          // пробел между ними во фрагмент не попадает
          lastStack.appendChild(makeEmote(emName, cdnUrl(emId), true));
        } else {
          if (start > flushed) target.appendChild(document.createTextNode(text.slice(flushed, start)));
          lastStack = document.createElement('span');
          lastStack.className = 'vk7tv-stack';
          lastStack.appendChild(makeEmote(emName, cdnUrl(emId), false));
          target.appendChild(lastStack);
        }
        if (!seen.has(word)) {
          seen.add(word); // одно и то же слово в сообщении — один чип
          target.appendChild(makeAddCustom(emName, emId));
        }
        flushed = end;
        changed = true;
        continue;
      }

      // эмоута нет — может, он из набора, который у нас не подключён
      lastStack = null;
      if (!suggestOn) continue;
      const chip = suggestFor(word, seen);
      if (!chip) continue;
      target.appendChild(document.createTextNode(text.slice(flushed, end)));
      target.appendChild(chip);
      flushed = end;
      changed = true;
    }
    if (flushed < to) target.appendChild(document.createTextNode(text.slice(flushed, to)));
    return changed;
  }

  // ВК — React-приложение: удалять текстовый узел из-под него нельзя,
  // React упадёт на следующей перерисовке (removeChild) и уронит кусок
  // интерфейса. Поэтому узел остаётся на месте с пустым текстом,
  // а рендер вставляется соседним span'ом. Перерисовал React текст
  // обратно — обработчик characterData уберёт span и отрендерит заново.
  //
  // rec — сообщение, вложения которого этот рендер спрятал по [spoiler/]:
  // рендер снимается вместе с блюром, иначе закрытыми останутся картинки
  // чужого сообщения, которое ВК положит в переиспользованную разметку.
  function mount(node, frag, rec) {
    const span = document.createElement('span');
    span.className = 'vk7tv-text';
    span.appendChild(frag);
    span._vk7tvSrc = node;
    span._vk7tvText = node.nodeValue;
    span._vk7tvRec = rec || null;
    node._vk7tv = span;
    node.parentNode.insertBefore(span, node.nextSibling);
    node.nodeValue = '';
  }

  function clearRec(span) {
    const rec = span._vk7tvRec;
    if (!rec) return;
    span._vk7tvRec = null;
    showMedia(rec);
    hidden.delete(rec);
  }

  function dropSpan(span) {
    clearRec(span);
    span.remove();
  }

  /** Снять наш рендер с узла и вернуть ему исходный текст. */
  function undo(node) {
    const span = node._vk7tv;
    node._vk7tv = null;
    if (!span) return;
    if (span._vk7tvText != null) node.nodeValue = span._vk7tvText;
    dropSpan(span);
  }

  function renderPlain(node) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    if (!renderRange(frag, text, 0, text.length, new Set())) return;
    mount(node, frag, null);
  }

  // Спойлер разрывается разметкой ВК: перенос строки, ссылка, упоминание —
  // каждый кусок текста лежит в своём узле, и [spoiler] с [/spoiler]
  // попадают в разные. Поэтому теги ищем не в одном узле, а по тексту
  // сообщения целиком, а найденные диапазоны раздаём обратно по узлам.
  function renderMessage(node, parent) {
    const textBox = messageTextBox(parent);
    const root = textBox || parent;
    // Прежний рендер разбираем: соседние куски сообщения могли отрисоваться
    // раньше, чем в него доехал узел с закрывающим тегом.
    for (const t of textNodes(root)) undo(t);

    const nodes = [];
    for (const t of textNodes(root)) if (renderable(t)) nodes.push(t);
    if (!nodes.length) return;

    let full = '';
    const bases = [];
    for (const t of nodes) {
      bases.push(full.length);
      full += t.nodeValue;
    }
    const parsed = parseSpoilers(full);
    if (!parsed) {
      // тег был в узле, но в тексте сообщения не нашёлся — рисуем как обычно
      for (const t of nodes) renderPlain(t);
      return;
    }

    // [spoiler/] — под блюром всё содержимое сообщения: текст закрывают
    // наши span'ы, вложения прячутся поштучно. У превью в списке диалогов
    // вложений нет, искать их вокруг незачем — там только текст.
    let rec = null;
    if (parsed.all && !(textBox && isPreview(textBox))) {
      rec = { scope: spoilerScope(root), textRoot: root, media: [], spans: [] };
      hideMedia(rec);
      hidden.add(rec);
    }
    const textOnly = parsed.all;
    let owner = rec; // рендер, который потом снимет блюр с вложений

    const seen = new Set(); // одно и то же слово в сообщении — один чип
    for (let k = 0; k < nodes.length; k++) {
      const t = nodes[k];
      const text = t.nodeValue;
      const segs = segmentsIn(parsed.parts, bases[k], text.length);
      // узел целиком вне спойлера и без тегов — обычный путь, без обёртки
      const plain =
        !textOnly &&
        segs.length === 1 &&
        !segs[0].spoiler &&
        segs[0].from === 0 &&
        segs[0].to === text.length;
      const frag = document.createDocumentFragment();
      let changed = !plain; // теги вырезаны или текст ушёл под блюр
      // Между двумя скрытыми кусками стоял вырезанный тег, и в готовом
      // тексте они идут подряд: держим их в одном span, иначе на стыке
      // двух блюров видна полоса.
      let blurred = null;
      for (const s of segs) {
        if (!(s.spoiler || textOnly)) {
          blurred = null;
          if (renderRange(frag, text, s.from, s.to, seen)) changed = true;
          continue;
        }
        if (!blurred) {
          blurred = document.createElement('span');
          blurred.className = 'vk7tv-spoiler';
          blurred.title = 'Спойлер — нажми, чтобы открыть';
          // клик по тексту открывает и картинки того же сообщения
          if (rec) {
            blurred._vk7tvSpoiler = rec;
            rec.spans.push(blurred);
          }
          frag.appendChild(blurred);
        }
        renderRange(blurred, text, s.from, s.to, seen);
      }
      if (!changed) continue;
      mount(t, frag, owner);
      owner = null; // блюр снимает тот рендер, который его поставил
    }
  }

  function processTextNode(node) {
    if (!enabled) return;
    if (node._vk7tv) return; // уже отрендерен, текст занулён нами
    const text = node.nodeValue;
    if (!text) return;
    // префильтр: эмоут в тексте, тег спойлера или хотя бы слово
    // с разделителем — из него может выйти чужой свой эмоут (имя_id)
    // или предложение поставить набор
    const spoiler = hasSpoilerTag(text);
    if (!spoiler && !(testRegex && testRegex.test(text)) && !text.includes('_')) return;

    const parent = renderable(node);
    if (!parent) return;
    if (spoiler) renderMessage(node, parent);
    else renderPlain(node);
  }

  function textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
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
    for (const n of textNodes(root)) processTextNode(n);
  }

  function unrender() {
    for (const span of document.querySelectorAll('span.vk7tv-text')) {
      const src = span._vk7tvSrc;
      if (src && src.parentNode) {
        src._vk7tv = null;
        src.nodeValue = span._vk7tvText;
        dropSpan(span);
      } else {
        clearRec(span);
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
          dropSpan(t._vk7tv);
          t._vk7tv = null;
        }
        processTextNode(t);
      } else {
        for (const n of m.removedNodes) {
          // React убрал текстовый узел — подчищаем наш span-рендер
          if (n.nodeType === Node.TEXT_NODE && n._vk7tv) {
            dropSpan(n._vk7tv);
            n._vk7tv = null;
          }
        }
        for (const n of m.addedNodes) scan(n);
      }
    }
    // Картинка в сообщении со спойлером могла приехать только сейчас —
    // ВК грузит превью и вложения позже текста.
    if (hidden.size) refreshHidden();
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
