// VK7TV — фоновый воркер.
// Две задачи:
//  1) тянуть наборы эмоутов из открытого API 7TV и кэшировать их в storage;
//  2) скачивать картинки, которые страница не смогла загрузить сама
//     (если CSP ВК зарежет сторонний CDN), и отдавать их как data:-URL.

const SET_API = 'https://7tv.io/v3/emote-sets/';
// ID наборов 7TV — это ULID: 26 символов Crockford base32
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/i;

const imgCache = new Map();

function emoteMapFromSet(setJson) {
  const map = {};
  for (const e of setJson.emotes || []) {
    if (e && e.name && e.id) {
      map[e.name] = `https://cdn.7tv.app/emote/${e.id}/2x.webp`;
    }
  }
  return map;
}

async function fetchSet(idOrGlobal) {
  const resp = await fetch(SET_API + idOrGlobal, { cache: 'no-cache' });
  if (!resp.ok) throw new Error('7TV API: HTTP ' + resp.status);
  const json = await resp.json();
  return { id: json.id, name: json.name || idOrGlobal, emotes: emoteMapFromSet(json) };
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
  if (es.emotes && es.emotes.length) {
    return { id: es.id, name: es.name || login, emotes: emoteMapFromSet(es) };
  }
  return fetchSet(es.id);
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
  return fetchSet(conn.emote_set_id);
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
  const meta = { id: set.id, name: set.name, count: Object.keys(set.emotes).length };
  await chrome.storage.local.set({ setEmotes });
  await chrome.storage.sync.set({ sets: sets.filter((s) => s.id !== set.id).concat(meta) });
  return meta;
}

// Набор, который подключается сам при первой установке.
// Одноразово (флаг seeded): если пользователь удалит его из списка,
// заново не добавится.
const DEFAULT_STREAMER = 'bratishkinoff';

async function seedDefaultSet() {
  const { seeded } = await chrome.storage.sync.get({ seeded: false });
  if (seeded) return;
  try {
    await storeSet(await fetchStreamerSet(DEFAULT_STREAMER));
    await chrome.storage.sync.set({ seeded: true });
  } catch (e) {
    // не было сети — попробуем при следующем запуске браузера
  }
}

async function removeSet(id) {
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const { setEmotes } = await chrome.storage.local.get({ setEmotes: {} });
  delete setEmotes[id];
  await chrome.storage.local.set({ setEmotes });
  await chrome.storage.sync.set({ sets: sets.filter((s) => s.id !== id) });
}

async function refreshAll() {
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const { setEmotes: oldCache } = await chrome.storage.local.get({ setEmotes: {} });
  const setEmotes = {};
  const nextSets = [];
  for (const s of sets) {
    try {
      const set = await fetchSet(s.id);
      setEmotes[set.id] = set.emotes;
      nextSets.push({ id: set.id, name: set.name, count: Object.keys(set.emotes).length });
    } catch (e) {
      // API недоступен — оставляем прошлый кэш этого набора
      if (oldCache[s.id]) setEmotes[s.id] = oldCache[s.id];
      nextSets.push(s);
    }
  }
  const localPatch = { setEmotes };
  try {
    const g = await fetchSet('global');
    if (Object.keys(g.emotes).length) localPatch.globalEmotes = g.emotes;
  } catch (e) {
    // глобальный набор есть в default-emotes.js, без обновления не страшно
  }
  await chrome.storage.local.set(localPatch);
  await chrome.storage.sync.set({ sets: nextSets });
  return { sets: nextSets.length };
}

async function fetchAsDataUrl(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const mime = resp.headers.get('content-type') || 'image/webp';
  const bytes = new Uint8Array(await resp.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const dataUrl = `data:${mime};base64,${btoa(bin)}`;
  imgCache.set(url, dataUrl);
  return dataUrl;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => p.then(sendResponse).catch((e) => sendResponse({ error: String(e.message || e) }));
  if (msg.type === 'add-set') {
    reply(addSet(msg.input));
    return true;
  }
  if (msg.type === 'remove-set') {
    reply(removeSet(msg.id).then(() => ({ ok: true })));
    return true;
  }
  if (msg.type === 'refresh-sets') {
    reply(refreshAll());
    return true;
  }
  if (msg.type === 'fetch-emote') {
    reply(fetchAsDataUrl(msg.url).then((dataUrl) => ({ dataUrl })));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh-sets', { periodInMinutes: 30 });
  seedDefaultSet().then(() => refreshAll().catch(() => {}));
});

chrome.runtime.onStartup.addListener(() => {
  seedDefaultSet().then(() => refreshAll().catch(() => {}));
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refresh-sets') refreshAll().catch(() => {});
});
