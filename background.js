// VK7TV — фоновый воркер.
// Две задачи:
//  1) тянуть наборы эмоутов из открытого API 7TV и кэшировать их в storage;
//  2) скачивать картинки, которые страница не смогла загрузить сама
//     (если CSP ВК зарежет сторонний CDN), и отдавать их как data:-URL.

const SET_API = 'https://7tv.io/v3/emote-sets/';
// ID наборов 7TV — это ULID: 26 символов Crockford base32
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/i;

const imgCache = new Map();

// Пропорции картинки (ширина/высота) — их знает только API, а пикеру они
// нужны заранее: по ним он держит место под эмоут до того, как картинка
// загрузится, иначе сетка после загрузки прыгает. Берём файл 2x — тот
// самый, что показываем.
function ratioOf(host) {
  const files = (host && host.files) || [];
  const f = files.find((x) => x.name === '2x.webp') || files.find((x) => x.width && x.height);
  if (!f || !f.width || !f.height) return 1;
  return Math.round((f.width / f.height) * 100) / 100;
}

// Формат значения: {u: url картинки, z: 1 если zero-width, r: пропорции}.
// Флаг 1 у активного эмоута в 7TV — ZERO_WIDTH: эмоут не занимает
// место, а накладывается поверх предыдущего.
function emoteMapFromSet(setJson) {
  const map = {};
  for (const e of setJson.emotes || []) {
    if (e && e.name && e.id) {
      map[e.name] = {
        u: `https://cdn.7tv.app/emote/${e.id}/2x.webp`,
        z: (e.flags || 0) & 1 ? 1 : 0,
        r: ratioOf(e.data && e.data.host),
      };
    }
  }
  return map;
}

// Кэш, снятый до появления пропорций, для сетки бесполезен — такой набор
// перекачиваем, даже когда полного обновления не просили.
function hasRatios(map) {
  for (const v of Object.values(map)) return !!(v && v.r);
  return true; // пустой набор перекачивать незачем
}

// Постфикс набора: из него получается второе имя эмоута — ok_bratishkinoff.
// Берём ник владельца набора на 7TV, он же ник стримера на Twitch.
function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}

// Ошибка сети/API -> человекопонятный текст. «Failed to fetch» (DNS, обрыв,
// блокировка провайдером) в РФ почти всегда значит, что до 7tv.io не достучаться
// без VPN. Сырое «HTTP 500» пользователю тоже не показываем. Наши собственные
// брошенные тексты («Стример не найден» и т.п.) отдаём как есть.
function humanError(e) {
  const msg = String((e && e.message) || e || '');
  if (e instanceof TypeError || /Failed to fetch|NetworkError|network\s*error/i.test(msg)) {
    return 'Не удаётся связаться с 7tv.io — похоже, без VPN он недоступен';
  }
  if (/\bHTTP\s+\d{3}\b/.test(msg)) return '7TV сейчас недоступен, попробуй позже';
  // Потолок chrome.storage.sync — 8 КБ на запись; браузер отдаёт про это
  // «QUOTA_BYTES_PER_ITEM quota exceeded», человеку это ни о чём
  if (/QUOTA_BYTES|quota exceeded/i.test(msg)) {
    return 'Настройки не поместились в хранилище браузера — удали часть своих эмоутов или наборов';
  }
  return msg || 'Что-то пошло не так';
}

async function fetchSet(idOrGlobal) {
  const resp = await fetch(SET_API + idOrGlobal, { cache: 'no-cache' });
  if (resp.status === 404) throw new Error('Набор 7TV с таким ID не найден — проверь ссылку');
  if (!resp.ok) throw new Error('7TV API: HTTP ' + resp.status);
  const json = await resp.json();
  return {
    id: json.id,
    name: json.name || idOrGlobal,
    slug: slugify((json.owner && json.owner.username) || json.name || ''),
    emotes: emoteMapFromSet(json),
  };
}

// Ник стримера -> его Twitch ID -> активный набор 7TV.
// Основной путь через api.ivr.fi (открытый резолвер Twitch-ников),
// запасной — через поиск в GQL самого 7TV.
async function fetchStreamerSet(login) {
  try {
    return await viaIvr(login);
  } catch (e) {
    return await viaGql(login);
  }
}

