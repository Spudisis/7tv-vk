// VK7TV — документы текущего аккаунта VK для пикера.
//
// Список берётся из docs.get с той же сессией, которой пользуется открытая
// страница ВК. Токен читается из Local Storage только на время запроса и
// никуда не сохраняется. Здесь же лежит клиент моста в MAIN world: сам
// доступ к редактору ВК и добавление документа в черновик — в
// vk-docs-page.js.

(() => {
  if (window.VK7TV_DOCS) return;

  const AUTH_KEY = '6287487:web_token:login:auth';
  const API_URL = 'https://web.api.vk.ru/method/docs.get?v=5.289&client_id=6287487';
  const PAGE = 50;
  const REQUEST_TIMEOUT = 20000; // один запрос; пагинация идёт страницами
  const RETRY_DELAY = 600; // пауза перед единственным повтором сетевой ошибки
  const MAX_PAGES = 200; // 10 000 документов за один проход, защита от цикла

  const AUTH_TEXT =
    'Не удалось получить авторизацию VK. Открой VK под своим аккаунтом и повтори загрузку.';
  const NETWORK_TEXT = 'Не удалось загрузить файлы';
  const REPEAT_TEXT = 'VK повторил страницу документов — список загружен не полностью';

  const listeners = new Set();

  let items = []; // только GIF и WEBP, порядок ответа VK
  let byKey = new Map(); // owner_id:id -> документ
  let rawSeen = new Set(); // owner_id:id всех уже полученных документов
  let offset = 0; // смещение по исходной выдаче, не по числу подходящих файлов
  let total = 0; // response.total_count, справочно
  let loaded = false; // достоверно дошли до конца библиотеки
  let status = 'idle';
  let loading = false;
  let accountEpoch = 0;
  let error = null; // { kind, message, retryable }
  let auth = { status: 'unknown', token: '', userId: 0, expires: 0 };
  let generation = 0;
  let inFlight = null;
  let inFlightGen = 0;
  let wantAll = false;
  let cancelAll = false;
  let paused = false;
  let query = '';
  let replaceOnNextPage = false;
  let refreshing = false;
  const aborts = new Set();
  let abortEpoch = 0;

  let bridgeSeq = 0;
  const bridgePending = new Map();

  // --- авторизация ---

  function positive(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  function readAuth() {
    let raw;
    try {
      raw = localStorage.getItem(AUTH_KEY);
    } catch (e) {
      return { ok: false, reason: 'storage' };
    }
    if (!raw) return { ok: false, reason: 'missing' };

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: 'bad-json' };
    }

    const token = data && typeof data.access_token === 'string' ? data.access_token.trim() : '';
    if (!token) return { ok: false, reason: 'no-token' };

    const expires = Number(data.expires) || 0;
    // Просроченную запись веб-клиент заменит сам; пока он этого не сделал,
    // запрос заведомо отклонят.
    if (expires && expires * 1000 <= Date.now() + 30000) {
      return { ok: false, reason: 'expired' };
    }

    const userId =
      positive(data.user_id) || positive(data.user?.id) || positive(data.uid) || 0;

    return { ok: true, token, userId, expires };
  }

  function authState(read) {
    return {
      status: read.ok ? 'ok' : read.reason === 'expired' ? 'expired' : 'missing',
      token: read.ok ? read.token : '',
      userId: read.ok ? read.userId : 0,
      expires: read.ok ? read.expires : 0,
    };
  }

  function clearSession() {
    generation++;
    accountEpoch++;
    abortCurrent();
    items = [];
    byKey = new Map();
    rawSeen = new Set();
    offset = 0;
    total = 0;
    loaded = false;
    loading = false;
    error = null;
    status = 'idle';
    wantAll = false;
    replaceOnNextPage = false;
    refreshing = false;
    inFlight = null;
    inFlightGen = 0;
  }

  // Смена пользователя не должна смешивать старую и новую библиотеку.
  function resetForAccount() {
    clearSession();
    status = 'idle';
  }

  function checkAuth() {
    const read = readAuth();
    if (!read.ok) {
      const had = auth.status === 'ok' || items.length > 0 || loaded;
      auth = authState(read);
      if (had || status !== 'unauthorized') {
        clearSession();
        auth = authState(read);
        status = 'unauthorized';
        error = { kind: 'auth', message: AUTH_TEXT, retryable: false };
        notify();
      }
      return false;
    }

    if (auth.status !== 'ok') {
      auth = authState(read);
      if (status === 'unauthorized') {
        status = 'idle';
        error = null;
      }
      notify();
      return true;
    }

    if (auth.token !== read.token) {
      const sameUser =
        auth.userId && read.userId && auth.userId === read.userId;
      if (!sameUser) {
        // Если хотя бы у одной записи нет user_id, принадлежность нового
        // токена подтвердить нельзя — начинаем сессию заново.
        resetForAccount();
      }
      auth = authState(read);
      notify();
      return true;
    }

    if (!auth.userId && read.userId) auth.userId = read.userId;
    if (read.expires) auth.expires = read.expires;
    return true;
  }

  function startAuthWatch() {
    try {
      window.addEventListener('storage', (e) => {
        if (e.key === AUTH_KEY || e.key === null) checkAuth();
      });
      window.addEventListener('focus', () => checkAuth());
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkAuth();
      });
    } catch (e) {
      // В изолированном мире контент-скрипта события доступны; сбой здесь
      // не должен мешать остальному пикеру.
    }
  }

  // --- сеть ---

  function apiError(kind, message, retryable) {
    const err = new Error(message || kind);
    err.kind = kind;
    err.retryable = !!retryable;
    return err;
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function docKey(raw) {
    const owner = Number(raw && raw.owner_id);
    const id = Number(raw && raw.id);
    if (!Number.isSafeInteger(owner) || !Number.isSafeInteger(id) || id <= 0) return '';
    return `${owner}:${id}`;
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = new URL(value, location.href);
      return u.protocol === 'https:' ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  function pickPreview(preview) {
    const sizes = preview && preview.photo && preview.photo.sizes;
    if (!Array.isArray(sizes)) return { sizes: [], image: null };

    const typeOk = new Set(['s', 'm', 'x', 'o', 'p', 'q', 'r', 'y', 'z', 'w']);
    const out = [];
    for (const s of sizes) {
      if (!s || typeof s !== 'object') continue;
      const url = safeUrl(s.src || s.url);
      const width = positive(s.width);
      const height = positive(s.height);
      if (!url || !width || !height) continue;
      out.push({
        type: typeof s.type === 'string' && typeOk.has(s.type) ? s.type : '',
        url,
        width,
        height,
      });
    }
    if (!out.length) return { sizes: [], image: null };

    // Сетка рисует 32px, при плотном экране нужен примерно 64px. Берём
    // самый маленький вариант не меньше этого, иначе — самый крупный.
    const big = out.filter((s) => s.width >= 64 && s.height >= 64);
    const pool = big.length ? big : out;
    let best = pool[0];
    for (const s of pool) {
      if (s.width * s.height < best.width * best.height) best = s;
    }
    return { sizes: out, image: best };
  }

  function pickVideo(preview) {
    const v = preview && preview.video;
    if (!v || typeof v !== 'object') return null;
    const url = safeUrl(v.src || v.url || v.file);
    if (!url) return null;
    return {
      url,
      width: positive(v.width) || 0,
      height: positive(v.height) || 0,
      size: positive(v.file_size) || positive(v.size) || 0,
    };
  }

  const DOC_TYPES = new Set([
    'gif',
    'image',
    'spreadsheet',
    'text',
    'archive',
    'audio',
    'video',
    'ebook',
    'default',
  ]);

  function docType(ext, type) {
    if (ext === 'gif') return 'gif';
    if (ext === 'webp') return 'image';
    switch (Number(type)) {
      case 1:
        return 'text';
      case 2:
        return 'archive';
      case 3:
        return 'gif';
      case 4:
        return 'image';
      case 5:
        return 'audio';
      case 6:
        return 'video';
      case 7:
        return 'ebook';
      default:
        return 'default';
    }
  }

  function normalizeDoc(raw) {
    const key = docKey(raw);
    if (!key) return null;

    const ext = typeof raw.ext === 'string' ? raw.ext.toLowerCase() : '';
    if (ext !== 'gif' && ext !== 'webp') return null;

    const title = typeof raw.title === 'string' && raw.title ? raw.title : ext.toUpperCase();
    const url = safeUrl(raw.url);
    const preview = pickPreview(raw.preview);
    const video = ext === 'gif' ? pickVideo(raw.preview) : null;
    const type = docType(ext, raw.type);

    return {
      key,
      ownerId: Number(raw.owner_id),
      id: Number(raw.id),
      title,
      ext,
      type: DOC_TYPES.has(type) ? type : 'default',
      size: positive(raw.size) || 0,
      date: positive(raw.date) || 0,
      url,
      accessKey: typeof raw.access_key === 'string' ? raw.access_key : '',
      preview: preview.image,
      previewSizes: preview.sizes,
      video,
      ratio:
        preview.image && preview.image.height
          ? preview.image.width / preview.image.height
          : 1,
    };
  }

  async function requestOnce(token, at) {
    const ctrl = new AbortController();
    aborts.add(ctrl);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, REQUEST_TIMEOUT);

    const body = new URLSearchParams({
      count: String(PAGE),
      offset: String(at),
      access_token: token,
    }).toString();

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        if (timedOut) throw apiError('timeout', 'timeout', true);
        throw e;
      }
      throw apiError('network', 'network', true);
    } finally {
      clearTimeout(timer);
      aborts.delete(ctrl);
    }

    if (res.status >= 500) throw apiError('server', 'server', true);

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw apiError('response', 'response', false);
    }

    if (data && data.error) {
      const code = Number(data.error.error_code) || 0;
      if (code === 5 || code === 4 || code === 1) {
        throw apiError('auth', 'auth', false);
      }
      if (code === 14) throw apiError('captcha', 'captcha', false);
      throw apiError('api', 'api', false);
    }

    if (!res.ok) throw apiError('response', 'response', false);
    if (!data || !data.response || !Array.isArray(data.response.items)) {
      throw apiError('response', 'response', false);
    }
    return data.response;
  }

  async function requestPage(token, at) {
    const epoch = abortEpoch;
    try {
      return await requestOnce(token, at);
    } catch (e) {
      if (!e || !e.retryable || e.name === 'AbortError') throw e;
      await delay(RETRY_DELAY);
      if (epoch !== abortEpoch) {
        throw new DOMException('aborted', 'AbortError');
      }
      return requestOnce(token, at);
    }
  }

  function abortCurrent() {
    abortEpoch++;
    for (const ctrl of aborts) {
      try {
        ctrl.abort();
      } catch (e) {
        // уже завершён
      }
    }
    aborts.clear();
  }

  // --- загрузка ---

  function partialStatus() {
    return loaded ? (items.length ? 'ready' : 'empty') : items.length ? 'partial' : 'error';
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn(getState());
      } catch (e) {
        // один подписчик не должен ломать загрузку документов
      }
    }
  }

  function setError(e, search) {
    if (!e || e.kind === 'auth') {
      error = { kind: 'auth', message: AUTH_TEXT, retryable: false, search: !!search };
      return;
    }
    if (e.kind === 'repeat') {
      error = { kind: 'repeat', message: REPEAT_TEXT, retryable: false, search: !!search };
      return;
    }
    if (e.kind === 'captcha') {
      error = {
        kind: 'captcha',
        message: 'VK просит подтвердить действие. Заверши проверку в VK и повтори.',
        retryable: false,
        search: !!search,
      };
      return;
    }
    if (e.kind === 'api') {
      error = { kind: 'api', message: NETWORK_TEXT, retryable: true, search: !!search };
      return;
    }
    error = { kind: e.kind || 'network', message: NETWORK_TEXT, retryable: true, search: !!search };
  }

  async function runLoop(all) {
    if (!checkAuth()) {
      loading = false;
      return;
    }
    const gen = generation;

    try {
      let pages = 0;
      status = refreshing || !items.length ? 'loading' : 'partial';
      error = null;
      notify();

      for (;;) {
        if (gen !== generation || !auth.token) return;
        if (paused) break;
        if (loaded) break;
        if (pages >= MAX_PAGES) {
          setError(apiError('limit', 'limit', true));
          break;
        }

        let response;
        let usedToken = auth.token;
        try {
          response = await requestPage(auth.token, offset);
        } catch (e) {
          if (gen !== generation) return;
          if (e && e.name === 'AbortError') return;
          if (e && e.kind === 'auth') {
            // Веб-клиент мог успеть обновить токен — читаем запись ещё раз.
            const read = readAuth();
            if (read.ok && read.token && read.token !== usedToken) {
              const sameUser =
                auth.userId && read.userId && auth.userId === read.userId;
              if (!sameUser) resetForAccount();
              auth = authState(read);
              notify();
              continue;
            }
            status = 'unauthorized';
            error = { kind: 'auth', message: AUTH_TEXT, retryable: false };
            break;
          }
          setError(e, !!query);
          break;
        }

        if (gen !== generation) return;

        const pageItems = response.items;
        total = Number(response.total_count) || total;
        const rawCount = pageItems.length;

        let newRaw = 0;
        const matched = [];
        for (const raw of pageItems) {
          const key = docKey(raw);
          if (!key || rawSeen.has(key)) continue;
          rawSeen.add(key);
          newRaw++;
          const doc = normalizeDoc(raw);
          if (doc) matched.push(doc);
        }

        if (replaceOnNextPage) {
          items = [];
          byKey = new Map();
          replaceOnNextPage = false;
        }

        let added = 0;
        for (const doc of matched) {
          if (byKey.has(doc.key)) continue;
          byKey.set(doc.key, doc);
          items.push(doc);
          added++;
        }
        offset += rawCount;
        error = null;

        if (rawCount === 0) {
          loaded = true;
          break;
        }
        if (newRaw === 0) {
          setError(apiError('repeat', 'repeat', false), !!query);
          break;
        }
        if (total > 0 && offset >= total) {
          loaded = true;
          break;
        }

        status = refreshing || !items.length ? 'loading' : 'partial';
        notify();

        const wantsAllNow = all || wantAll;
        if (wantsAllNow && cancelAll) break;
        if (!wantsAllNow && added > 0) break;
        pages++;
      }
    } catch (e) {
      if (gen === generation) setError(e, !!query);
    } finally {
      if (gen === generation) {
        inFlight = null;
        inFlightGen = 0;
        wantAll = false;
        cancelAll = false;
        refreshing = false;
        loading = false;
        if (status !== 'unauthorized') {
          status = paused && !items.length ? 'idle' : partialStatus();
        }
        notify();
      }
    }
  }

  function start(all) {
    if (!checkAuth()) {
      loading = false;
      return Promise.resolve();
    }
    if (loaded && !all) {
      loading = false;
      return Promise.resolve();
    }
    const gen = generation;
    if (inFlight && inFlightGen === gen) {
      if (all) {
        wantAll = true;
        cancelAll = false;
      }
      loading = true;
      return inFlight;
    }
    if (all) {
      wantAll = true;
      cancelAll = false;
    }
    loading = true;
    inFlightGen = gen;
    inFlight = runLoop(all);
    return inFlight;
  }

  function loadMore() {
    if (status === 'unauthorized') {
      if (!checkAuth()) return Promise.resolve();
    }
    if (loaded) return Promise.resolve();
    return start(false);
  }

  function loadAll() {
    if (status === 'unauthorized') {
      if (!checkAuth()) return Promise.resolve();
    }
    return start(true);
  }

  function refresh() {
    if (!checkAuth()) return Promise.resolve();
    generation++;
    abortCurrent();
    offset = 0;
    total = 0;
    rawSeen = new Set();
    loaded = false;
    error = null;
    wantAll = false;
    inFlight = null;
    inFlightGen = 0;
    replaceOnNextPage = true;
    refreshing = true;
    status = 'loading';
    notify();
    return start(false);
  }

  function setQuery(next) {
    const q = String(next == null ? '' : next).trim().toLowerCase();
    if (q === query) return;
    query = q;
    if (q && !loaded && auth.status === 'ok' && !paused) {
      // Поиск идёт по уже полученной коллекции, а недостающие страницы
      // догружаются в том же порядке, без перезапуска пагинации.
      loadAll();
    } else if (q && !loaded && auth.status !== 'ok' && !paused) {
      if (checkAuth()) loadAll();
    } else if (!q) {
      wantAll = false;
      cancelAll = true;
    }
    notify();
  }

  function setPaused(next) {
    const value = !!next;
    if (paused === value) return;
    paused = value;
    if (paused) wantAll = false;
  }

  function filterItems(q) {
    const needle = String(q == null ? '' : q).trim().toLowerCase();
    if (!needle) return items.slice();
    return items.filter((d) => d.title.toLowerCase().includes(needle));
  }

  function getState() {
    const filtered = query ? filterItems(query) : items;
    const partial = !loaded || !!error;
    return {
      status,
      loaded,
      error: error ? { ...error } : null,
      query,
      count: filtered.length,
      totalDocuments: items.length,
      partial,
      search: !!query,
      rawLoaded: offset,
      total,
      paused,
      loading,
      accountEpoch,
      generation,
      auth: { status: auth.status, userId: auth.userId, expires: auth.expires },
    };
  }

  function getItems() {
    return items.slice();
  }

  function getDocument(key) {
    return byKey.get(key) || null;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // --- мост в MAIN world: редактор и черновик ---

  function bridgeCall(type, payload, timeout) {
    const id = `d${++bridgeSeq}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        resolve({ ok: false, reason: 'timeout' });
      }, timeout || 4000);
      bridgePending.set(id, { resolve, timer });
      try {
        window.postMessage(
          { __vk7tvDocsBridge: 1, to: 'page', id, type, payload },
          location.origin
        );
      } catch (e) {
        clearTimeout(timer);
        bridgePending.delete(id);
        resolve({ ok: false, reason: 'post' });
      }
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.origin !== location.origin) return;
    const data = e.data;
    if (!data || data.__vk7tvDocsBridge !== 1 || data.to !== 'extension') return;
    if (typeof data.id !== 'string' || !bridgePending.has(data.id)) return;
    const pending = bridgePending.get(data.id);
    bridgePending.delete(data.id);
    clearTimeout(pending.timer);
    pending.resolve(data.result && typeof data.result === 'object' ? data.result : { ok: false });
  });

  function docForBridge(doc) {
    return {
      key: doc.key,
      ownerId: doc.ownerId,
      id: doc.id,
      accessKey: doc.accessKey,
      title: doc.title,
      ext: doc.ext,
      type: doc.type,
      size: doc.size,
      date: doc.date,
      url: doc.url,
      previewSizes: doc.previewSizes.map((s) => ({
        type: s.type,
        url: s.url,
        width: s.width,
        height: s.height,
      })),
    };
  }

  const composer = {
    getContext() {
      return bridgeCall('get-context', {}, 3000);
    },
    attach(context, doc) {
      if (!context || !context.ok || !doc) {
        return Promise.resolve({ ok: false, reason: 'context' });
      }
      return bridgeCall(
        'attach-doc',
        {
          expectedPeerId: String(context.peerId || ''),
          expectedUserId: Number(context.userId) || 0,
          doc: docForBridge(doc),
        },
        6000
      );
    },
  };

  startAuthWatch();

  window.VK7TV_DOCS = {
    getState,
    getItems,
    filterItems,
    getDocument,
    loadMore,
    loadAll,
    refresh,
    setQuery,
    checkAuth,
    setPaused,
    subscribe,
    composer,
  };
})();
