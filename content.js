// VK7TV — контент-скрипт.
// Ищет в тексте страницы слова-коды эмоутов и заменяет их на <img>.
// Текст сообщения при этом остаётся текстом на сервере ВК — картинку
// видит каждый, у кого стоит расширение с тем же набором эмоутов.

(() => {
  const EMOTE_CLASS = 'vk7tv-emote';

  let enabled = true;
  let emoteMap = new Map(); // имя -> URL картинки
  let testRegex = null; // быстрый префильтр текстовых узлов

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

  async function loadState() {
    const sync = await chrome.storage.sync.get({
      enabled: true,
      useGlobal: true,
      sets: [],
      customEmotes: {},
    });
    const local = await chrome.storage.local.get({ setEmotes: {}, globalEmotes: null });

    enabled = sync.enabled;
    emoteMap = new Map();
    if (sync.useGlobal) {
      const g =
        local.globalEmotes && Object.keys(local.globalEmotes).length
          ? local.globalEmotes
          : DEFAULT_EMOTES;
      for (const [n, v] of Object.entries(g)) emoteMap.set(n, normEmote(v));
    }
    for (const s of sync.sets) {
      const m = local.setEmotes[s.id];
      if (m) for (const [n, v] of Object.entries(m)) emoteMap.set(n, normEmote(v));
    }
    for (const [n, v] of Object.entries(sync.customEmotes)) emoteMap.set(n, normEmote(v));

    testRegex = emoteMap.size
      ? new RegExp([...emoteMap.keys()].map(escapeRegex).join('|'))
      : null;

    // общее состояние для autocomplete.js и picker.js (один isolated world)
    window.__vk7tv = { emoteMap, enabled, resolveEmote };
  }

  function makeEmote(name, url, zeroWidth) {
    const img = document.createElement('img');
    img.className = EMOTE_CLASS + (zeroWidth ? ' vk7tv-zw' : '');
    img.alt = name;
    img.title = name;
    img.draggable = false;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      if (img.dataset.vk7tvFallback) {
        // и blob не загрузился — возвращаем текст, чтобы не терять сообщение
        img.replaceWith(document.createTextNode(name));
        return;
      }
      img.dataset.vk7tvFallback = '1';
      resolveEmote(url).then((u) => {
        if (u) img.src = u;
        else img.replaceWith(document.createTextNode(name));
      });
    });
    img.src = url;
    return img;
  }

  function processTextNode(node) {
    if (!enabled || !testRegex) return;
    const text = node.nodeValue;
    if (!text || !testRegex.test(text)) return;

    const parent = node.parentElement;
    if (!parent) return;
    // не трогаем поле ввода, служебные теги и собственный UI расширения
    if (parent.isContentEditable) return;
    if (parent.closest('script,style,textarea,input,title,.vk7tv-ac,.vk7tv-picker,.vk7tv-widget')) return;

    // эмоут — это отдельное «слово», разделённое пробелами (как в 7TV);
    // zero-width эмоут после обычного накладывается поверх него,
    // пробел между ними при рендере съедается
    const parts = text.split(/(\s+)/);
    let changed = false;
    const frag = document.createDocumentFragment();
    let lastStack = null;
    let pendingWs = '';
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
    if (changed) node.replaceWith(frag);
  }

  function scan(root) {
    if (!enabled || !testRegex) return;
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
    for (const stack of document.querySelectorAll('span.vk7tv-stack')) {
      const names = [...stack.querySelectorAll('img')].map((i) => i.alt);
      stack.replaceWith(document.createTextNode(names.join(' ')));
    }
    for (const img of document.querySelectorAll('img.' + EMOTE_CLASS)) {
      img.replaceWith(document.createTextNode(img.alt));
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        processTextNode(m.target);
      } else {
        for (const n of m.addedNodes) scan(n);
      }
    }
  });

  chrome.storage.onChanged.addListener(() => {
    loadState().then(() => {
      if (!enabled) {
        unrender();
      } else {
        scan(document.body);
      }
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