async function viaIvr(login) {
  const resp = await fetch('https://api.ivr.fi/v2/twitch/user?login=' + encodeURIComponent(login));
  if (!resp.ok) throw new Error('ivr.fi: HTTP ' + resp.status);
  const arr = await resp.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error(`Стример «${login}» не найден на Twitch`);
  const uResp = await fetch('https://7tv.io/v3/users/twitch/' + arr[0].id, { cache: 'no-cache' });
  if (!uResp.ok) throw new Error(`У «${login}» нет профиля 7TV`);
  const es = (await uResp.json()).emote_set;
  if (!es || !es.id) throw new Error(`У «${login}» нет активного набора 7TV`);
  // ник, по которому добавляли, — самый понятный постфикс
  if (es.emotes && es.emotes.length) {
    return { id: es.id, name: es.name || login, slug: slugify(login), emotes: emoteMapFromSet(es) };
  }
  return { ...(await fetchSet(es.id)), slug: slugify(login) };
}

async function viaGql(login) {
  const resp = await fetch('https://7tv.io/v3/gql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($q:String!){users(query:$q){id username}}',
      variables: { q: login },
    }),
  });
  if (!resp.ok) throw new Error('7TV GQL: HTTP ' + resp.status);
  const json = await resp.json();
  const user = ((json.data || {}).users || []).find((u) => u.username === login);
  if (!user) throw new Error(`Стример «${login}» не найден на 7TV`);
  const uResp = await fetch('https://7tv.io/v3/users/' + user.id, { cache: 'no-cache' });
  if (!uResp.ok) throw new Error('7TV API: HTTP ' + uResp.status);
  const conn = ((await uResp.json()).connections || []).find(
    (c) => c.platform === 'TWITCH' && c.emote_set_id
  );
  if (!conn) throw new Error(`У «${login}» нет активного набора 7TV`);
  return { ...(await fetchSet(conn.emote_set_id)), slug: slugify(login) };
}

// Принимает ссылку вида https://7tv.app/emote-sets/<id>, голый ID
// или ник стримера на Twitch (bratishkinoff, 5opka, …)
async function addSet(input) {
  const str = String(input).trim();
  const m = str.match(ULID_RE);
  let set;
  if (m) {
    set = await fetchSet(m[0].toUpperCase());
  } else if (/^[a-zA-Z0-9_]{1,25}$/.test(str)) {
    set = await fetchStreamerSet(str.toLowerCase());
  } else {
    throw new Error('Вставь ссылку на набор с 7tv.app или ник стримера на Twitch.');
  }
  return storeSet(set);
}

async function storeSet(set) {
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const { setEmotes } = await chrome.storage.local.get({ setEmotes: {} });
  setEmotes[set.id] = set.emotes;
  const meta = {
    id: set.id,
    name: set.name,
    slug: set.slug || '',
    count: Object.keys(set.emotes).length,
  };
  await chrome.storage.local.set({ setEmotes });
  await chrome.storage.sync.set({ sets: sets.filter((s) => s.id !== set.id).concat(meta) });
  return meta;
}

async function removeSet(id) {
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const { setEmotes } = await chrome.storage.local.get({ setEmotes: {} });
  delete setEmotes[id];
  await chrome.storage.local.set({ setEmotes });
  await chrome.storage.sync.set({ sets: sets.filter((s) => s.id !== id) });
}

// Наборы меняются редко — раз в месяц кто-то добавит эмоут, — а проверка
// каждого при старте браузера это запрос к API на набор. Поэтому по умолчанию
// берём кэш и ходим в сеть только за тем, чего в нём нет; полное обновление —
// по кнопке «↻ Обновить наборы» в попапе.
async function refreshAll(force = false) {
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const { setEmotes: oldCache, globalEmotes } = await chrome.storage.local.get({
    setEmotes: {},
    globalEmotes: null,
  });
  const setEmotes = {};
  const nextSets = [];
  // Неудачи по каждому набору собираем и отдаём наверх: раньше они молча
  // тонули в catch, и попап писал «Готово, эмоуты загружены», даже когда
  // не скачалось ни одного набора.
  const failed = []; // эмоутов нет вовсе — набор в поповере не появится
  const stale = []; // обновить не удалось, показываем прошлый кэш
  let lastError = null;
  for (const s of sets) {
    if (!force && oldCache[s.id] && hasRatios(oldCache[s.id])) {
      setEmotes[s.id] = oldCache[s.id];
      nextSets.push(s);
      continue;
    }
    try {
      const set = await fetchSet(s.id);
      setEmotes[set.id] = set.emotes;
      nextSets.push({
        id: set.id,
        name: set.name,
        // набор мог быть добавлен по нику — тогда постфикс уже сохранён
        slug: s.slug || set.slug || '',
        count: Object.keys(set.emotes).length,
      });
    } catch (e) {
      // API недоступен — оставляем прошлый кэш этого набора
      lastError = e;
      if (oldCache[s.id]) {
        setEmotes[s.id] = oldCache[s.id];
        stale.push(s.name || s.id);
      } else {
        failed.push(s.name || s.id);
      }
      nextSets.push(s);
    }
  }
  const localPatch = { setEmotes };
  if (force || !globalEmotes || !Object.keys(globalEmotes).length || !hasRatios(globalEmotes)) {
    try {
      const g = await fetchSet('global');
      if (Object.keys(g.emotes).length) localPatch.globalEmotes = g.emotes;
    } catch (e) {
      // глобальный набор есть в default-emotes.js, без обновления не страшно
    }
  }
  await chrome.storage.local.set(localPatch);
  await chrome.storage.sync.set({ sets: nextSets });
  return {
    sets: nextSets.length,
    failed,
    stale,
    // причина одна на всех: если 7tv.io недоступен, он недоступен для всего
    cause: failed.length || stale.length ? humanError(lastError) : '',
  };
}

