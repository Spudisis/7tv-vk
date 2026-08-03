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
      for (const [n, u] of Object.entries(g)) emoteMap.set(n, u);
    }
    for (const s of sync.sets) {
      const m = local.setEmotes[s.id];
      if (m) for (const [n, u] of Object.entries(m)) emoteMap.set(n, u);
    }
    for (const [n, u] of Object.entries(sync.customEmotes)) emoteMap.set(n, u);

    testRegex = emoteMap.size
      ? new RegExp([...emoteMap.keys()].map(escapeRegex).join('|'))
      : null;

    // общее состояние для autocomplete.js (один isolated world)
    window.__vk7tv = { emoteMap, enabled };
  }

  function makeEmote(name, url) {
    const img = document.createElement('img');
    img.className = EMOTE_CLASS;
    img.alt = name;
    img.title = name;
    img.draggable = false;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      if (img.dataset.vk7tvFallback) {
        // и data:-URL не загрузился — возвращаем текст, чтобы не терять сообщение
        img.replaceWith(document.createTextNode(name));
        return;
      }
      img.dataset.vk7tvFallback = '1';
      chrome.runtime.sendMessage({ type: 'fetch-emote', url }, (resp) => {
        if (resp && resp.dataUrl) img.src = resp.dataUrl;
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
    // не трогаем поле ввода и служебные теги
    if (parent.isContentEditable) return;
    if (parent.closest('script,style,textarea,input,title')) return;

    // эмоут — это отдельное «слово», разделённое пробелами (как в 7TV)
    const parts = text.split(/(\s+)/);
    let changed = false;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      const url = emoteMap.get(part);
      if (url) {
        frag.appendChild(makeEmote(part, url));
        changed = true;
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    }
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
