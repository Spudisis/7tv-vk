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
// прикрепления к сообщению. По выбору пользователя MP4 локально
// преобразуется в GIF тем же путём загрузки, что и анимированный WebP.

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

  const WEBP_PARSER = window.VK7TV_WEBP_PARSE;
  const WEBP_CONVERT = window.VK7TV_WEBP_CONVERT;
  const MP4_PARSER = window.VK7TV_MP4_PARSE;
  const MP4_CONVERT = window.VK7TV_MP4_CONVERT;
  const LIMITS = WEBP_PARSER
    ? WEBP_PARSER.LIMITS
    : {
        sourceBytes: 32 * 1024 * 1024,
        framePixels: 4 * 1000 * 1000,
        frameCount: 1000,
        totalPixels: 100 * 1000 * 1000,
        gifBytes: 50 * 1024 * 1024,
        timeoutMs: 60000,
      };
  const VIDEO_LIMITS = MP4_PARSER
    ? MP4_PARSER.LIMITS
    : {
        sourceBytes: 32 * 1024 * 1024,
        framePixels: 4 * 1000 * 1000,
        gifBytes: 50 * 1024 * 1024,
        timeoutMs: 60000,
        durationMs: 15000,
        fps: 15,
        maxSide: 480,
      };
  const WEBP_HINT =
    'WebP будет преобразован в GIF; цвета и полупрозрачность могут измениться';
  const VIDEO_HINT =
    'MP4 будет преобразован в GIF; без звука, размер и плавность могут измениться';

  // Форматы, которые VK сохраняет как документ и которые умеет показать
  // пикер. MP4 подтверждён на живом ВК: docs.save возвращает doc с type 6,
  // docs.get отдаёт его в личной библиотеке, штатный dispatch принимает его
  // в черновик. Оригинал по doc.url не воспроизводится напрямую, поэтому
  // карточка MP4 показывает заглушку, а не видео.
  const MP4 = true;
  const FORMATS = ['gif', 'webp', 'png', 'jpg', 'jpeg', 'mp4'];
  const FORMAT_SET = new Set(FORMATS);

  const AUTH_TEXT =
    'VK не подтвердил вход расширения. Обнови страницу VK — она обновит вход, — и повтори загрузку.';
  const AUTH_LOCAL_TEXT = {
    missing:
      'Расширение не видит вход VK на этой странице. Обнови страницу VK и повтори загрузку.',
    'bad-json':
      'Запись входа VK повреждена. Обнови страницу VK; если вход не восстановится — войди в VK заново.',
    'no-token':
      'В записи входа VK нет токена. Обнови страницу VK; если вход не восстановится — войди в VK заново.',
    expired:
      'Срок токена VK истёк. Обнови страницу VK — она обновит вход, — и повтори загрузку.',
    storage:
      'Браузер не дал расширению прочитать вход VK. Обнови страницу VK и повтори загрузку.',
  };
  const AUTH_ACCOUNT_TEXT =
    'Аккаунт VK сменился. Загрузка остановлена, чтобы не отправить файл в другой аккаунт.';
  const AUTH_SIGNATURE_TEXT =
    'VK отклонил подпись запроса расширения. Обнови страницу VK и повтори загрузку.';
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
    'convert-unsupported':
      'Этот браузер не поддерживает преобразование анимированного WebP. Загрузите GIF.',
    'convert-limit':
      'Анимированный WebP превышает лимит преобразования (32 МиБ, 4 млн пикселей на кадр, 1000 кадров или 100 млн пикселей суммарно).',
    'convert-gif-size': 'Получившийся GIF больше 50 МиБ.',
    'convert-timeout': 'Преобразование WebP в GIF заняло больше 60 секунд.',
    'convert-worker': 'Не удалось запустить преобразование WebP в GIF.',
    'convert-corrupt':
      'Файл повреждён или его содержимое не совпадает с расширением.',
    'convert-decode': 'Не удалось декодировать анимированный WebP.',
    'convert-duration':
      'Видео длиннее 15 секунд. Обрежьте его заранее или загрузите исходное видео.',
    'convert-no-video':
      'В MP4 нет видеодорожки — браузер не может преобразовать его в GIF. Загрузите исходное видео.',
    'convert-failed': 'Не удалось преобразовать анимированный WebP в GIF.',
  };

  const DELETE_MESSAGES = {
    auth: 'Не удалось подтвердить вход в VK для удаления документа.',
    access: 'Недостаточно прав для удаления этого документа.',
    captcha: 'VK просит подтвердить действие. Заверши проверку в VK.',
    rate: 'VK ограничил частоту удалений. Подожди и повтори.',
    server: 'VK временно не принял удаление. Повтори позже.',
    api: 'VK отклонил удаление документа.',
    network: 'Не удалось подтвердить удаление',
    timeout: 'Не удалось подтвердить удаление',
    response: 'Не удалось подтвердить удаление',
    aborted: 'Не удалось подтвердить удаление',
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
  let auth = {
    status: 'unknown',
    token: '',
    userId: 0,
    expires: 0,
    reason: '',
    source: 'none',
  };
  const AUTH_RETRIES = 4; // сразу, затем через 5, 10 и 15 секунд
  const AUTH_RETRY_DELAY = 5000;
  let expiredRecoveryToken = '';
  let expiredRecoveryPending = null;
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

  // Подтверждённые удаления текущего аккаунта. Карточка не должна
  // возвращаться ни поздней страницей, ни старым ответом обновления.
  let deletedKeys = new Set();
  let deletedKeyCycles = new Map();
  let readCycle = 0;
  // key -> { key, status, message, errorKind, doc, accountEpoch, userId,
  //          ctrl, checking, startedAt }
  let deletions = new Map();

  let uploads = new Map();
  let uploadSeq = 0;
  let uploadActive = null;
  let uploadAuthHold = false;
  let beforeUnloadBound = false;

  let bridgeSeq = 0;
  const bridgePending = new Map();

  // --- диагностика загрузки ---
  //
  // Журнал живёт только в памяти страницы и включается программно
  // через внутренний API для тестовых стендов. В записи попадают безопасные поля:
  // без токена, куки, заголовков, тела запросов, имён файлов, полных URL и
  // сырых ответов VK. Отчёт ограничен по размеру.

  const DIAG_MAX_EVENTS = 300;
  const DIAG_MAX_REPORT = 100 * 1024;
  const DIAG_STAGE = new Set([
    'queue',
    'auth',
    'auth-recovery',
    'check',
    'checking',
    'convert',
    'converting',
    'server',
    'transfer',
    'uploading',
    'save',
    'saving',
    'result',
    'library',
    'delete',
    'api',
  ]);
  const DIAG_CATEGORY = new Set([
    'ok',
    'network',
    'timeout',
    'cancel',
    'auth',
    'access',
    'captcha',
    'rate',
    'server',
    'response',
    'size',
    'format',
    'api',
    'convert',
    'repeat',
    'limit',
    'other',
  ]);
  const DIAG_RESULT = new Set([
    'start',
    'ok',
    'fail',
    'lost',
    'token',
    'refreshed',
    'account',
    'cancel',
    'retry',
    'unconfirmed',
  ]);
  const DIAG_AUTH = new Set(['ok', 'missing', 'bad-json', 'no-token', 'expired', 'storage']);
  const UPLOAD_HOSTS = new Set(['pu.vk.ru', 'pu.vk.com', 'pu.vk.me']);

  const diag = {
    enabled: false,
    started: 0,
    seq: 0,
    opSeq: 0,
    events: [],
  };

  function diagInt(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  function diagOp(prefix) {
    diag.opSeq = (diag.opSeq + 1) % 1000000;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${String(prefix || 'op').slice(0, 12)}-${diag.opSeq}-${rand}`;
  }

  function setDiagnosticsEnabled(next) {
    const value = !!next;
    if (value === diag.enabled) return;
    diag.enabled = value;
    if (value) {
      diag.started = Date.now();
      diag.seq = 0;
      diag.events = [];
      diag.opSeq = 0;
    }
  }

  function diagLog(entry) {
    if (!diag.enabled || !entry) return;
    const event = {
      n: ++diag.seq,
      at: diagInt(Date.now() - diag.started, 0, 24 * 60 * 60 * 1000),
      op: typeof entry.op === 'string' ? entry.op.slice(0, 48) : '',
      stage: DIAG_STAGE.has(entry.stage) ? entry.stage : 'api',
      result: DIAG_RESULT.has(entry.result) ? entry.result : 'fail',
    };
    if (entry.attempt != null) event.attempt = diagInt(entry.attempt, 1, 99);
    if (API_METHODS.has(entry.method)) event.method = entry.method;
    if (entry.category && DIAG_CATEGORY.has(entry.category)) event.category = entry.category;
    if (entry.http) event.http = diagInt(entry.http, 0, 599);
    if (entry.vk) event.vk = diagInt(entry.vk, 0, 9999);
    if (UPLOAD_HOSTS.has(entry.host)) event.host = entry.host;
    if (FORMAT_SET.has(entry.ext)) event.ext = entry.ext;
    if (entry.size != null) event.size = diagInt(entry.size, 0, 4 * 1024 * 1024 * 1024);
    if (entry.auth && DIAG_AUTH.has(entry.auth)) event.auth = entry.auth;
    if (entry.tokenChanged === true) event.tokenChanged = true;
    if (entry.accountChanged === true) event.accountChanged = true;
    if (entry.redirect === true) event.redirect = true;
    if (entry.dur != null) event.dur = diagInt(entry.dur, 0, 10 * 60 * 1000);
    diag.events.push(event);
    if (diag.events.length > DIAG_MAX_EVENTS) {
      diag.events.splice(0, diag.events.length - DIAG_MAX_EVENTS);
    }
  }

  function browserLabel() {
    try {
      const ua = navigator.userAgent || '';
      const match = ua.match(/(Edg|OPR|Chrome|Firefox|Safari)\/([0-9.]+)/);
      if (!match) return 'unknown';
      return `${match[1]} ${match[2].split('.')[0]}`;
    } catch (e) {
      return 'unknown';
    }
  }

  function diagnosticsReport() {
    if (!diag.enabled) return '';
    let version = 'unknown';
    try {
      const manifest = chrome.runtime.getManifest();
      version = manifest && manifest.version ? String(manifest.version) : 'unknown';
    } catch (e) {
      // без манифеста отчёт всё равно полезен
    }
    let events = diag.events.slice();
    let text = '';
    for (;;) {
      const report = {
        app: 'VK7TV',
        version,
        browser: browserLabel(),
        diagnostics: true,
        truncated: events.length < diag.events.length,
        events,
      };
      try {
        text = JSON.stringify(report);
      } catch (e) {
        text = '{"app":"VK7TV","events":[]}';
      }
      if (text.length <= DIAG_MAX_REPORT || events.length <= 1) break;
      events = events.slice(Math.max(1, Math.ceil(events.length / 4)));
    }
    return text;
  }

  function clearDiagnostics() {
    diag.events = [];
    diag.seq = 0;
    diag.started = Date.now();
  }

  function errorCategory(kind, e) {
    if (e && e.name === 'AbortError') return 'cancel';
    switch (kind) {
      case 'auth':
        return 'auth';
      case 'access':
        return 'access';
      case 'captcha':
        return 'captcha';
      case 'rate':
        return 'rate';
      case 'server':
        return 'server';
      case 'timeout':
        return 'timeout';
      case 'canceled':
        return 'cancel';
      case 'response':
      case 'api':
        return 'response';
      case 'size':
        return 'size';
      case 'format':
      case 'empty':
      case 'corrupt':
      case 'file':
        return 'format';
      case 'convert':
        return 'convert';
      case 'repeat':
        return 'repeat';
      case 'limit':
        return 'limit';
      case 'network':
        return 'network';
      default:
        return kind ? 'other' : 'network';
    }
  }

  function logError(e, meta) {
    const kind = e && e.kind ? e.kind : '';
    diagLog({
      op: meta && meta.op,
      stage: meta && meta.stage,
      attempt: meta && meta.attempt,
      method: meta && meta.method,
      result: 'fail',
      category: errorCategory(kind, e),
      http: e && e.httpStatus,
      vk: e && e.vkCode,
      host: (e && e.host) || (meta && meta.host),
      auth: meta && meta.auth,
      tokenChanged: meta && meta.tokenChanged,
      accountChanged: meta && meta.accountChanged,
      dur: meta && meta.dur,
      redirect: (e && e.redirected) || (meta && meta.redirect),
    });
  }

  function diagSpan(op, stage, attempt) {
    const started = Date.now();
    return (outcome, extra) =>
      diagLog({
        op,
        stage,
        attempt,
        ...(outcome || {}),
        ...(extra || {}),
        dur: Date.now() - started,
      });
  }

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
      return { ok: false, reason: 'storage', userId: 0, expires: 0 };
    }
    if (!raw) return { ok: false, reason: 'missing', userId: 0, expires: 0 };

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: 'bad-json', userId: 0, expires: 0 };
    }

    const token = data && typeof data.access_token === 'string' ? data.access_token.trim() : '';
    const userId =
      positive(data && data.user_id) ||
      positive(data && data.user && data.user.id) ||
      positive(data && data.uid) ||
      0;
    const expires = Number(data && data.expires) || 0;
    if (!token) return { ok: false, reason: 'no-token', userId, expires };

    // Просроченный токен не отправляем в API. Сохраняем его вместе с userId,
    // чтобы дождаться новой записи VK в хранилище и
    // отличить обновление токена того же аккаунта от смены аккаунта.
    if (expires && expires * 1000 <= Date.now() + 30000) {
      return { ok: false, reason: 'expired', token, userId, expires };
    }

    return { ok: true, token, userId, expires };
  }

  function authState(read) {
    return {
      status: read.ok ? 'ok' : read.reason === 'expired' ? 'expired' : 'missing',
      token: read.ok ? read.token : '',
      userId: read.ok ? read.userId : positive(read.userId),
      expires: read.ok ? read.expires : 0,
      reason: read.ok ? '' : read.reason || 'missing',
      source: read.ok ? 'local' : 'none',
    };
  }

  function localAuthMessage(reason) {
    return AUTH_LOCAL_TEXT[reason] || AUTH_LOCAL_TEXT.missing;
  }

  function authErrorMessage(e) {
    const source = e && e.authSource;
    if (source === 'account') return AUTH_ACCOUNT_TEXT;
    if (source === 'local') return localAuthMessage(e && e.reason);
    if (e && e.vkCode === 4) return AUTH_SIGNATURE_TEXT;
    return AUTH_TEXT;
  }

  function clearSession() {
    generation++;
    accountEpoch++;
    abortCurrent();
    abortDeletions();
    deletions = new Map();
    deletedKeys = new Set();
    deletedKeyCycles = new Map();
    readCycle++;
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

  // Смена аккаунта и потеря сессии делают поздние ответы удаления
  // недействительными: запросы обрываются, состояние операций сбрасывается.
  function abortDeletions() {
    for (const state of deletions.values()) {
      if (!state.ctrl) continue;
      try {
        state.ctrl.abort();
      } catch (e) {
        // запрос уже завершён
      }
      state.ctrl = null;
    }
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

  function checkAuth(context) {
    if (context && context.retryExpired && !expiredRecoveryPending) expiredRecoveryToken = '';
    const read = readAuth();
    const prevToken = auth.token;
    const prevUser = auth.userId;
    const tokenChanged = !!prevToken && read.ok && read.token !== prevToken;
    const accountChanged = !!prevUser && !!read.userId && prevUser !== read.userId;

    if (!read.ok && read.reason === 'expired' && read.userId &&
        (expiredRecoveryPending || expiredRecoveryToken !== read.token)) {
      if (!expiredRecoveryPending) {
        expiredRecoveryToken = read.token;
        if (accountChanged || !uploadsBelongTo(read.userId)) resetForAccount();
        else clearSession();
        auth = authState(read);
        status = 'loading';
        loading = true;
        error = null;
        const epoch = accountEpoch;
        expiredRecoveryPending = Promise.resolve().then(async () => {
          for (let attempt = 0; attempt < AUTH_RETRIES; attempt++) {
            const recovered = await recoverAuthForUser(read.userId, read.token,
              diagOp('library'), 'library', attempt);
            if (epoch !== accountEpoch) return;
            if (recovered) {
              status = 'idle';
              loading = false;
              error = null;
              resumeAuthUploads(true);
              notify();
              if (!paused) await loadMore();
              return;
            }
            const current = readAuth();
            if (current.userId !== read.userId || current.reason === 'missing') break;
          }
          loading = false;
          expiredRecoveryPending = null;
          checkAuth();
        }).finally(() => { expiredRecoveryPending = null; });
        notify();
      }
      return false;
    }

    if (!read.ok) {
      const had = auth.status === 'ok' || items.length > 0 || loaded;
      const message = localAuthMessage(read.reason);
      auth = authState(read);
      if (
        had ||
        status !== 'unauthorized' ||
        !error ||
        error.message !== message ||
        error.reason !== read.reason
      ) {
        clearSession();
        auth = authState(read);
        status = 'unauthorized';
        error = {
          kind: 'auth',
          message,
          authSource: 'local',
          reason: read.reason,
          retryable: false,
        };
        diagLog({
          op: context && context.op,
          stage: context && context.stage,
          result: had ? 'lost' : 'fail',
          category: 'auth',
          auth: read.reason,
          tokenChanged: !!prevToken,
          accountChanged,
        });
        notify();
      }
      return false;
    }

    expiredRecoveryToken = '';
    if (auth.status !== 'ok') {
      if (accountChanged || !uploadsBelongTo(read.userId)) {
        resetForAccount();
      }
      auth = authState(read);
      if (status === 'unauthorized') {
        status = 'idle';
        error = null;
      }
      diagLog({
        op: context && context.op,
        stage: context && context.stage,
        result: 'ok',
        category: 'ok',
        auth: 'ok',
        tokenChanged,
        accountChanged,
      });
      notify();
      resumeAuthUploads(true);
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
      diagLog({
        op: context && context.op,
        stage: context && context.stage,
        result: 'token',
        category: 'ok',
        auth: 'ok',
        tokenChanged: true,
        accountChanged: !!accountChanged && !sameUser,
      });
      notify();
      resumeAuthUploads(true);
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

  // VK сам обновляет запись входа. Только перечитываем её: никаких
  // запросов выдачи токена и записи в хранилище от расширения.
  async function recoverAuthForUser(expectedUser, usedToken, op, stage, attempt = 0, signal) {
    const epoch = accountEpoch;
    const knownUser = positive(expectedUser);
    if (attempt) await authRetryDelay(signal);
    if ((signal && signal.aborted) || epoch !== accountEpoch) return false;
    const read = readAuth();
    if (!knownUser || read.userId !== knownUser) {
      checkAuth();
      return false;
    }
    diagLog({ op, stage: 'auth-recovery', attempt: attempt + 1,
      result: read.ok ? 'token' : 'fail', category: read.ok ? 'ok' : 'auth',
      auth: read.ok ? 'ok' : read.reason,
      tokenChanged: read.ok && read.token !== usedToken });
    if (!read.ok) return false;
    auth = authState(read);
    return true;
  }

  function authRetryDelay(signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, AUTH_RETRY_DELAY);
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  }

  // --- сеть ---

  function apiError(kind, message, retryable, details) {
    const err = new Error(message || kind);
    err.kind = kind;
    err.retryable = !!retryable;
    if (details) {
      if (Number.isSafeInteger(details.httpStatus) && details.httpStatus > 0) {
        err.httpStatus = details.httpStatus;
      }
      if (Number.isSafeInteger(details.vkCode) && details.vkCode > 0) {
        err.vkCode = details.vkCode;
      }
      if (typeof details.authSource === 'string') err.authSource = details.authSource;
      if (typeof details.reason === 'string') err.reason = details.reason;
      if (UPLOAD_HOSTS.has(details.host)) err.host = details.host;
      if (details.redirected === true) err.redirected = true;
    }
    return err;
  }

  function hostOf(value) {
    try {
      const host = new URL(value).hostname;
      return UPLOAD_HOSTS.has(host) ? host : '';
    } catch (e) {
      return '';
    }
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

  function classifyVkError(vkError, httpStatus) {
    const code = Number(vkError && vkError.error_code) || 0;
    const details = { vkCode: code, httpStatus };
    // 5 — пользовательская авторизация, 4 — подпись запроса. Оба приходят
    // от VK, но действия разные, поэтому источник сохраняется отдельно.
    if (code === 5) return apiError('auth', 'auth', false, { ...details, authSource: 'api' });
    if (code === 4) return apiError('auth', 'auth', false, { ...details, authSource: 'signature' });
    if (code === 14) return apiError('captcha', 'captcha', false, details);
    if (code === 15 || code === 7) return apiError('access', 'access', false, details);
    if (code === 6 || code === 9) return apiError('rate', 'rate', true, details);
    if (code === 10) return apiError('server', 'server', true, details);
    // 1 — «неизвестная ошибка»: это не отказ авторизации. Не отправляем
    // пользователя заново входить из-за неё.
    return apiError('api', 'api', false, details);
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

  const API_METHODS = new Set(['docs.get', 'docs.getUploadServer', 'docs.save', 'docs.delete']);

  async function apiRequest(method, params, token, opts = {}) {
    const ctrl = new AbortController();
    const epoch = accountEpoch;
    const userId = auth.userId;
    if (opts.register) opts.register(ctrl);
    else aborts.add(ctrl);
    const options = { ...opts,
      register(child) {
        const abort = () => child.abort();
        ctrl.signal.addEventListener('abort', abort, { once: true });
        child.detach = () => ctrl.signal.removeEventListener('abort', abort);
        if (ctrl.signal.aborted) child.abort();
      },
      unregister(child) { child.detach(); },
    };
    let lastError;
    try {
      for (let attempt = 0; attempt <= AUTH_RETRIES; attempt++) {
        if (ctrl.signal.aborted || epoch !== accountEpoch) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (attempt) {
          const recovered = await recoverAuthForUser(userId, token,
            opts.op, opts.stage, attempt - 1, ctrl.signal);
          if (ctrl.signal.aborted || epoch !== accountEpoch) {
            throw new DOMException('Aborted', 'AbortError');
          }
          if (!recovered) {
            const current = readAuth();
            if (current.userId !== userId) throw lastError;
            continue;
          }
          token = auth.token;
        }
        try {
          return await apiRequestOnce(method, params, token, options);
        } catch (e) {
          if (!e || e.kind !== 'auth') throw e;
          lastError = e;
        }
      }
      throw lastError;
    } finally {
      if (opts.unregister) opts.unregister(ctrl);
      else aborts.delete(ctrl);
    }
  }

  async function apiRequestOnce(method, params, token, opts) {
    if (!API_METHODS.has(method)) throw apiError('api', 'api', false);
    const options = opts || {};
    const op = options.op || diagOp('api');
    const stage = options.stage || 'api';
    const attempt = options.attempt || 1;
    const started = Date.now();
    const ctrl = new AbortController();
    if (options.register) options.register(ctrl);
    else aborts.add(ctrl);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, options.timeout || REQUEST_TIMEOUT);
    let res = null;

    try {
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
      }

      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }

      if (res.status === 413) {
        throw apiError('size', 'size', false, { httpStatus: res.status });
      }
      if (res.status === 429) {
        throw apiError('rate', 'rate', true, { httpStatus: res.status });
      }
      if (res.status === 401) {
        throw apiError('auth', 'auth', false, {
          httpStatus: res.status,
          authSource: 'http',
        });
      }
      if (res.status === 403) {
        throw apiError('access', 'access', false, { httpStatus: res.status });
      }
      if (data && data.error) throw classifyVkError(data.error, res.status);
      if (res.status >= 500) {
        throw apiError('server', 'server', true, { httpStatus: res.status });
      }
      if (!res.ok) {
        throw apiError('response', 'response', false, { httpStatus: res.status });
      }
      if (!data || !data.response) {
        throw apiError('response', 'response', false, { httpStatus: res.status });
      }

      diagLog({
        op,
        stage,
        attempt,
        method,
        result: 'ok',
        category: 'ok',
        http: res.status,
        redirect: res.redirected === true,
        dur: Date.now() - started,
      });
      return data.response;
    } catch (e) {
      logError(e, {
        op,
        stage,
        attempt,
        method,
        dur: Date.now() - started,
        auth: options.auth,
      });
      throw e;
    } finally {
      clearTimeout(timer);
      if (options.unregister) options.unregister(ctrl);
      else aborts.delete(ctrl);
    }
  }

  async function requestOnce(token, at, opId, attempt) {
    const response = await apiRequest(
      'docs.get',
      { count: PAGE, offset: at },
      token,
      {
        timeout: REQUEST_TIMEOUT,
        op: opId,
        stage: 'library',
        attempt: attempt || 1,
        auth: 'ok',
      }
    );
    if (!response || !Array.isArray(response.items)) {
      throw apiError('response', 'response', false);
    }
    return response;
  }

  async function requestPage(token, at, opId) {
    const epoch = abortEpoch;
    try {
      return await requestOnce(token, at, opId, 1);
    } catch (e) {
      if (!e || !e.retryable || e.name === 'AbortError') throw e;
      await delay(RETRY_DELAY);
      if (epoch !== abortEpoch) {
        throw new DOMException('aborted', 'AbortError');
      }
      return requestOnce(token, at, opId, 2);
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
      if (!doc || seen.has(doc.key) || deletedKeys.has(doc.key)) continue;
      seen.add(doc.key);
      merged.push(doc);
    }
    for (const doc of serverItems) {
      if (!doc || seen.has(doc.key) || deletedKeys.has(doc.key)) continue;
      seen.add(doc.key);
      merged.push(doc);
    }
    // Пока результат удаления не подтверждён, карточка остаётся на месте:
    // иначе частичное обновление библиотеки выглядело бы как успех.
    for (const state of deletions.values()) {
      const doc = state.doc;
      if (!doc || seen.has(doc.key) || deletedKeys.has(doc.key)) continue;
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
    readCycle++;
  }

  // Исключение снимаем только после полного успешного чтения, начатого
  // после удаления: пока список не прочитан целиком, отсутствие документа
  // ничего не доказывает.
  function clearConfirmedExclusions() {
    for (const [key, cycle] of [...deletedKeyCycles]) {
      if (readCycle > cycle && !rawSeen.has(key)) {
        deletedKeys.delete(key);
        deletedKeyCycles.delete(key);
      }
    }
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

  // --- удаление документов VK ---

  const DELETE_FATAL = new Set(['auth', 'access', 'captcha', 'rate', 'server', 'api']);

  function deletionPublic(state) {
    return {
      key: state.key,
      status: state.status,
      message: state.message,
      errorKind: state.errorKind,
      checking: !!state.checking,
    };
  }

  function getDeletion(key) {
    const state = deletions.get(key);
    return state ? deletionPublic(state) : null;
  }

  function isDeleting(key) {
    const state = deletions.get(key);
    return !!state && state.status === 'pending';
  }

  function deletionCurrent(state, key, epoch, userId) {
    if (deletions.get(key) !== state) return false;
    if (epoch !== accountEpoch) return false;
    if (userId && auth.userId && userId !== auth.userId) return false;
    return true;
  }

  function dropDocumentKey(key) {
    serverItems = serverItems.filter((doc) => doc.key !== key);
    localUploads.delete(key);
    byKey.delete(key);
  }

  function applyDeletionSuccess(state, key) {
    if (deletions.get(key) === state) deletions.delete(key);
    const cycle = readCycle;
    deletedKeys.add(key);
    deletedKeyCycles.set(key, cycle);
    const wasLoaded = loaded;
    dropDocumentKey(key);
    rebuildLibrary();
    // Смещения серверной библиотеки после удаления сдвинулись: продолжать
    // со старым offset нельзя, иначе часть документов будет пропущена.
    markPaginationStale();
    if (wasLoaded && !items.length) status = 'empty';
    else if (items.length && status === 'empty') status = 'ready';
    notify();
  }

  function setDeletionFailure(state, key, cause) {
    if (deletions.get(key) !== state) return;
    let kind = cause && cause.kind ? cause.kind : '';
    if (!kind) {
      kind = cause && cause.name === 'AbortError' ? 'aborted' : 'network';
    }
    state.ctrl = null;
    state.errorKind = kind;
    if (DELETE_FATAL.has(kind)) {
      state.status = 'error';
      state.message = DELETE_MESSAGES[kind] || DELETE_MESSAGES.api;
    } else {
      state.status = 'unknown';
      state.message = DELETE_MESSAGES[kind] || DELETE_MESSAGES.network;
    }
    notify();
  }

  // Одна операция на подтверждённое удержание. Повторный вызов, пока
  // запрос или восстановление токена в пути, ничего не отправляет.
  function deleteDocument(key) {
    if (typeof key !== 'string' || !key) {
      return Promise.resolve({ ok: false, reason: 'key' });
    }
    const current = deletions.get(key);
    if (current && current.status === 'pending') {
      return Promise.resolve({ ok: false, reason: 'pending' });
    }
    if (!checkAuth()) {
      return Promise.resolve({ ok: false, reason: 'auth' });
    }
    const doc = byKey.get(key);
    if (!doc) return Promise.resolve({ ok: false, reason: 'stale' });

    const epoch = accountEpoch;
    const userId = auth.userId;
    const state = {
      key,
      status: 'pending',
      message: '',
      errorKind: '',
      doc,
      accountEpoch: epoch,
      userId,
      ctrl: null,
      checking: false,
    };
    deletions.set(key, state);
    rebuildLibrary();
    notify();

    return apiRequest(
      'docs.delete',
      { owner_id: doc.ownerId, doc_id: doc.id },
      auth.token,
      {
        timeout: REQUEST_TIMEOUT,
        register: (ctrl) => {
          state.ctrl = ctrl;
        },
        unregister: () => {
          state.ctrl = null;
        },
      }
    )
      .then((response) => {
        if (!deletionCurrent(state, key, epoch, userId)) {
          return { ok: false, reason: 'stale' };
        }
        if (response !== 1) {
          setDeletionFailure(state, key, { kind: 'response' });
          return { ok: false, reason: 'response' };
        }
        applyDeletionSuccess(state, key);
        return { ok: true };
      })
      .catch((e) => {
        if (!deletionCurrent(state, key, epoch, userId)) {
          return { ok: false, reason: 'stale' };
        }
        setDeletionFailure(state, key, e);
        return { ok: false, reason: 'failed' };
      });
  }

  // После обрыва связи операция могла выполниться на сервере. Отсутствие
  // документа принимаем только после полного чтения с первой страницы.
  async function verifyDeletion(key) {
    const state = deletions.get(key);
    if (!state || state.status !== 'unknown' || state.checking) {
      return { ok: false, reason: 'state' };
    }
    if (!checkAuth() || deletions.get(key) !== state) {
      return { ok: false, reason: 'auth' };
    }
    const epoch = accountEpoch;
    const userId = auth.userId;
    state.checking = true;
    notify();

    let incomplete = false;
    try {
      await refresh();
      if (!deletionCurrent(state, key, epoch, userId)) {
        return { ok: false, reason: 'stale' };
      }
      if (error || !auth.token) {
        incomplete = true;
      } else {
        await loadAll();
      }
    } catch (e) {
      incomplete = true;
    }

    if (!deletionCurrent(state, key, epoch, userId)) {
      return { ok: false, reason: 'stale' };
    }
    state.checking = false;

    if (incomplete || !loaded || loading || error) {
      notify();
      return { ok: false, reason: 'incomplete' };
    }

    if (rawSeen.has(key)) {
      // Документ на месте: возвращаем обычную карточку и снимаем состояние.
      deletedKeys.delete(key);
      deletedKeyCycles.delete(key);
      deletions.delete(key);
      rebuildLibrary();
      notify();
      return { ok: true, found: true };
    }

    deletedKeys.add(key);
    deletedKeyCycles.set(key, readCycle);
    deletions.delete(key);
    dropDocumentKey(key);
    rebuildLibrary();
    notify();
    return { ok: true, deleted: true };
  }

  function deletionsState() {
    return [...deletions.values()].map(deletionPublic);
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
      error = {
        kind: 'auth',
        message: authErrorMessage(e),
        authSource: (e && e.authSource) || 'local',
        reason: (e && e.reason) || '',
        retryable: false,
        search: !!search,
      };
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
      error = {
        kind: 'api',
        message: 'VK отклонил запрос. Повтори загрузку.',
        retryable: true,
        search: !!search,
      };
      return;
    }
    error = { kind: e.kind || 'network', message: NETWORK_TEXT, retryable: true, search: !!search };
  }

  async function runLoop(all) {
    if (!checkAuth()) {
      loading = !!expiredRecoveryPending;
      inFlight = null;
      inFlightGen = 0;
      return;
    }
    const gen = generation;
    const opId = diagOp('library');

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
        try {
          response = await requestPage(auth.token, offset, opId);
        } catch (e) {
          if (gen !== generation) return;
          if (e && e.name === 'AbortError') return;
          if (e && e.kind === 'auth') {
            status = 'unauthorized';
            error = {
              kind: 'auth',
              message: authErrorMessage(e),
              authSource: e.authSource || 'api',
              reason: e.reason || '',
              retryable: false,
            };
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
          // Подтверждённое удаление не отменяем поздней страницей. Ключ
          // уже в rawSeen, поэтому повторно ту же страницу не запрашиваем.
          if (deletedKeys.has(key)) continue;
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
          // Плейсхолдер незавершённого удаления не должен мешать серверной
          // странице заново положить документ в serverItems: иначе после
          // проверки он исчезнет из списка, хотя фактически найден.
          if (byKey.has(doc.key) && !deletions.has(doc.key)) continue;
          byKey.set(doc.key, doc);
          serverItems.push(doc);
          added++;
        }
        rebuildLibrary();
        offset += rawCount;
        error = null;

        if (rawCount === 0) {
          loaded = true;
          clearConfirmedExclusions();
          break;
        }
        if (newRaw === 0) {
          setError(apiError('repeat', 'repeat', false), !!query);
          break;
        }
        if (total > 0 && offset >= total) {
          loaded = true;
          clearConfirmedExclusions();
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
      loading = !!expiredRecoveryPending;
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
    if (!checkAuth({ retryExpired: true })) return expiredRecoveryPending || Promise.resolve();
    generation++;
    abortCurrent();
    offset = 0;
    total = 0;
    rawSeen = new Set();
    loaded = false;
    readCycle++;
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
        job.stage === 'converting' ||
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
      originalName: job.originalName || job.name,
      mime: job.mime || '',
      size: job.size,
      stage: job.stage,
      loaded: job.loaded,
      total: job.total,
      transferIdleSeconds: job.transferIdleSeconds || 0,
      note: job.note || '',
      converted: !!job.converted,
      convertedFrame: job.convertedFrame || 0,
      convertedTotal: job.convertedTotal || 0,
      mp4Mode: job.mp4Mode || 'original',
      error: job.error
        ? {
            kind: job.error.kind,
            message: job.error.message,
            httpStatus: job.error.httpStatus || 0,
            vkCode: job.error.vkCode || 0,
            stage: job.error.stage || '',
            authSource: job.error.authSource || '',
            retryable: !!job.error.retryable,
          }
        : null,
      canCancel: uploadStageActive(job),
      canRetry: !!job.canRetry,
      canDismiss: uploadTerminal(job),
      canUploadOriginal: !!job.canUploadOriginal,
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
    if (job.convertCancel) {
      try {
        job.convertCancel('canceled', 'Загрузка отменена');
      } catch (e) {
        // конвертер уже завершён
      }
      job.convertCancel = null;
    }
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
    if (!checkAuth({ op: job.opId, stage: job.stage })) {
      const reason = auth.reason || 'missing';
      diagLog({
        op: job.opId,
        stage: job.stage,
        result: 'fail',
        category: 'auth',
        auth: DIAG_AUTH.has(reason) ? reason : 'missing',
      });
      throw uploadError('auth', localAuthMessage(reason), {
        authSource: 'local',
        reason,
      });
    }
    if (!owned(job) || !uploadStageActive(job)) throw uploadError('canceled');
  }

  function uploadError(kind, message, details) {
    return apiError(
      kind,
      message || UPLOAD_ERRORS[kind] || UPLOAD_ERRORS.response,
      false,
      details
    );
  }

  function jobErrorKind(e) {
    if (!e) return 'response';
    if (e.kind) return e.kind;
    if (e.name === 'AbortError') return 'canceled';
    return 'network';
  }

  function canRetryKind(kind, e) {
    if (e && e.authSource === 'account') return false;
    return (
      kind !== 'format' &&
      kind !== 'empty' &&
      kind !== 'corrupt' &&
      kind !== 'size' &&
      kind !== 'access' &&
      kind !== 'file' &&
      kind !== 'convert-unsupported' &&
      kind !== 'convert-limit' &&
      kind !== 'convert-gif-size' &&
      kind !== 'convert-corrupt' &&
      kind !== 'convert-decode' &&
      kind !== 'convert-duration' &&
      kind !== 'convert-no-video' &&
      kind !== 'convert-failed'
    );
  }

  function setJobError(job, e) {
    const kind = jobErrorKind(e);
    if (kind === 'canceled') return;
    const failedStage = job.stage;
    job.stage = 'error';
    job.note = '';
    let message = UPLOAD_ERRORS[kind] || UPLOAD_ERRORS.response;
    if (kind === 'auth') message = authErrorMessage(e);
    else if (kind.startsWith('convert-') && e && e.message) message = e.message;
    job.error = {
      kind,
      message,
      httpStatus: (e && e.httpStatus) || 0,
      vkCode: (e && e.vkCode) || 0,
      stage: failedStage || 'result',
      authSource: (e && e.authSource) || '',
      retryable: !!(e && e.retryable),
    };
    job.canRetry = canRetryKind(kind, e);
    job.canDismiss = true;
    // После ошибки преобразования исходный MP4 остаётся в задании: его
    // можно отправить только явным действием, автоматической подмены нет.
    job.canUploadOriginal = !!(
      kind.startsWith('convert-') &&
      job.mp4Mode === 'gif' &&
      job.originalExt === 'mp4' &&
      job.file
    );
    job.xhr = null;
    job.ctrl = null;
    if (kind === 'auth') uploadAuthHold = true;
    logError(e, {
      op: job.opId,
      stage: 'result',
      auth: kind === 'auth' ? 'ok' : '',
    });
    updateUploadLifecycle();
    notify();
  }

  function finishUnconfirmed(job, message) {
    job.stage = 'unconfirmed';
    job.note = '';
    job.error = {
      kind: 'unconfirmed',
      message: message || UPLOAD_ERRORS.unconfirmed,
    };
    job.canRetry = true;
    job.canDismiss = true;
    job.xhr = null;
    job.ctrl = null;
    diagLog({
      op: job.opId,
      stage: 'result',
      result: 'unconfirmed',
      category: 'response',
      ext: job.ext,
      size: job.size,
    });
    updateUploadLifecycle();
    notify();
  }

  function finishCanceled(job, message) {
    job.stage = 'canceled';
    job.note = '';
    job.error = message ? { kind: 'canceled', message } : null;
    job.canRetry = false;
    job.canDismiss = true;
    job.xhr = null;
    job.ctrl = null;
    releaseJobFile(job);
    diagLog({
      op: job.opId,
      stage: 'result',
      result: 'cancel',
      category: 'cancel',
      ext: job.ext,
      size: job.size,
    });
    updateUploadLifecycle();
    notify();
  }

  function resumeAuthUploads(authChanged) {
    if (!uploadAuthHold || !uploads.size || !authChanged) return;
    uploadAuthHold = false;
    let changed = false;
    for (const job of uploads.values()) {
      if (job.stage === 'error' && job.error && job.error.kind === 'auth') {
        job.stage = 'queued';
        job.error = null;
        job.canRetry = false;
        job.canDismiss = false;
        // Новый запуск получает новый ограниченный цикл перечитывания токена.
        job.authRetry = 0;
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

  function gifNameFor(name) {
    const value = String(name || '');
    const dot = value.lastIndexOf('.');
    const base = dot > 0 ? value.slice(0, dot) : value;
    return (base || 'file') + '.gif';
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

    let webp = null;
    if (detected === 'webp' && WEBP_PARSER) {
      try {
        webp = await WEBP_PARSER.inspectFile(file);
      } catch (e) {
        if (e && e.code === 'limit') {
          throw uploadError('convert-limit', UPLOAD_ERRORS['convert-limit']);
        }
        throw uploadError('corrupt');
      }
    }

    // MP4 проверяем по боксам, а не только по ftyp: обрезанный ролик или
    // переименованный файл не должен уйти в VK как видео.
    let mp4 = null;
    if (detected === 'mp4' && MP4_PARSER) {
      try {
        mp4 = await MP4_PARSER.inspectFile(file);
      } catch (e) {
        throw uploadError('corrupt');
      }
    }
    return { ext, detected, webp, mp4 };
  }

  async function convertJob(job, info) {
    requireUploadAuth(job);
    job.stage = 'converting';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = false;
    job.note = WEBP_HINT;
    job.convertedFrame = 0;
    job.convertedTotal = info && info.webp ? info.webp.frameCount : 0;
    notify();

    if (!WEBP_CONVERT) {
      throw uploadError('convert-unsupported', UPLOAD_ERRORS['convert-unsupported']);
    }

    let data;
    try {
      data = await job.file.arrayBuffer();
    } catch (e) {
      throw uploadError('file');
    }
    requireUploadAuth(job);

    let conversion;
    try {
      conversion = WEBP_CONVERT.startConversion({
        data,
        fileSize: job.file.size,
        onProgress: (progress) => {
          if (!owned(job) || job.stage !== 'converting') return;
          job.convertedFrame = Number(progress.frame) || 0;
          job.convertedTotal = Number(progress.total) || job.convertedTotal;
          notify();
        },
      });
    } catch (e) {
      throw uploadError('convert-worker', UPLOAD_ERRORS['convert-worker']);
    }
    job.convertCancel = conversion.cancel;

    let buffer;
    try {
      buffer = await conversion.promise;
    } catch (e) {
      if (!owned(job) || job.stage === 'canceled') throw uploadError('canceled');
      const code = e && e.kind ? e.kind : 'failed';
      const kind = 'convert-' + (UPLOAD_ERRORS['convert-' + code] ? code : 'failed');
      throw uploadError(kind, (e && e.message) || UPLOAD_ERRORS[kind]);
    } finally {
      job.convertCancel = null;
    }

    requireUploadAuth(job);
    if (!buffer || !buffer.byteLength) {
      throw uploadError('convert-failed', UPLOAD_ERRORS['convert-failed']);
    }
    if (buffer.byteLength > LIMITS.gifBytes) {
      throw uploadError('convert-gif-size', UPLOAD_ERRORS['convert-gif-size']);
    }

    const gifName = gifNameFor(job.originalName || job.name);
    let gifFile;
    try {
      gifFile = new File([buffer], gifName, {
        type: 'image/gif',
        lastModified: job.file.lastModified || Date.now(),
      });
    } catch (e) {
      throw uploadError('convert-failed', UPLOAD_ERRORS['convert-failed']);
    }
    if (!gifFile.size) {
      throw uploadError('convert-failed', UPLOAD_ERRORS['convert-failed']);
    }

    // Исходный WebP больше не нужен. Дальше очередь работает только с GIF.
    job.file = gifFile;
    job.name = gifName;
    job.mime = 'image/gif';
    job.size = gifFile.size;
    job.total = gifFile.size;
    job.loaded = 0;
    job.converted = true;
    job.note = '';
    notify();
  }

  async function convertVideoJob(job, info) {
    requireUploadAuth(job);
    job.stage = 'converting';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = false;
    job.canUploadOriginal = false;
    job.note = VIDEO_HINT;
    job.convertedFrame = 0;
    job.convertedTotal = 0;
    notify();

    if (!MP4_CONVERT) {
      throw uploadError(
        'convert-unsupported',
        'Браузер не может преобразовать видео в GIF. Загрузите исходное видео.'
      );
    }
    if (info && info.mp4 && !info.mp4.hasVideo) {
      throw uploadError('convert-no-video', UPLOAD_ERRORS['convert-no-video']);
    }
    if (info && info.mp4 && info.mp4.encrypted) {
      throw uploadError(
        'convert-unsupported',
        'Защищённое видео нельзя преобразовать в GIF. Загрузите исходное видео.'
      );
    }

    if (job.file.size > VIDEO_LIMITS.sourceBytes) {
      throw uploadError(
        'convert-limit',
        'Видео больше 32 МиБ — уменьшите файл или загрузите исходное видео.'
      );
    }

    let data;
    try {
      data = await job.file.arrayBuffer();
    } catch (e) {
      throw uploadError('file');
    }
    requireUploadAuth(job);

    let conversion;
    try {
      conversion = MP4_CONVERT.startConversion({
        data,
        fileSize: job.file.size,
        onProgress: (progress) => {
          if (!owned(job) || job.stage !== 'converting') return;
          job.convertedFrame = Number(progress.frame) || 0;
          job.convertedTotal = Number(progress.total) || job.convertedTotal;
          notify();
        },
      });
    } catch (e) {
      throw uploadError('convert-worker', 'Не удалось запустить преобразование видео в GIF.');
    }
    job.convertCancel = conversion.cancel;

    let buffer;
    try {
      buffer = await conversion.promise;
    } catch (e) {
      if (!owned(job) || job.stage === 'canceled') throw uploadError('canceled');
      const code = e && e.kind ? e.kind : 'failed';
      const kind = 'convert-' + (UPLOAD_ERRORS['convert-' + code] ? code : 'failed');
      throw uploadError(kind, (e && e.message) || UPLOAD_ERRORS[kind]);
    } finally {
      job.convertCancel = null;
    }

    requireUploadAuth(job);
    if (!buffer || !buffer.byteLength) {
      throw uploadError('convert-failed', 'Не удалось преобразовать видео в GIF.');
    }
    if (buffer.byteLength > VIDEO_LIMITS.gifBytes) {
      throw uploadError('convert-gif-size', UPLOAD_ERRORS['convert-gif-size']);
    }

    const gifName = gifNameFor(job.originalName || job.name);
    let gifFile;
    try {
      gifFile = new File([buffer], gifName, {
        type: 'image/gif',
        lastModified: job.file.lastModified || Date.now(),
      });
    } catch (e) {
      throw uploadError('convert-failed', 'Не удалось преобразовать видео в GIF.');
    }
    if (!gifFile.size) {
      throw uploadError('convert-failed', 'Не удалось преобразовать видео в GIF.');
    }

    // Исходный MP4 больше не нужен до явного «Загрузить исходное видео».
    job.file = gifFile;
    job.name = gifName;
    job.mime = 'image/gif';
    job.ext = 'gif';
    job.size = gifFile.size;
    job.total = gifFile.size;
    job.loaded = 0;
    job.converted = true;
    job.canUploadOriginal = false;
    job.note = '';
    notify();
  }

  async function getUploadUrl(job) {
    job.stage = 'server';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = false;
    notify();

    let lastError = null;
    let networkRetries = 0;
    for (let attempt = 1; ; attempt++) {
      requireUploadAuth(job);
      const usedToken = auth.token;
      try {
        const response = await apiRequest(
          'docs.getUploadServer',
          { group_id: '0' },
          usedToken,
          {
            timeout: REQUEST_TIMEOUT,
            op: job.opId,
            stage: 'server',
            attempt,
            auth: 'ok',
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
        diagSpan(job.opId, 'server', attempt)({
          result: 'ok',
          category: 'ok',
          ext: job.ext || extensionOf(job.name),
          size: job.size,
        });
        return url;
      } catch (e) {
        lastError = e;
        const retryable =
          e && (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'server');
        if (!retryable || networkRetries >= 1) break;
        networkRetries++;
        await delay(RETRY_DELAY);
        requireUploadAuth(job);
      }
    }
    throw lastError || uploadError('response');
  }

  function transferUpload(job, uploadUrl, attempt) {
    const uploadHost = hostOf(uploadUrl);
    const startedAt = Date.now();
    const attemptNo = attempt || 1;
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
        if (e) e.host = uploadHost;
        logError(e, {
          op: job.opId,
          stage: 'transfer',
          attempt: attemptNo,
          dur: Date.now() - startedAt,
          host: uploadHost,
        });
        reject(e);
      };
      const done = (fileId) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        job.xhr = null;
        diagLog({
          op: job.opId,
          stage: 'transfer',
          attempt: attemptNo,
          result: 'ok',
          category: 'ok',
          http: xhr.status,
          host: uploadHost,
          ext: extensionOf(job.name),
          size: job.size,
          redirect:
            !!xhr.responseURL &&
            hostOf(xhr.responseURL) !== uploadHost,
          dur: Date.now() - startedAt,
        });
        resolve(fileId);
      };

      const xhr = new XMLHttpRequest();
      job.xhr = xhr;
      job.loaded = 0;
      job.total = job.size;
      job.transferIdleSeconds = 0;
      notify();

      // Таймаут именно отсутствия прогресса: VK может отдавать ответ долго,
      // но пока байты идут, запрос прерывать нельзя.
      const timer = setInterval(() => {
        if (settled) return;
        const idleMs = Date.now() - lastProgress;
        job.transferIdleSeconds = Math.floor(idleMs / 1000);
        if (idleMs > UPLOAD_IDLE_TIMEOUT) {
          // Сначала фиксируем таймаут: abort() синхронно вызовет onabort,
          // и без этого ошибка выглядела бы как отмена пользователем.
          fail(uploadError('timeout'));
          try {
            xhr.abort();
          } catch (e) {}
          return;
        }
        // Обновляем ожидание даже когда браузер не присылает progress.
        notify();
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
          job.transferIdleSeconds = 0;
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
          fail(uploadError('size', null, { httpStatus: xhr.status }));
          return;
        }
        if (xhr.status === 429) {
          fail(uploadError('rate', null, { httpStatus: xhr.status }));
          return;
        }
        if (xhr.status === 401) {
          fail(
            uploadError('auth', null, {
              httpStatus: xhr.status,
              authSource: 'http',
            })
          );
          return;
        }
        if (xhr.status === 403) {
          fail(uploadError('access', null, { httpStatus: xhr.status }));
          return;
        }
        if (xhr.status >= 500) {
          fail(uploadError('server', null, { httpStatus: xhr.status }));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(uploadError('response', null, { httpStatus: xhr.status }));
          return;
        }
        let body;
        try {
          body = JSON.parse(xhr.responseText);
        } catch (e) {
          fail(uploadError('response', null, { httpStatus: xhr.status }));
          return;
        }
        if (body && body.error) {
          try {
            fail(classifyVkError(body.error, xhr.status));
          } catch (e) {
            fail(uploadError('response', null, { httpStatus: xhr.status }));
          }
          return;
        }
        const fileId = body && typeof body.file === 'string' ? body.file.trim() : '';
        if (!fileId) {
          fail(uploadError('response', null, { httpStatus: xhr.status }));
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

  function docFromSave(response) {    if (!response) return null;
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

  function maxLoadedDocId() {
    let max = 0;
    for (const doc of byKey.values()) {
      if (doc && doc.id > max) max = doc.id;
    }
    return max;
  }

  function completeUploadSuccess(job, doc) {
    addLocalDocument(doc);
    job.docKey = doc.key;
    job.stage = 'success';
    job.error = null;
    job.note = '';
    job.canRetry = false;
    job.canDismiss = true;
    job.fileId = '';
    job.verifying = false;
    releaseJobFile(job);
    diagLog({
      op: job.opId,
      stage: 'result',
      result: 'ok',
      category: 'ok',
      ext: doc.ext,
      size: doc.size,
    });
    updateUploadLifecycle();
    notify();
  }

  // После неоднозначного docs.save проверяем первую страницу документов:
  // новый документ с тем же именем и размером и id выше исходного максимума
  // считается результатом этой загрузки. Полный список не перечитываем.
  async function verifySavedUpload(job) {
    if (!owned(job)) return { ok: false, reason: 'stale' };
    if (!job.baselineReady) return { ok: false, reason: 'baseline' };
    if (!checkAuth({ op: job.opId, stage: 'result' })) {
      return { ok: false, reason: 'auth' };
    }
    const started = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await delay(800);
      if (!owned(job)) return { ok: false, reason: 'stale' };
      try {
        const response = await apiRequest(
          'docs.get',
          { count: PAGE, offset: 0 },
          auth.token,
          {
            timeout: REQUEST_TIMEOUT,
            op: job.opId,
            stage: 'result',
            attempt,
            auth: 'ok',
          }
        );
        if (!owned(job)) return { ok: false, reason: 'stale' };
        if (!response || !Array.isArray(response.items)) {
          return { ok: false, reason: 'response' };
        }
        for (const raw of response.items) {
          const doc = normalizeDoc(raw);
          if (!doc) continue;
          if (doc.title !== job.name) continue;
          if (job.size && doc.size && doc.size !== job.size) continue;
          if (job.baselineMaxId && doc.id <= job.baselineMaxId) continue;
          diagLog({
            op: job.opId,
            stage: 'result',
            result: 'ok',
            category: 'ok',
            ext: doc.ext,
            size: doc.size,
            dur: Date.now() - started,
          });
          return { ok: true, found: true, doc };
        }
      } catch (e) {
        return { ok: false, reason: jobErrorKind(e) };
      }
    }
    diagLog({
      op: job.opId,
      stage: 'result',
      result: 'fail',
      category: 'response',
      dur: Date.now() - started,
    });
    return { ok: true, found: false };
  }

  async function saveUpload(job) {
    if (!job.fileId) throw uploadError('response');
    requireUploadAuth(job);
    job.stage = 'saving';
    job.error = null;
    job.canRetry = false;
    job.canDismiss = false;
    job.saveAttempt = (job.saveAttempt || 0) + 1;
    // Максимальный id до сохранения позволяет отличить новый документ от
    // уже существовавшего с тем же именем и размером. Если библиотека ещё
    // не прочитана и пуста, отличить новый документ нечем.
    if (job.baselineMaxId == null) {
      job.baselineMaxId = maxLoadedDocId();
      job.baselineReady = loaded || byKey.size > 0;
    }
    notify();

    let response;
    const usedToken = auth.token;
    try {
      response = await apiRequest(
        'docs.save',
        { file: job.fileId, title: job.name },
        usedToken,
        {
          timeout: REQUEST_TIMEOUT,
          op: job.opId,
          stage: 'save',
          attempt: job.saveAttempt,
          auth: 'ok',
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
      if (kind === 'auth') throw e;
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

    completeUploadSuccess(job, doc);
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
      job.canUploadOriginal = false;
      notify();
      if (!job.file) throw uploadError('file');
      const checkSpan = diagSpan(job.opId, 'check', 1);
      const info = await validateUploadFile(job.file, job.name);
      job.ext = info.ext;
      checkSpan({
        result: 'ok',
        category: 'ok',
        ext: info.ext,
        size: job.size,
      });
      requireUploadAuth(job);

      if (info.webp && info.webp.animated) {
        const convertSpan = diagSpan(job.opId, 'convert', 1);
        try {
          await convertJob(job, info);
          convertSpan({
            result: 'ok',
            category: 'ok',
            ext: 'gif',
            size: job.size,
          });
        } catch (e) {
          convertSpan({
            result: 'fail',
            category: 'convert',
            ext: job.ext,
            size: job.size,
          });
          throw e;
        }
        requireUploadAuth(job);
      } else if (info.detected === 'mp4' && job.mp4Mode === 'gif') {
        const convertSpan = diagSpan(job.opId, 'convert', 1);
        try {
          await convertVideoJob(job, info);
          convertSpan({
            result: 'ok',
            category: 'ok',
            ext: 'gif',
            size: job.size,
          });
        } catch (e) {
          convertSpan({
            result: 'fail',
            category: 'convert',
            ext: job.ext,
            size: job.size,
          });
          throw e;
        }
        requireUploadAuth(job);
      }

      let uploadUrl = await getUploadUrl(job);
      requireUploadAuth(job);

      let fileId = '';
      for (let attempt = 1; ; attempt++) {
        job.stage = 'uploading';
        job.loaded = 0;
        job.total = job.size;
        notify();
        try {
          fileId = await transferUpload(job, uploadUrl, attempt);
          break;
        } catch (e) {
          if (e && e.kind === 'auth' && job.authRetry < AUTH_RETRIES) {
            job.authRetry = (job.authRetry || 0) + 1;
            const recovered = await recoverAuthForUser(
              job.userId,
              auth.token,
              job.opId,
              'transfer',
              job.authRetry - 1
            );
            if (recovered && owned(job) && job.stage !== 'canceled') {
              // Подписанный адрес мог быть выдан до смены входа. Берём
              // новый; байты ещё ни разу не были приняты VK.
              uploadUrl = await getUploadUrl(job);
              requireUploadAuth(job);
              continue;
            }
          }
          throw e;
        }
      }
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
    if (!checkAuth({ op: next.opId, stage: 'queue' })) {
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

  function enqueueUploads(files, options) {
    const list = Array.from(files || []);
    if (!list.length) return [];
    const requestedMode =
      options && options.mp4Mode === 'gif' ? 'gif' : 'original';
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
      const opId = diagOp('upload');
      const ext = extensionOf(file.name);
      uploads.set(id, {
        id,
        opId,
        ext: FORMAT_SET.has(ext) ? ext : '',
        name: file.name,
        originalName: file.name,
        originalSize: Number(file.size) || 0,
        originalMime: file.type || '',
        originalExt: ext,
        mime: file.type || '',
        size: Number(file.size) || 0,
        stage: 'queued',
        loaded: 0,
        total: Number(file.size) || 0,
        error: null,
        note: '',
        converted: false,
        convertedFrame: 0,
        convertedTotal: 0,
        mp4Mode: ext === 'mp4' ? requestedMode : 'original',
        canRetry: false,
        canDismiss: false,
        canUploadOriginal: false,
        docKey: '',
        file,
        fileId: '',
        xhr: null,
        ctrl: null,
        userId,
        accountEpoch: epoch,
        lastProgressAt: 0,
        authRetry: 0,
        saveAttempt: 0,
        baselineMaxId: null,
        baselineReady: false,
        verifying: false,
      });
      diagLog({
        op: opId,
        stage: 'queue',
        attempt: 1,
        result: 'start',
        category: 'ok',
        ext: FORMAT_SET.has(ext) ? ext : '',
        size: Number(file.size) || 0,
        auth: auth.status === 'ok' ? 'ok' : auth.reason || 'missing',
        tokenChanged: false,
        accountChanged: false,
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
        originalName: String(entry.name),
        originalSize: Number(entry.size) || 0,
        originalMime: '',
        originalExt: '',
        mime: '',
        size: Number(entry.size) || 0,
        stage: 'error',
        loaded: 0,
        total: 0,
        error: {
          kind,
          message: entry.message || UPLOAD_ERRORS[kind] || UPLOAD_ERRORS.file,
        },
        note: '',
        converted: false,
        convertedFrame: 0,
        convertedTotal: 0,
        mp4Mode: 'original',
        canRetry: false,
        canDismiss: true,
        canUploadOriginal: false,
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

  function queueUploadJob(job) {
    job.stage = 'queued';
    job.error = null;
    job.note = '';
    job.canRetry = false;
    job.canDismiss = false;
    job.canUploadOriginal = false;
    job.verifying = false;
    // Ручной повтор снова получает одну попытку восстановления входа.
    job.authRetry = 0;
    job.saveAttempt = 0;
    // При fileId повтор начнётся сразу с docs.save; старый file для этого
    // уже не нужен и был освобождён после передачи.
    if (!job.fileId) job.loaded = 0;
    if (!job.converted) {
      job.convertedFrame = 0;
      job.convertedTotal = 0;
    }
    diagLog({
      op: job.opId,
      stage: 'queue',
      attempt: 1,
      result: 'retry',
      category: 'ok',
      ext: job.ext,
      size: job.size,
    });
    updateUploadLifecycle();
    notify();
    pumpUploads();
  }

  function retryUpload(id) {
    const job = uploads.get(id);
    if (!job || !job.canRetry) return false;
    if (job.accountEpoch !== uploadEpoch) return false;

    // Перед повтором неоднозначного docs.save сначала проверяем, не сохранён
    // ли документ. Повтор docs.save без проверки мог бы создать дубликат.
    if (job.stage === 'unconfirmed') {
      if (job.verifying) return false;
      job.verifying = true;
      job.canRetry = false;
      job.note = 'Проверяем, сохранился ли файл…';
      updateUploadLifecycle();
      notify();
      (async () => {
        await delay(RETRY_DELAY);
        const result = await verifySavedUpload(job);
        if (!owned(job)) return;
        job.verifying = false;
        if (result.ok && result.found) {
          completeUploadSuccess(job, result.doc);
          return;
        }
        if (result.ok && !result.found) {
          queueUploadJob(job);
          return;
        }
        job.stage = 'unconfirmed';
        job.note = '';
        job.error = {
          kind: 'unconfirmed',
          message:
            'Не удалось проверить, сохранился ли файл. Проверь документы VK и повтори позже.',
        };
        job.canRetry = true;
        job.canDismiss = true;
        updateUploadLifecycle();
        notify();
      })().catch(() => {
        if (!owned(job)) return;
        job.verifying = false;
        job.note = '';
        job.canRetry = true;
        job.canDismiss = true;
        updateUploadLifecycle();
        notify();
      });
      return true;
    }

    queueUploadJob(job);
    return true;
  }

  function uploadOriginal(id) {
    const job = uploads.get(id);
    if (!job || !job.canUploadOriginal || !uploadTerminal(job)) return false;
    if (job.accountEpoch !== uploadEpoch) return false;
    if (job.originalExt !== 'mp4' || !job.file) return false;
    job.mp4Mode = 'original';
    job.converted = false;
    job.convertedFrame = 0;
    job.convertedTotal = 0;
    job.ext = 'mp4';
    job.name = job.originalName;
    job.mime = job.originalMime || 'video/mp4';
    job.size = job.originalSize;
    job.total = job.originalSize;
    job.loaded = 0;
    job.canUploadOriginal = false;
    queueUploadJob(job);
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
      auth: {
        status: auth.status,
        userId: auth.userId,
        expires: auth.expires,
        reason: auth.reason || '',
        source: auth.source || '',
      },
      uploads: uploadsState(),
      deletions: deletionsState(),
      uploadsPaused: uploadAuthHold && !expiredRecoveryPending
        ? { kind: 'auth', message: localAuthMessage(auth.reason), reason: auth.reason || '' }
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
    uploadOriginal,
    dismissUpload,
    deleteDocument,
    verifyDeletion,
    getDeletion,
    isDeleting,
    formats: FORMATS.slice(),
    mp4: MP4,
    diagnostics: {
      enabled: () => diag.enabled,
      setEnabled: setDiagnosticsEnabled,
      report: diagnosticsReport,
      clear: clearDiagnostics,
    },
  };
})();