// --- предложение подключить набор стримера ---
// В чат прилетело non_nicosl, такого эмоута у нас нет: похоже, у собеседника
// подключён набор nicosl. Прежде чем предлагать его поставить, проверяем по
// API, что стример существует и эмоут в его наборе правда лежит — иначе
// расширение предлагало бы наборы на каждое слово с подчёркиванием.
// Кэш живёт до перезагрузки воркера и хранит в том числе отрицательный
// ответ (null): чат может сыпать одним и тем же словом сколько угодно.
const probedSets = new Map(); // slug -> Promise<набор|null>

function probeStreamerSet(slug) {
  if (!probedSets.has(slug)) probedSets.set(slug, fetchStreamerSet(slug).catch(() => null));
  return probedSets.get(slug);
}

// Где в слове проходит граница «эмоут | стример», заранее неизвестно:
// в ok_bratishkinoff подчёркивание одно, а в SEXALARM_kanba_mx ник сам
// с подчёркиванием — стример тут kanba_mx. Поэтому перебираем разделители
// слева направо (ник длиннее — вероятнее) и берём первый вариант, который
// сойдётся: и стример есть, и эмоут в его наборе лежит.
const MAX_SPLITS = 3;

function splitCandidates(word) {
  const out = [];
  for (let i = word.indexOf('_'); i > 0 && out.length < MAX_SPLITS; i = word.indexOf('_', i + 1)) {
    const name = word.slice(0, i);
    const slug = word.slice(i + 1).toLowerCase();
    // хвостовой «_» в нике допустим (iluci____) — оставляем только проверку формата
    if (/^[a-z0-9][a-z0-9_]{2,24}$/.test(slug)) out.push({ name, slug });
  }
  return out;
}

async function probeSet(word) {
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const connected = new Set(sets.map((s) => s.slug || ''));
  for (const { name, slug } of splitCandidates(word)) {
    // набор уже подключён — значит, эмоута в нём просто нет; пробуем
    // следующий разделитель, вдруг граница проходит не здесь
    if (connected.has(slug)) continue;
    const set = await probeStreamerSet(slug);
    // имя сверяем с учётом регистра: подключим набор — эмоут должен
    // отрендериться ровно тем словом, которое пришло в сообщении
    const em = set && set.emotes[name];
    if (em) {
      return {
        found: true,
        name,
        slug: set.slug || slug,
        setName: set.name,
        count: Object.keys(set.emotes).length,
        url: em.u,
      };
    }
  }
  return { found: false };
}

// --- свои эмоуты ---
// Постфикс своего эмоута — id этого эмоута на 7TV. Из id адрес картинки
// собирается однозначно, поэтому чужое расширение рисует kek_01H4… без
// каких-либо запросов к нам и без общего сервера. У картинки не с 7TV id
// взять неоткуда: такой эмоут работает только у того, кто его добавил.
const EMOTE_API = 'https://7tv.io/v3/emotes/';

// У самого эмоута zero-width — это флаг 256, а у эмоута внутри набора тот же
// смысл несёт флаг 1 (см. emoteMapFromSet): это разные наборы флагов.
const ZERO_WIDTH = 256;

const emoteInfo = new Map(); // id -> Promise<{name, z}>

