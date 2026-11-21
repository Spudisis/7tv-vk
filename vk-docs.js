// VK7TV — документы текущего аккаунта VK для пикера.
//
// Список берётся из docs.get с той же сессией, которой пользуется открытая
// страница ВК. Токен читается из Local Storage только на время запроса и
// никуда не сохраняется. Здесь же лежит клиент моста в MAIN world: сам
// доступ к редактору ВК и добавление документа в черновик — в
// vk-docs-page.js.
//
// Загрузка идёт в личные документы: docs.getUploadServer -> multipart на
// pu.vk.ru -> docs.save. Протокол проверен на живом ВК; для PNG и MP4
// docs.save возвращает response.doc, а не массив. MP4 VK принимает как
// документ (ext mp4, type 6), но оригинал по doc.url отдаётся HTML-страницей,
// поэтому в пикере он показывается заглушкой и остаётся доступным для
// прикрепления к сообщению.

(() => {
  if (window.VK7TV_DOCS) return;

  const AUTH_KEY = '6287487:web_token:login:auth';
  const API_ROOT = 'https://web.api.vk.ru/method/';
  const API_VERSION = '5.289';
  const CLIENT_ID = '6287487';
  const PAGE = 50;
  const REQUEST_TIMEOUT = 20000; // один запрос; пагинация идёт страницами
  const RETRY_DELAY = 600; // пауза перед единственным повтором сетевой ошибки
  const MAX_PAGES = 200; // 10 000 документов за один проход, защита от цикла
  const UPLOAD_IDLE_TIMEOUT = 60000; // нет прогресса передачи — запрос снимаем

  // Форматы, которые VK сохраняет как документ и которые умеет показать
  // пикер. MP4 подтверждён на живом ВК: docs.save возвращает doc с type 6,
  // docs.get отдаёт его в личной библиотеке, штатный dispatch принимает его
  // в черновик. Оригинал по doc.url не воспроизводится напрямую, поэтому
  // карточка MP4 показывает заглушку, а не видео.
  const MP4 = true;
  const FORMATS = ['gif', 'webp', 'png', 'jpg', 'jpeg', 'mp4'];
  const FORMAT_SET = new Set(FORMATS);

  const AUTH_TEXT =
    'Не удалось получить авторизацию VK. Открой VK под своим аккаунтом и повтори загрузку.';
  const NETWORK_TEXT = 'Не удалось загрузить файлы';
  const REPEAT_TEXT = 'VK повторил страницу документов — список загружен не полностью';
  const UPLOAD_NETWORK_TEXT = 'Сеть недоступна или VK не ответил вовремя';

  const UPLOAD_ERRORS = {
    format: 'Формат не поддерживается. Можно загрузить GIF, WebP, PNG, JPG/JPEG и MP4.',
    empty: 'Файл пустой.',
    corrupt: 'Файл повреждён или его содержимое не совпадает с расширением.',
    size: 'Файл слишком большой или достигнут лимит хранилища VK.',
    auth: AUTH_TEXT,
    access: 'Недостаточно прав для загрузки в документы VK.',
    network: UPLOAD_NETWORK_TEXT,
    timeout: UPLOAD_NETWORK_TEXT,
    server: 'VK временно не принял файл. Повтори загрузку.',
    rate: 'VK ограничил частоту загрузок. Подожди и повтори.',
    captcha: 'VK просит подтвердить действие. Заверши проверку в VK и повтори.',
    api: 'VK отклонил запрос. Повтори загрузку.',
    response: 'VK вернул некорректный ответ. Повтори загрузку.',
    file: 'Не удалось получить файл для загрузки.',
    unconfirmed: 'Не удалось подтвердить сохранение.',
  };

  const listeners = new Set();

  let items = []; // объединение локальных загрузок и серверной выдачи
  let serverItems = []; // только страницы docs.get
  let localUploads = new Map(); // подтверждённые загрузки: owner_id:id -> документ
  let byKey = new Map(); // owner_id:id -> документ
  let rawSeen = new Set(); // owner_id:id всех уже полученных документов
  let offset = 0; // смещение по исходной выдаче, не по числу подходящих файлов
  let total = 0; // response.total_count, справочно
  let loaded = false; // достоверно дошли до конца библиотеки
  let status = 'idle';
  let loading = false;
  let accountEpoch = 0;
  let uploadEpoch = 0;
  let libraryVersion = 0;
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
  let paginationStale = false;
  let refreshing = false;
  const aborts = new Set();
  let abortEpoch = 0;

  let uploads = new Map();
  let uploadSeq = 0;
  let uploadActive = null;
  let uploadAuthHold = false;
  let beforeUnloadBound = false;

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
    serverItems = [];
    localUploads = new Map();
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
    paginationStale = false;
    refreshing = false;
    inFlight = null;
    inFlightGen = 0;
    rebuildLibrary();
  }

  // Смена пользователя не должна смешивать старую и новую библиотеку.
  function resetForAccount() {
    clearSession();
    uploadEpoch++;
    clearUploads();
    status = 'idle';
  }

  // Задания хранят userId на момент постановки. Если новый токен нельзя
  // уверенно отнести к тому же пользователю, очередь сбрасывается: смешать
  // документы двух аккаунтов хуже, чем потерять незавершённую загрузку.
  function uploadsBelongTo(userId) {
    if (!uploads.size) return true;
    for (const job of uploads.values()) {
      if (!job.userId || !userId || job.userId !== userId) return false;
    }
    return true;
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
      if (!uploadsBelongTo(read.userId)) {
        resetForAccount();
      }
      auth = authState(read);
      if (status === 'unauthorized') {
        status = 'idle';
        error = null;
      }
      notify();
      resumeAuthUploads();
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
      resumeAuthUploads();
      return true;
    }

    if (!auth.userId && read.userId) auth.userId = read.userId;
    if (read.expires) auth.expires = read.expires;
    if (uploadAuthHold) resumeAuthUploads();
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

  function safeUploadUrl(value) {
    const url = safeUrl(value);
    if (!url) return '';
    try {
      const u = new URL(url);
      // VK отдаёт загрузку только на pu.vk.ru (на других доменах — pu.vk.com
      // или pu.vk.me). Любой другой адрес не принимаем: файл туда уходить
      // не должен.
      if (
        u.hostname !== 'pu.vk.ru' &&
        u.hostname !== 'pu.vk.com' &&
        u.hostname !== 'pu.vk.me'
      ) {
        return '';
      }
      if (u.username || u.password) return '';
      if (u.port && u.port !== '443') return '';
      return u.href;
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
    if (ext === 'webp' || ext === 'png' || ext === 'jpg' || ext === 'jpeg') return 'image';
    if (ext === 'mp4') return 'video';
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
    if (!FORMAT_SET.has(ext)) return null;

    const title = typeof raw.title === 'string' && raw.title ? raw.title : ext.toUpperCase();
    const url = safeUrl(raw.url);
    const preview = pickPreview(raw.preview);
    // У GIF видео-превью — это анимированный вариант. У MP4 preview.video
    // обычно отсутствует, а doc.url не является потоком; если превью всё же
    // пришло, оно пригодится для карточки.
    const video = ext === 'gif' || ext === 'mp4' ? pickVideo(raw.preview) : null;
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
          : video && video.height
            ? video.width / video.height
            : 1,
    };
  }

  function classifyVkError(vkError) {
    const code = Number(vkError && vkError.error_code) || 0;
    if (code === 5 || code === 4 || code === 1) return apiError('auth', 'auth', false);
    if (code === 14) return apiError('captcha', 'captcha', false);
    if (code === 15) return apiError('access', 'access', false);
    if (code === 6 || code === 9) return apiError('rate', 'rate', true);
    if (code === 10) return apiError('server', 'server', true);
    return apiError('api', 'api', false);
  }

  function apiBody(token, params) {
    const body = new URLSearchParams({
      v: API_VERSION,
      client_id: CLIENT_ID,
      access_token: token,
    });
    for (const [key, value] of Object.entries(params || {})) {
      if (value == null) continue;
      body.set(key, String(value));
    }
    return body.toString();
  }

  const API_METHODS = new Set(['docs.get', 'docs.getUploadServer', 'docs.save']);

  async function apiRequest(method, params, token, opts) {
    if (!API_METHODS.has(method)) throw apiError('api', 'api', false);
    const options = opts || {};
    const ctrl = new AbortController();
    if (options.register) options.register(ctrl);
    else aborts.add(ctrl);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, options.timeout || REQUEST_TIMEOUT);

    let res;
    try {
      res = await fetch(API_ROOT + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: apiBody(token, params),
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
      if (options.unregister) options.unregister(ctrl);
      else aborts.delete(ctrl);
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }

    if (res.status === 413) throw apiError('size', 'size', false);
    if (res.status === 429) throw apiError('rate', 'rate', true);
    if (res.status === 401) throw apiError('auth', 'auth', false);
    if (res.status === 403) throw apiError('access', 'access', false);
    if (data && data.error) throw classifyVkError(data.error);
    if (res.status >= 500) throw apiError('server', 'server', true);
    if (!res.ok) throw apiError('response', 'response', false);
    if (!data || !data.response) throw apiError('response', 'response', false);
    return data.response;
  }

  async function requestOnce(token, at) {
    const response = await apiRequest(
      'docs.get',
      { count: PAGE, offset: at },
      token,
      { timeout: REQUEST_TIMEOUT }
    );
    if (!response || !Array.isArray(response.items)) {
      throw apiError('response', 'response', false);
    }
    return response;
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

  // --- библиотека: серверные страницы и локальные загрузки ---

  // Локальные загрузки стоят первыми и не зависят от смещения серверной
  // выдачи: после docs.save новый документ сразу видим, а серверная
  // пагинация перезапускается со следующего чтения.
  function rebuildLibrary() {
    const merged = [];
    const seen = new Set();
    for (const doc of localUploads.values()) {
      if (!doc || seen.has(doc.key)) continue;
      seen.add(doc.key);
      merged.push(doc);
    }
    for (const doc of serverItems) {
      if (!doc || seen.has(doc.key)) continue;
      seen.add(doc.key);
      merged.push(doc);
    }
    items = merged;
    byKey = new Map(merged.map((doc) => [doc.key, doc]));
    libraryVersion++;
  }

  function resetPagination() {
    offset = 0;
    total = 0;
    rawSeen = new Set();
    loaded = false;
    replaceOnNextPage = true;
    paginationStale = false;
  }

  // Если чтение уже в пути, смещение не трогаем на середине: следующий
  // проход начнёт с нуля. Иначе ответ старой страницы сдвинул бы offset
  // и часть библиотеки осталась бы не прочитанной.
  function markPaginationStale() {
    if (inFlight && inFlightGen === generation) {
      paginationStale = true;
      return;
    }
    resetPagination();
  }

  function addLocalDocument(doc) {
    if (!doc || !doc.key) return;
    localUploads.set(doc.key, doc);
    rebuildLibrary();
    markPaginationStale();
    // Раньше список мог быть пустым или полным; после вставки он заведомо
    // неполный, пока серверная выдача не перечитана.
    if (status === 'idle' || status === 'empty' || status === 'ready') {
      status = 'partial';
    }
    notify();
  }

  // --- загрузка библиотеки ---

  function partialStatus() {
    return loaded ? (items.length ? 'ready' : 'empty') : items.length ? 'partial' : 'error';
  }

  function notify() {
    // Один снимок на всех подписчиков: при прогрессе загрузки их два, и
    // повторная фильтрация тысяч документов на каждый процент не нужна.
    const state = getState();
    for (const fn of listeners) {
      try {
        fn(state);
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
      inFlight = null;
      inFlightGen = 0;
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

        if (paginationStale) {
          resetPagination();
          status = refreshing || !items.length ? 'loading' : 'partial';
          notify();
        }

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
          serverItems = [];
          replaceOnNextPage = false;
          // byKey ещё держит старые серверные документы; без пересборки
          // первая страница обновления выглядела бы как дубли и не попала
          // в список.
          rebuildLibrary();
        }

        let added = 0;
        for (const doc of matched) {
          if (localUploads.has(doc.key)) {
            // Тот же документ вернулся с сервера: обновляем метаданные, но
            // оставляем его в начале библиотеки.
            localUploads.set(doc.key, doc);
            continue;
          }
          if (byKey.has(doc.key)) continue;
          byKey.set(doc.key, doc);
          serverItems.push(doc);
          added++;
        }
        rebuildLibrary();
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
    paginationStale = false;
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

  // --- очередь загрузки в документы VK ---

  function uploadStageActive(job) {
    return (
      job &&
      (job.stage === 'queued' ||
        job.stage === 'checking' ||
        job.stage === 'server' ||
        job.stage === 'uploading' ||
        job.stage === 'saving')
    );
  }

  function uploadTerminal(job) {
    return job && !uploadStageActive(job);
  }

  function uploadPublic(job) {
    return {
      id: job.id,
      name: job.name,
      size: job.size,
      stage: job.stage,
      loaded: job.loaded,
      total: job.total,
      error: job.error ? { kind: job.error.kind, message: job.error.message } : null,
      canCancel: uploadStageActive(job),
      canRetry: !!job.canRetry,
      canDismiss: uploadTerminal(job),
      docKey: job.docKey || '',
    };
  }

  function uploadsState() {
    return [...uploads.values()].map(uploadPublic);
  }

  function hasPendingUploads() {
    for (const job of uploads.values()) {
      if (uploadStageActive(job)) return true;
    }
    return false;
  }

  function beforeUnloadHandler(e) {
    if (!hasPendingUploads()) return;
    e.preventDefault();
    // Chrome показывает свой диалог только при непустом returnValue.
    e.returnValue = '';
    return '';
  }

  function updateUploadLifecycle() {
    if (!uploads.size) uploadAuthHold = false;
    const busy = hasPendingUploads();
    if (busy && !beforeUnloadBound) {
      beforeUnloadBound = true;
      try {
        window.addEventListener('beforeunload', beforeUnloadHandler);
      } catch (e) {
        beforeUnloadBound = false;
      }
    } else if (!busy && beforeUnloadBound) {
      beforeUnloadBound = false;
      try {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
      } catch (e) {
        // страница уже закрывается
      }
    }
  }

  function releaseJobFile(job) {
    if (!job) return;
    job.file = null;
  }

  function abortJob(job) {
    if (!job) return;
    if (job.xhr) {
      try {
        job.xhr.abort();
      } catch (e) {
        // запрос уже завершён
      }
      job.xhr = null;
    }
    if (job.ctrl) {
      try {
        job.ctrl.abort();
      } catch (e) {
        // запрос уже завершён
      }
      job.ctrl = null;
    }
  }

  function clearUploads() {
    for (const job of uploads.values()) {
      abortJob(job);
      releaseJobFile(job);
    }
    uploads = new Map();
    uploadActive = null;
    uploadAuthHold = false;
    updateUploadLifecycle();
  }

  function owned(job) {
    return !!job && uploads.get(job.id) === job && job.accountEpoch === uploadEpoch;
  }

  // Потеря сессии — не повод выбрасывать задание: файл остаётся в очереди,
  // а этап возобновится после входа тем же пользователем. Чужой аккаунт
  // или очистка очереди делают задание недействительным.
  function requireUploadAuth(job) {
    if (!owned(job) || !uploadStageActive(job)) throw uploadError('canceled');
    if (!checkAuth()) throw uploadError('auth');
    if (!owned(job) || !uploadStageActive(job)) throw uploadError('canceled');
  }

  function uploadError(kind, message) {
    return apiError(kind, message || UPLOAD_ERRORS[kind] || UPLOAD_ERRORS.response, false);
  }

  function jobErrorKind(e) {
    if (!e) return 'response';
    if (e.kind) return e.kind;
    if (e.name === 'AbortError') return 'canceled';
    return 'network';
  }

  function canRetryKind(kind) {
    return (
      kind !== 'format' &&
      kind !== 'empty' &&
      kind !== 'corrupt' &&
      kind !== 'size' &&
      kind !== 'access' &&
      kind !== 'file'
    );
  }

  function setJobError(job, e) {
    const kind = jobErrorKind(e);
    if (kind === 'canceled') return;
    job.stage = 'error';
    job.error = { kind, message: UPLOAD_ERRORS[kind] || UPLOAD_ERRORS.response };
    job.canRetry = canRetryKind(kind);
    job.canDismiss = true;
    job.xhr = null;
    job.ctrl = null;
    if (kind === 'auth') uploadAuthHold = true;
    updateUploadLifecycle();
    notify();
  }

  function finishUnconfirmed(job, message) {
    job.stage = 'unconfirmed';
    job.error = {
      kind: 'unconfirmed',
      message: message || UPLOAD_ERRORS.unconfirmed,
    };
    job.canRetry = true;
    job.canDismiss = true;
    job.xhr = null;
    job.ctrl = null;
    updateUploadLifecycle();
    notify();
  }

  function finishCanceled(job, message) {
    job.stage = 'canceled';
    job.error = message ? { kind: 'canceled', message } : null;
    job.canRetry = false;
    job.canDismiss = true;
    job.xhr = null;
    job.ctrl = null;
    releaseJobFile(job);
    updateUploadLifecycle();
    notify();
  }

  function resumeAuthUploads() {
    if (!uploadAuthHold || !uploads.size) return;
    uploadAuthHold = false;
    let changed = false;
    for (const job of uploads.values()) {
      if (job.stage === 'error' && job.error && job.error.kind === 'auth') {
        job.stage = 'queued';
        job.error = null;
        job.canRetry = false;
        job.canDismiss = false;
        changed = true;
      }
    }
    if (changed) notify();
    setTimeout(pumpUploads, 0);
  }

  async function readSignature(file) {
    const size = Math.min(32, file.size || 0);
    if (!size) return null;
    let buffer;
    try {
      buffer = await file.slice(0, size).arrayBuffer();
    } catch (e) {
      throw uploadError('corrupt');
    }
    return new Uint8Array(buffer);
  }

  function ascii(bytes, start, text) {
    if (!bytes || bytes.length < start + text.length) return false;
    for (let i = 0; i < text.length; i++) {
      if (bytes[start + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  function detectFormat(bytes) {
    if (!bytes) return '';
    if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif';
    if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'jpeg';
    }
    if (ascii(bytes, 4, 'ftyp')) return 'mp4';
    return '';
  }

  function extensionOf(name) {
    const value = String(name || '');
    const dot = value.lastIndexOf('.');
    if (dot <= 0 || dot === value.length - 1) return '';
    return value.slice(dot + 1).toLowerCase();
  }

  function formatMatches(ext, detected) {
    if (ext === 'jpg' || ext === 'jpeg') return detected === 'jpeg';
    return ext === detected;
  }

  async function validateUploadFile(file, name) {
    if (!file || typeof file.size !== 'number') throw uploadError('file');
    if (!file.size) throw uploadError('empty');
    const ext = extensionOf(name || file.name);
    if (!FORMAT_SET.has(ext)) throw uploadError('format');
    if (ext === 'mp4' && !MP4) throw uploadError('format');
    const bytes = await readSignature(file);
    const detected = detectFormat(bytes);
    if (!detected) throw uploadError('corrupt');
    if (ext === 'mp4' && !MP4) throw uploadError('format');
    if (!formatMatches(ext, detected)) throw uploadError('corrupt');
  }

  async function getUploadUrl(job) {
    job.stage = 'server';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = false;
    notify();

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      requireUploadAuth(job);
      try {
        const response = await apiRequest(
          'docs.getUploadServer',
          { group_id: '0' },
          auth.token,
          {
            timeout: REQUEST_TIMEOUT,
            register: (ctrl) => {
              job.ctrl = ctrl;
            },
            unregister: () => {
              job.ctrl = null;
            },
          }
        );
        requireUploadAuth(job);
        const url = safeUploadUrl(response && response.upload_url);
        if (!url) throw uploadError('response');
        return url;
      } catch (e) {
        lastError = e;
        // Повторяем только временный сетевой сбой. Капчу, лимиты частоты
        // и отказ VK автоматически не повторяем.
        const retryable =
          e && (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'server');
        if (!retryable || attempt > 0) break;
        await delay(RETRY_DELAY);
        requireUploadAuth(job);
      }
    }
    throw lastError || uploadError('response');
  }

  function transferUpload(job, uploadUrl) {
    return new Promise((resolve, reject) => {
      if (!owned(job)) {
        reject(uploadError('canceled'));
        return;
      }
      let settled = false;
      let lastProgress = Date.now();
      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        job.xhr = null;
        reject(e);
      };
      const done = (fileId) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        job.xhr = null;
        resolve(fileId);
      };

      const xhr = new XMLHttpRequest();
      job.xhr = xhr;
      job.loaded = 0;
      job.total = job.size;
      notify();

      // Таймаут именно отсутствия прогресса: VK может отдавать ответ долго,
      // но пока байты идут, запрос прерывать нельзя.
      const timer = setInterval(() => {
        if (settled) return;
        if (Date.now() - lastProgress > UPLOAD_IDLE_TIMEOUT) {
          // Сначала фиксируем таймаут: abort() синхронно вызовет onabort,
          // и без этого ошибка выглядела бы как отмена пользователем.
          fail(uploadError('timeout'));
          try {
            xhr.abort();
          } catch (e) {}
        }
      }, 1000);

      const form = new FormData();
      form.append('file', job.file, job.name);

      try {
        xhr.open('POST', uploadUrl, true);
      } catch (e) {
        fail(uploadError('network'));
        return;
      }
      xhr.timeout = 0;
      if (xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (settled) return;
          if (!e) return;
          lastProgress = Date.now();
          job.loaded = Number(e.loaded) || 0;
          if (e.lengthComputable && Number(e.total)) job.total = Number(e.total);
          else if (!job.total) job.total = job.size;
          const now = Date.now();
          if (now - job.lastProgressAt >= 100 || job.loaded >= job.total) {
            job.lastProgressAt = now;
            notify();
          }
        };
      }
      xhr.onload = () => {
        if (job.stage === 'canceled') {
          fail(uploadError('canceled'));
          return;
        }
        if (xhr.status === 413) {
          fail(uploadError('size'));
          return;
        }
        if (xhr.status === 429) {
          fail(uploadError('rate'));
          return;
        }
        if (xhr.status === 401) {
          fail(uploadError('auth'));
          return;
        }
        if (xhr.status === 403) {
          fail(uploadError('access'));
          return;
        }
        if (xhr.status >= 500) {
          fail(uploadError('server'));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(uploadError('response'));
          return;
        }
        let body;
        try {
          body = JSON.parse(xhr.responseText);
        } catch (e) {
          fail(uploadError('response'));
          return;
        }
        if (body && body.error) {
          try {
            fail(classifyVkError(body.error));
          } catch (e) {
            fail(uploadError('response'));
          }
          return;
        }
        const fileId = body && typeof body.file === 'string' ? body.file.trim() : '';
        if (!fileId) {
          fail(uploadError('response'));
          return;
        }
        done(fileId);
      };
      xhr.onerror = () => fail(uploadError('network'));
      xhr.ontimeout = () => fail(uploadError('timeout'));
      xhr.onabort = () => fail(uploadError('canceled'));
      try {
        xhr.send(form);
      } catch (e) {
        fail(uploadError('network'));
      }
    });
  }

  function docFromSave(response) {
    if (!response) return null;
    if (Array.isArray(response)) {
      const first = response[0];
      if (!first) return null;
      if (typeof first.type === 'string' && first.type !== 'doc') return null;
      if (first.type === 'doc' && first.doc) return first.doc;
      if (first.doc) return first.doc;
      // Старая форма docs.save: массив документов без обёртки type/doc.
      if (first.id != null && first.owner_id != null) return first;
      return null;
    }
    if (typeof response.type === 'string' && response.type !== 'doc') return null;
    if (response.type === 'doc' && response.doc) return response.doc;
    if (response.doc) return response.doc;
    if (response.id != null && response.owner_id != null) return response;
    return null;
  }

  async function saveUpload(job) {
    if (!job.fileId) throw uploadError('response');
    requireUploadAuth(job);
    job.stage = 'saving';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = false;
    notify();

    let response;
    try {
      response = await apiRequest(
        'docs.save',
        { file: job.fileId, title: job.name },
        auth.token,
        {
          timeout: REQUEST_TIMEOUT,
          register: (ctrl) => {
            job.ctrl = ctrl;
          },
          unregister: () => {
            job.ctrl = null;
          },
        }
      );
    } catch (e) {
      if (!owned(job)) return;
      if (job.stage === 'canceled') return;
      const kind = jobErrorKind(e);
      // Ответ мог потеряться уже после того, как VK сохранил документ.
      if (kind === 'network' || kind === 'timeout' || kind === 'server') {
        finishUnconfirmed(job, UPLOAD_ERRORS.unconfirmed);
        return;
      }
      throw e;
    }

    if (!owned(job)) return;
    const raw = docFromSave(response);
    const doc = normalizeDoc(raw);
    if (!doc) {
      finishUnconfirmed(
        job,
        'VK сохранил документ, но расширение не смогло подтвердить его параметры.'
      );
      return;
    }
    // Успех уже подтверждён сервером: даже если сессия успела истечь,
    // документ принадлежит аккаунту задания и должен остаться в библиотеке.
    if (!owned(job)) return;

    addLocalDocument(doc);
    job.docKey = doc.key;
    job.stage = 'success';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = true;
    job.fileId = '';
    releaseJobFile(job);
    updateUploadLifecycle();
    notify();
  }

  async function runUpload(job) {
    try {
      requireUploadAuth(job);

      if (job.fileId) {
        // Передача уже завершилась: повтор начинается с docs.save и не
        // отправляет байты второй раз.
        await saveUpload(job);
        return;
      }

      job.stage = 'checking';
      job.error = null;
      job.canRetry = false;
      job.canDismiss = false;
      notify();
      if (!job.file) throw uploadError('file');
      await validateUploadFile(job.file, job.name);
      requireUploadAuth(job);

      const uploadUrl = await getUploadUrl(job);
      requireUploadAuth(job);

      job.stage = 'uploading';
      job.loaded = 0;
      job.total = job.size;
      notify();
      const fileId = await transferUpload(job, uploadUrl);
      if (!owned(job)) return;
      if (job.stage === 'canceled') return;

      job.fileId = fileId;
      job.loaded = job.size;
      job.total = job.size;
      // Байты больше не нужны: при повторе достаточно строки file от VK.
      releaseJobFile(job);
      await saveUpload(job);
    } catch (e) {
      if (!owned(job)) return;
      if (job.stage === 'canceled') return;
      if (jobErrorKind(e) === 'canceled') {
        finishCanceled(job);
        return;
      }
      setJobError(job, e);
    }
  }

  function pumpUploads() {
    if (uploadActive) return;
    if (!uploads.size) {
      updateUploadLifecycle();
      return;
    }
    let next = null;
    for (const job of uploads.values()) {
      if (job.stage === 'queued') {
        next = job;
        break;
      }
    }
    if (!next) {
      updateUploadLifecycle();
      return;
    }
    if (!checkAuth()) {
      uploadAuthHold = true;
      notify();
      return;
    }
    uploadAuthHold = false;
    if (next.accountEpoch !== uploadEpoch || !owned(next)) {
      finishCanceled(next);
      setTimeout(pumpUploads, 0);
      return;
    }
    uploadActive = next;
    runUpload(next)
      .catch(() => {})
      .finally(() => {
        uploadActive = null;
        updateUploadLifecycle();
        notify();
        setTimeout(pumpUploads, 0);
      });
  }

  function enqueueUploads(files) {
    const list = Array.from(files || []);
    if (!list.length) return [];
    checkAuth();
    const epoch = uploadEpoch;
    const userId = auth.userId;
    const seen = new Set();
    const ids = [];
    for (const file of list) {
      if (!file || typeof file.name !== 'string') continue;
      // В одной операции повтор по имени, размеру и времени правки
      // устраняем; между операциями повтор разрешён.
      const signature = `${file.name}\u0000${file.size || 0}\u0000${file.lastModified || 0}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      const id = `u${++uploadSeq}-${Math.random().toString(36).slice(2, 7)}`;
      uploads.set(id, {
        id,
        name: file.name,
        size: Number(file.size) || 0,
        stage: 'queued',
        loaded: 0,
        total: Number(file.size) || 0,
        error: null,
        canRetry: false,
        canDismiss: false,
        docKey: '',
        file,
        fileId: '',
        xhr: null,
        ctrl: null,
        userId,
        accountEpoch: epoch,
        lastProgressAt: 0,
      });
      ids.push(id);
    }
    if (ids.length) {
      updateUploadLifecycle();
      notify();
      pumpUploads();
    }
    return ids;
  }

  // Ошибки выбора файла (каталог, недоступный File) попадают в ту же ленту,
  // чтобы смешанный набор не терял пояснение к отклонённым элементам.
  function enqueueRejected(entries) {
    const list = Array.from(entries || []);
    if (!list.length) return [];
    const ids = [];
    for (const entry of list) {
      if (!entry || !entry.name) continue;
      const id = `u${++uploadSeq}-${Math.random().toString(36).slice(2, 7)}`;
      const kind = entry.kind || 'file';
      uploads.set(id, {
        id,
        name: String(entry.name),
        size: Number(entry.size) || 0,
        stage: 'error',
        loaded: 0,
        total: 0,
        error: {
          kind,
          message: entry.message || UPLOAD_ERRORS[kind] || UPLOAD_ERRORS.file,
        },
        canRetry: false,
        canDismiss: true,
        docKey: '',
        file: null,
        fileId: '',
        xhr: null,
        ctrl: null,
        userId: auth.userId,
        accountEpoch: uploadEpoch,
        lastProgressAt: 0,
      });
      ids.push(id);
    }
    if (ids.length) notify();
    return ids;
  }

  function cancelUpload(id) {
    const job = uploads.get(id);
    if (!job || !uploadStageActive(job)) return false;
    if (job.stage === 'saving') {
      abortJob(job);
      finishCanceled(
        job,
        'Отмена во время сохранения не гарантирует, что документ не появился в VK.'
      );
      return true;
    }
    abortJob(job);
    finishCanceled(job);
    return true;
  }

  function retryUpload(id) {
    const job = uploads.get(id);
    if (!job || !job.canRetry) return false;
    if (job.accountEpoch !== uploadEpoch) return false;
    job.stage = 'queued';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = false;
    // При fileId повтор начнётся сразу с docs.save; старый file для этого
    // уже не нужен и был освобождён после передачи.
    if (!job.fileId) job.loaded = 0;
    updateUploadLifecycle();
    notify();
    pumpUploads();
    return true;
  }

  function dismissUpload(id) {
    const job = uploads.get(id);
    if (!job || !uploadTerminal(job)) return false;
    abortJob(job);
    releaseJobFile(job);
    uploads.delete(id);
    updateUploadLifecycle();
    notify();
    return true;
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
      uploadEpoch,
      generation,
      libraryVersion,
      auth: { status: auth.status, userId: auth.userId, expires: auth.expires },
      uploads: uploadsState(),
      uploadsPaused: uploadAuthHold
        ? { kind: 'auth', message: AUTH_TEXT }
        : null,
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
    enqueueUploads,
    enqueueRejected,
    cancelUpload,
    retryUpload,
    dismissUpload,
    formats: FORMATS.slice(),
    mp4: MP4,
  };
})();
