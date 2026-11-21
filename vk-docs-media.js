// VK7TV — кэш анимаций документов в памяти вкладки.
//
// Отдельно от пикера и от API документов: сюда приходят только готовые
// источники (видео-превью GIF, оригинал GIF или WEBP) и аккаунт, которому
// они принадлежат. Кэш живёт до закрытия вкладки, переживает поиск,
// сворачивание и повторное открытие панели.
//
// Если CORS и CSP разрешают, байты забираются через fetch и живут в Blob:
// так повторное наведение не ходит в сеть. Если fetch запрещён, остаётся
// прямой URL — браузер может взять его из своего HTTP-кэша, но после
// удаления элемента это уже не гарантируется.

(() => {
  if (window.VK7TV_DOCS_MEDIA) return;

  // Два одновременных fetch: больше — заметная конкуренция за канал при
  // движении курсора по сетке, меньше — загрузка становится заметно медленнее.
  const MAX_ACTIVE_LOADS = 2;
  // 64 записи ограничивают и число декодированных прямых медиа, размер
  // которых браузер не сообщает.
  const MAX_RECORDS = 64;
  // 96 MiB — потолок именно для Blob-байтов; прямые медиа считаются только
  // записями, потому что их декодированный размер неизвестен.
  const MAX_BLOB_BYTES = 96 * 1024 * 1024;
  const ERROR_RETRY_MS = 30000;

  const records = new Map();
  const queue = [];
  let activeLoads = 0;
  let blobBytes = 0;

  const now = () => Date.now();

  function sourceSize(source) {
    const n = Number(source && source.size);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function makeKey(account, doc, source) {
    return `${account}|${doc.ownerId}:${doc.id}|${source.kind}|${source.url}`;
  }

  function docKeyOf(doc) {
    return `${doc.ownerId}:${doc.id}`;
  }

  function revoke(rec) {
    if (!rec || !rec.blob || !rec.url) return;
    try {
      URL.revokeObjectURL(rec.url);
    } catch (e) {
      // уже освобождён
    }
    blobBytes = Math.max(0, blobBytes - (rec.blobSize || 0));
    rec.blob = false;
    rec.blobSize = 0;
  }

  function drop(rec) {
    if (!rec) return;
    revoke(rec);
    records.delete(rec.key);
  }

  function prune() {
    if (records.size <= MAX_RECORDS && blobBytes <= MAX_BLOB_BYTES) return;
    const candidates = [...records.values()]
      .filter((r) => r.active === 0 && r.state !== 'loading')
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const rec of candidates) {
      if (records.size <= MAX_RECORDS && blobBytes <= MAX_BLOB_BYTES) break;
      drop(rec);
    }
  }

  function useDirect(rec) {
    revoke(rec);
    rec.url = rec.sourceUrl;
  }

  async function download(rec) {
    if (!records.has(rec.key)) return;
    const expected = sourceSize(rec);
    if (expected > MAX_BLOB_BYTES || blobBytes + expected > MAX_BLOB_BYTES) {
      // Файл всё равно можно показать в активной карточке, но в кэше
      // он не удерживается.
      useDirect(rec);
      rec.transient = true;
      return;
    }

    let res;
    try {
      res = await fetch(rec.sourceUrl, {
        credentials: 'omit',
        mode: 'cors',
        cache: 'force-cache',
      });
    } catch (e) {
      useDirect(rec);
      return;
    }

    if (!res || !res.ok) {
      useDirect(rec);
      return;
    }
    if (!records.has(rec.key)) return;

    const length = Number(res.headers && res.headers.get('content-length')) || 0;
    if (length > MAX_BLOB_BYTES || (length && blobBytes + length > MAX_BLOB_BYTES)) {
      useDirect(rec);
      rec.transient = true;
      return;
    }

    let blob;
    try {
      blob = await res.blob();
    } catch (e) {
      useDirect(rec);
      return;
    }
    if (!blob || !blob.size) {
      useDirect(rec);
      return;
    }
    if (!records.has(rec.key)) return;
    if (blob.size > MAX_BLOB_BYTES || blobBytes + blob.size > MAX_BLOB_BYTES) {
      useDirect(rec);
      rec.transient = true;
      return;
    }

    useDirect(rec);
    rec.blob = true;
    rec.blobSize = blob.size;
    rec.url = URL.createObjectURL(blob);
    rec.blobType = blob.type || '';
    blobBytes += blob.size;
  }

  function enqueue(rec) {
    return new Promise((resolve, reject) => {
      queue.push({ rec, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (activeLoads < MAX_ACTIVE_LOADS && queue.length) {
      const job = queue.shift();
      activeLoads++;
      download(job.rec)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeLoads--;
          pump();
        });
    }
  }

  function startLoad(rec) {
    rec.state = 'loading';
    rec.retryAt = 0;
    const promise = enqueue(rec)
      .then(() => {
        rec.state = 'ready';
        rec.lastUsed = now();
        prune();
        return rec;
      })
      .catch((e) => {
        if (e && e.canceled) {
          rec.state = 'idle';
          rec.promise = null;
          throw e;
        }
        rec.state = 'error';
        rec.retryAt = now() + ERROR_RETRY_MS;
        rec.promise = null;
        useDirect(rec);
        prune();
        throw e;
      });
    rec.promise = promise;
    return promise;
  }

  function createRecord(account, doc, source) {
    return {
      key: makeKey(account, doc, source),
      account,
      docKey: docKeyOf(doc),
      kind: source.kind,
      sourceUrl: source.url,
      url: '',
      blob: false,
      blobSize: 0,
      blobType: '',
      state: 'idle',
      retryAt: 0,
      promise: null,
      active: 0,
      lastUsed: now(),
      stale: false,
      transient: false,
    };
  }

  function acquire(account, doc, source) {
    if (!source || !source.url) {
      return { key: '', record: null, promise: Promise.reject(new Error('no-source')) };
    }

    const key = makeKey(account, doc, source);
    let rec = records.get(key);

    if (rec && rec.state === 'error' && rec.retryAt > now()) {
      return { key, record: rec, promise: Promise.resolve(rec) };
    }
    if (rec && rec.state === 'error') {
      rec.state = 'idle';
      rec.retryAt = 0;
      rec.promise = null;
    }
    if (!rec) {
      rec = createRecord(account, doc, source);
      rec.expectedSize = sourceSize(source);
      records.set(key, rec);
    }

    rec.active++;
    rec.lastUsed = now();
    if (!rec.promise) startLoad(rec);
    return { key, record: rec, promise: rec.promise };
  }

  function peek(account, doc, source) {
    if (!source || !source.url) return null;
    return records.get(makeKey(account, doc, source)) || null;
  }

  function release(key) {
    if (!key) return;
    const rec = records.get(key);
    if (!rec) return;
    rec.active = Math.max(0, rec.active - 1);
    rec.lastUsed = now();
    if ((rec.stale || rec.transient) && rec.active === 0) drop(rec);
    else prune();
  }

  function markError(key) {
    const rec = records.get(key);
    if (!rec) return;
    rec.state = 'error';
    rec.retryAt = now() + ERROR_RETRY_MS;
    rec.promise = null;
    useDirect(rec);
    prune();
  }

  function retainDocs(account, docs) {
    const valid = new Map();
    for (const doc of docs) {
      const urls = new Set();
      if (doc.url) urls.add(doc.url);
      if (doc.video && doc.video.url) urls.add(doc.video.url);
      valid.set(docKeyOf(doc), urls);
    }
    for (const rec of [...records.values()]) {
      if (rec.account !== account) continue;
      const urls = valid.get(rec.docKey);
      if (urls && urls.has(rec.sourceUrl)) continue;
      rec.stale = true;
      if (rec.active === 0) drop(rec);
    }
  }

  function cancelPending() {
    for (const job of queue.splice(0)) {
      const rec = job.rec;
      rec.state = 'idle';
      rec.promise = null;
      const err = new Error('canceled');
      err.canceled = true;
      job.reject(err);
    }
  }

  function clear() {
    cancelPending();
    for (const rec of [...records.values()]) drop(rec);
    blobBytes = 0;
  }

  function stats() {
    return {
      records: records.size,
      blobBytes,
      activeLoads,
      queued: queue.length,
      maxRecords: MAX_RECORDS,
      maxBlobBytes: MAX_BLOB_BYTES,
    };
  }

  window.VK7TV_DOCS_MEDIA = {
    acquire,
    peek,
    release,
    markError,
    retainDocs,
    cancelPending,
    clear,
    stats,
    ERROR_RETRY_MS,
  };
})();