function fetchEmoteInfo(id) {
  if (!emoteInfo.has(id)) {
    const p = (async () => {
      const resp = await fetch(EMOTE_API + id, { cache: 'no-cache' });
      if (resp.status === 404) throw new Error('Эмоута с таким id на 7TV нет — проверь ссылку');
      if (!resp.ok) throw new Error('7TV API: HTTP ' + resp.status);
      const json = await resp.json();
      return {
        name: json.name || id,
        z: (json.flags || 0) & ZERO_WIDTH ? 1 : 0,
        r: ratioOf(json.host),
      };
    })();
    emoteInfo.set(id, p);
    p.catch(() => emoteInfo.delete(id)); // не запоминаем неудачу навсегда
  }
  return emoteInfo.get(id);
}

async function addCustom(input, wanted) {
  const raw = String(input || '').trim();
  const m = ULID_RE.exec(raw);
  let name = String(wanted || '').trim();
  let em;
  if (m) {
    const id = m[0].toUpperCase();
    const info = await fetchEmoteInfo(id);
    em = { u: `https://cdn.7tv.app/emote/${id}/2x.webp`, z: info.z, r: info.r, id };
    if (!name) name = info.name;
  } else {
    if (!/^https?:\/\//i.test(raw)) {
      throw new Error('Нужна ссылка на эмоут 7TV или прямая ссылка на картинку');
    }
    if (!name) throw new Error('Придумай имя — по нему эмоут вставляется в сообщение');
    em = { u: raw, z: 0 };
  }
  if (/\s/.test(name)) throw new Error('Имя — одно слово без пробелов');

  const { customEmotes } = await chrome.storage.sync.get({ customEmotes: {} });
  // Занятое имя не перетираем: у обоих эмоутов остаётся своё полное имя
  // с id, а голое достаётся тому, кто добавлен первым.
  if (customEmotes[name]) {
    const cur = customEmotes[name];
    const same = (typeof cur === 'string' ? cur : cur.u) === em.u;
    if (!same) {
      let i = 2;
      while (customEmotes[name + i]) i++;
      name += i;
    }
  }
  customEmotes[name] = em;
  await chrome.storage.sync.set({ customEmotes });
  return { name, id: em.id || '', full: em.id ? `${name}_${em.id}` : name };
}

// Картинки эмоутов держим в Cache API, а не только в памяти воркера:
// MV3 усыпляет воркер через полминуты простоя вместе со всем, что он
// накопил, и без этого каждая перезагрузка страницы качала эмоуты заново.
// Инвалидация не нужна: id эмоута в 7TV неизменен, меняется картинка —
// меняется и URL.
const IMG_CACHE = 'vk7tv-images';

async function fetchAsDataUrl(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  // кладём промис, а не результат: две картинки подряд не пойдут в сеть дважды
  const p = (async () => {
    const cache = await caches.open(IMG_CACHE);
    // В кэше лежит уже готовый data:-URL, а не байты картинки. Так после
    // засыпания воркера остаётся только прочитать строку: перекодировать
    // сотню эмоутов в base64 на каждую перезагрузку страницы — заметно.
    const hit = await cache.match(url);
    if (hit) return hit.text();

    const net = await fetch(url);
    if (!net.ok) throw new Error('HTTP ' + net.status);
    const mime = net.headers.get('content-type') || 'image/webp';
    const bytes = new Uint8Array(await net.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const dataUrl = `data:${mime};base64,${btoa(bin)}`;
    await cache.put(url, new Response(dataUrl, { headers: { 'content-type': 'text/plain' } }));
    return dataUrl;
  })();
  imgCache.set(url, p);
  p.catch(() => imgCache.delete(url)); // не запоминаем неудачу навсегда
  return p;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => p.then(sendResponse).catch((e) => sendResponse({ error: humanError(e) }));
  if (msg.type === 'add-set') {
    reply(addSet(msg.input));
    return true;
  }
  if (msg.type === 'remove-set') {
    reply(removeSet(msg.id).then(() => ({ ok: true })));
    return true;
  }
  if (msg.type === 'refresh-sets') {
    reply(refreshAll(!!msg.force));
    return true;
  }
  if (msg.type === 'probe-set') {
    reply(probeSet(msg.word));
    return true;
  }
  if (msg.type === 'add-custom') {
    reply(addCustom(msg.input, msg.name));
    return true;
  }
  // чужой эмоут по id: в слове флага zero-width нет, спрашиваем 7TV
  if (msg.type === 'emote-info') {
    reply(fetchEmoteInfo(msg.id));
    return true;
  }
  if (msg.type === 'fetch-emote') {
    reply(fetchAsDataUrl(msg.url).then((dataUrl) => ({ dataUrl })));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  refreshAll().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  refreshAll().catch(() => {});
});
