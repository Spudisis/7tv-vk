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

// Принимает ссылку вида https://7tv.app/emote-sets/<id> или голый ID
async function addSet(input) {
  const m = String(input).match(ULID_RE);
  if (!m) throw new Error('Не нашёл ID набора в ссылке. Скопируй ссылку на набор со страницы 7tv.app.');
  const set = await fetchSet(m[0].toUpperCase());
  const { sets } = await chrome.storage.sync.get({ sets: [] });
  const { setEmotes } = await chrome.storage.local.get({ setEmotes: {} });
  setEmotes[set.id] = set.emotes;
  const meta = { id: set.id, name: set.name, count: Object.keys(set.emotes).length };
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
  refreshAll().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  refreshAll().catch(() => {});
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refresh-sets') refreshAll().catch(() => {});
});
