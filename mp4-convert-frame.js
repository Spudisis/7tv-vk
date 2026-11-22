// VK7TV — iframe конвертера MP4 -> GIF.
//
// Исходник приходит по отдельному MessagePort из контент-скрипта. Здесь он
// превращается в Blob URL, кадры извлекает встроенный декодер браузера:
// приостановленный <video> последовательно перематывается по времени,
// готовый кадр рисуется в canvas и уходит в worker RGBA-пикселями.
// Токены VK и API документов в iframe не передаются.
//
// Worker получает по одному кадру и подтверждает обработку. Так память
// ограничена одним уменьшенным кадром, а не всем роликом.

(() => {
  const PARSER = self.VK7TV_MP4_PARSE;
  const LIMITS = PARSER
    ? PARSER.LIMITS
    : {
        sourceBytes: 32 * 1024 * 1024,
        framePixels: 4 * 1000 * 1000,
        gifBytes: 50 * 1024 * 1024,
        timeoutMs: 60000,
        durationMs: 15000,
        fps: 15,
        maxSide: 480,
      };

  let job = null;

  // Адрес worker'а считаем от самого скрипта, а не от location: iframe
  // лежит в корне расширения, а стенды могут подключать модуль из tests/.
  const WORKER_URL = (() => {
    try {
      const src = document.currentScript && document.currentScript.src;
      if (src) return new URL('mp4-convert-worker.js', src);
    } catch (e) {
      // currentScript недоступен — возьмём адрес страницы
    }
    return new URL('mp4-convert-worker.js', location.href);
  })();

  function error(kind, message) {
    const err = new Error(message || kind);
    err.kind = kind;
    return err;
  }

  function canceledError() {
    return error('canceled', 'Преобразование отменено');
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw canceledError();
  }

  function remaining(deadline) {
    return Math.max(1, deadline - Date.now());
  }

  function resolveLimits(options) {
    const custom = options && options.limits;
    return custom ? Object.assign({}, LIMITS, custom) : LIMITS;
  }

  function vkOrigin(origin) {
    try {
      const u = new URL(origin);
      if (u.protocol !== 'https:' || u.username || u.password) return false;
      const host = u.hostname;
      return (
        host === 'vk.com' ||
        host.endsWith('.vk.com') ||
        host === 'vk.ru' ||
        host.endsWith('.vk.ru') ||
        host === 'vk.me' ||
        host.endsWith('.vk.me')
      );
    } catch (e) {
      return false;
    }
  }

  function toBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (input && input.buffer instanceof ArrayBuffer) return input.buffer;
    throw error('corrupt', 'Файл пустой или повреждён.');
  }

  function targetSize(width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function waitMetadata(source, signal) {
    const video = source.video;
    if (video.readyState >= 1 && video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        done(error('timeout', 'Браузер не загрузил метаданные видео вовремя.'));
      }, remaining(source.deadline));

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', ok);
        video.removeEventListener('loadeddata', ok);
        video.removeEventListener('error', bad);
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      function done(err) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      }

      function ok() {
        done(null);
      }

      function bad() {
        const code = video.error && video.error.code;
        if (code === 4) {
          done(
            error(
              'unsupported',
              'Браузер не может прочитать это видео: кодек или защита не поддерживаются. Загрузите исходное видео.'
            )
          );
        } else {
          done(
            error(
              'decode',
              'Браузер не смог прочитать видео. Загрузите исходное видео.'
            )
          );
        }
      }

      function onAbort() {
        done(canceledError());
      }

      video.addEventListener('loadedmetadata', ok);
      video.addEventListener('loadeddata', ok);
      video.addEventListener('error', bad);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function waitDrawable(source, signal) {
    const video = source.video;
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        done(error('timeout', 'Браузер не подготовил первый кадр видео вовремя.'));
      }, remaining(source.deadline));

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', ok);
        video.removeEventListener('canplay', ok);
        video.removeEventListener('error', bad);
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      function done(err) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      }

      function ok() {
        done(null);
      }

      function bad() {
        done(error('decode', 'Браузер не смог подготовить кадры видео.'));
      }

      function onAbort() {
        done(canceledError());
      }

      video.addEventListener('loadeddata', ok);
      video.addEventListener('canplay', ok);
      video.addEventListener('error', bad);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function makeCanvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: true,
      });
      if (ctx) return { canvas, ctx };
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    if (!ctx) throw error('decode', 'Браузер не дал canvas для кадров видео.');
    return { canvas, ctx };
  }

  // Открывает видео, проверяет контейнер и метаданные и готовит canvas.
  // Видео остаётся приостановленным: кадры выбираются перемоткой.
  async function openVideo(input, options) {
    const opts = options || {};
    const limits = resolveLimits(opts);
    const signal = opts.signal;
    const buffer = toBuffer(input);
    if (!buffer.byteLength) throw error('corrupt', 'Файл пустой или повреждён.');
    if (buffer.byteLength > limits.sourceBytes) {
      throw error(
        'limit',
        'Видео больше 32 МиБ — уменьшите файл или загрузите исходное видео.'
      );
    }
    if (!PARSER) {
      throw error('worker', 'Не удалось проверить контейнер видео.');
    }

    let info;
    try {
      info = PARSER.parse(new Uint8Array(buffer));
    } catch (e) {
      if (e && e.code === 'limit') {
        throw error('limit', 'Видео не подходит по размеру для преобразования в GIF.');
      }
      throw error('corrupt', 'Файл повреждён или его содержимое не совпадает с расширением.');
    }
    if (!info.hasVideo) {
      throw error(
        'no-video',
        'В MP4 нет видеодорожки — браузер не может преобразовать его в GIF. Загрузите исходное видео.'
      );
    }
    if (info.encrypted) {
      throw error(
        'unsupported',
        'Защищённое видео нельзя преобразовать в GIF. Загрузите исходное видео.'
      );
    }

    const deadline = Date.now() + limits.timeoutMs;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';

    let url = '';
    try {
      url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
    } catch (e) {
      throw error('decode', 'Браузер не смог открыть видео.');
    }

    const source = {
      video,
      url,
      deadline,
      limits,
      width: 0,
      height: 0,
      total: 0,
      durationMs: 0,
      canvas: null,
      ctx: null,
      cleaned: false,
    };

    function cleanup() {
      if (source.cleaned) return;
      source.cleaned = true;
      try {
        video.pause();
      } catch (e) {
        // видео уже остановлено
      }
      try {
        video.removeAttribute('src');
        video.load();
      } catch (e) {
        // видео уже освобождено
      }
      try {
        video.remove();
      } catch (e) {
        // элемента уже нет в документе
      }
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          // URL уже отозван
        }
        url = '';
      }
      if (source.canvas) {
        try {
          source.canvas.width = 0;
          source.canvas.height = 0;
        } catch (e) {
          // canvas уже освобождён
        }
      }
      source.video = null;
      source.ctx = null;
      source.canvas = null;
    }
    source.cleanup = cleanup;

    try {
      (opts.container || document.body || document.documentElement).appendChild(video);
      video.src = url;
      await waitMetadata(source, signal);
      throwIfAborted(signal);
      await waitDrawable(source, signal);
      throwIfAborted(signal);

      const durationSec = Number(video.duration);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw error(
          'duration',
          'Длительность видео неизвестна — браузер не может преобразовать его в GIF.'
        );
      }
      const durationMs = durationSec * 1000;
      // Допуск только на погрешность float: ровно 15 секунд принимаем,
      // большее значение — отклоняем без автоматической обрезки.
      if (durationMs > limits.durationMs + 0.001) {
        throw error(
          'duration',
          'Видео длиннее 15 секунд. Обрежьте его заранее или загрузите исходное видео.'
        );
      }

      const width = Math.floor(Number(video.videoWidth) || 0);
      const height = Math.floor(Number(video.videoHeight) || 0);
      if (!width || !height) {
        throw error(
          'no-video',
          'В MP4 нет видеодорожки — браузер не может преобразовать его в GIF. Загрузите исходное видео.'
        );
      }
      if (width * height > limits.framePixels) {
        throw error(
          'limit',
          'Кадр видео больше 4 млн пикселей — уменьшите разрешение или загрузите исходное видео.'
        );
      }

      const target = targetSize(width, height, limits.maxSide);
      const { canvas, ctx } = makeCanvas(target.width, target.height);
      source.canvas = canvas;
      source.ctx = ctx;
      source.width = target.width;
      source.height = target.height;
      source.durationMs = durationMs;
      source.fps = Number(limits.fps) || 15;
      source.total = Math.max(
        1,
        Math.ceil(
          Number(((durationMs * source.fps) / 1000).toFixed(6))
        )
      );
      return source;
    } catch (e) {
      cleanup();
      if (e && e.kind) throw e;
      throw error('decode', 'Браузер не смог открыть видео.');
    }
  }

  function seek(source, timeSec, signal) {
    const video = source.video;
    if (!video) throw canceledError();
    const durationSec = source.durationMs / 1000;
    const target = Math.max(0, Math.min(timeSec, Math.max(0, durationSec - 0.0005)));
    if (Math.abs(video.currentTime - target) <= 0.001 && video.readyState >= 2) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        done(error('timeout', 'Браузер не успел перемотать видео.'));
      }, Math.min(10000, remaining(source.deadline)));

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('seeked', ok);
        video.removeEventListener('error', bad);
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      function done(err) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      }

      function ok() {
        done(null);
      }

      function bad() {
        done(error('decode', 'Браузер не смог перемотать видео.'));
      }

      function onAbort() {
        done(canceledError());
      }

      video.addEventListener('seeked', ok, { once: true });
      video.addEventListener('error', bad, { once: true });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        video.currentTime = target;
      } catch (e) {
        done(error('decode', 'Браузер не смог перемотать видео.'));
      }
    });
  }

  function readFrame(source) {
    if (source.cleaned || !source.ctx || !source.video) throw canceledError();
    try {
      source.ctx.drawImage(
        source.video,
        0,
        0,
        source.width,
        source.height
      );
      return source.ctx.getImageData(0, 0, source.width, source.height);
    } catch (e) {
      throw error('decode', 'Не удалось извлечь кадр видео.');
    }
  }

  function encodeSource(source, options) {
    const opts = options || {};
    const signal = opts.signal;
    const limits = source.limits;

    return new Promise((resolve, reject) => {
      if (!source.total) {
        reject(error('failed', 'Нечего кодировать.'));
        return;
      }
      let worker;
      try {
        worker = new Worker(
          opts.workerUrl || WORKER_URL,
          { type: 'module' }
        );
      } catch (e) {
        reject(error('worker', 'Не удалось запустить кодировщик GIF.'));
        return;
      }

      let settled = false;
      let waiter = null;
      let fatal = null;

      function settle(ok, value) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          worker.terminate();
        } catch (e) {
          // worker уже завершён
        }
        if (ok) resolve(value);
        else reject(value);
      }

      function settleWaiter(ok, value) {
        const current = waiter;
        waiter = null;
        if (!current) return;
        if (ok) current.resolve(value);
        else current.reject(value);
      }

      function fail(err) {
        fatal = err;
        if (waiter) settleWaiter(false, err);
        settle(false, err);
      }

      function onAbort() {
        fail(canceledError());
      }

      function request(type, message, transfer) {
        if (fatal) return Promise.reject(fatal);
        if (signal && signal.aborted) return Promise.reject(canceledError());
        return new Promise((res, rej) => {
          waiter = { type, resolve: res, reject: rej };
          try {
            worker.postMessage(message, transfer || []);
          } catch (e) {
            const err = error('worker', 'Не удалось передать кадр кодировщику GIF.');
            waiter = null;
            fail(err);
            rej(err);
          }
        });
      }

      worker.onmessage = (event) => {
        if (settled) return;
        const msg = event.data || {};
        if (msg.type === 'ready') {
          settleWaiter(true, msg);
          return;
        }
        if (msg.type === 'ack') {
          settleWaiter(true, msg);
          return;
        }
        if (msg.type === 'done') {
          settleWaiter(true, msg);
          return;
        }
        if (msg.type === 'error') {
          const err = error(msg.kind || 'failed', msg.message);
          fatal = err;
          if (waiter) settleWaiter(false, err);
          else fail(err);
        }
      };
      worker.onerror = () => {
        fail(error('worker', 'Кодировщик GIF аварийно завершился.'));
      };
      worker.onmessageerror = () => {
        fail(error('worker', 'Кодировщик GIF аварийно завершился.'));
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      (async () => {
        try {
          if (Date.now() >= source.deadline) {
            throw error('timeout', 'Преобразование видео в GIF заняло больше 60 секунд.');
          }
          await request(
            'start',
            {
              type: 'start',
              width: source.width,
              height: source.height,
              total: source.total,
              durationMs: source.durationMs,
              fps: source.fps,
            },
            []
          );
          if (typeof opts.onMeta === 'function') {
            try {
              opts.onMeta({
                frame: 0,
                total: source.total,
                width: source.width,
                height: source.height,
              });
            } catch (e) {
              // ошибка обработчика не должна ломать конвертацию
            }
          }

          for (let i = 0; i < source.total; i++) {
            throwIfAborted(signal);
            if (Date.now() > source.deadline) {
              throw error(
                'timeout',
                'Преобразование видео в GIF заняло больше 60 секунд.'
              );
            }
            const time = Math.min(
              i / source.fps,
              Math.max(0, source.durationMs / 1000 - 0.0005)
            );
            await seek(source, time, signal);
            throwIfAborted(signal);
            const image = readFrame(source);
            const pixels = image.data.buffer;
            await request(
              'frame',
              {
                type: 'frame',
                index: i,
                data: pixels,
                width: source.width,
                height: source.height,
              },
              [pixels]
            );
            throwIfAborted(signal);
            if (typeof opts.onProgress === 'function') {
              try {
                opts.onProgress({
                  frame: i + 1,
                  total: source.total,
                });
              } catch (e) {
                // ошибка обработчика прогресса не должна ломать конвертацию
              }
            }
          }

          throwIfAborted(signal);
          const done = await request('finish', { type: 'finish' });
          const bytes = done && done.bytes;
          if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength) {
            throw error('failed', 'Кодировщик вернул пустой GIF.');
          }
          if (bytes.byteLength > limits.gifBytes) {
            throw error('gif-size', 'Получившийся GIF больше 50 МиБ.');
          }
          settle(true, {
            bytes: new Uint8Array(bytes),
            width: source.width,
            height: source.height,
            total: source.total,
            durationMs: source.durationMs,
          });
        } catch (e) {
          if (settled) return;
          if (e && e.kind) fail(e);
          else fail(error('failed', 'Не удалось преобразовать видео в GIF.'));
        }
      })();
    });
  }

  async function convertBuffer(input, options) {
    const source = await openVideo(input, options);
    try {
      return await encodeSource(source, options);
    } finally {
      source.cleanup();
    }
  }

  // --- канал с контент-скриптом ---

  function post(type, payload, transfer) {
    if (!job) return;
    try {
      job.port.postMessage(
        Object.assign({ type, jobId: job.id }, payload || {}),
        transfer || []
      );
    } catch (e) {
      // канал уже закрыт
    }
  }

  function cleanup() {
    if (!job) return;
    const current = job;
    job = null;
    clearTimeout(current.timer);
    try {
      current.controller.abort();
    } catch (e) {
      // контроллер уже завершён
    }
    // Сообщение уже поставлено в очередь порта; закрываем следующий тик,
    // чтобы оно успело уйти до отключения.
    const port = current.port;
    setTimeout(() => {
      try {
        port.close();
      } catch (e) {
        // порт уже закрыт
      }
    }, 0);
  }

  function fail(kind, message) {
    post('error', { kind, message: message || kind });
    cleanup();
  }

  function start(data, event) {
    const id = data.jobId;
    if (typeof id !== 'string' || id.length < 8 || id.length > 80) return;
    if (data.parentOrigin !== event.origin || !vkOrigin(event.origin)) return;
    if (job) return; // один iframe — одно задание
    const port = event.ports && event.ports[0];
    if (!port) return;

    const buffer = data.data;
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) {
      job = { id, port, timer: 0, controller: null };
      fail('corrupt', 'Файл пустой или повреждён.');
      return;
    }

    const controller = new AbortController();
    job = { id, port, timer: 0, controller };

    port.onmessage = (e) => {
      const msg = e.data || {};
      if (!job || msg.jobId !== job.id) return;
      if (msg.type === 'cancel') {
        cleanup();
      }
    };

    job.timer = setTimeout(() => {
      fail('timeout', 'Преобразование видео в GIF заняло больше 60 секунд.');
    }, LIMITS.timeoutMs);

    convertBuffer(buffer, {
      signal: controller.signal,
      onMeta: (progress) => post('progress', progress),
      onProgress: (progress) => post('progress', progress),
    })
      .then((result) => {
        post('done', { bytes: result.bytes.buffer }, [result.bytes.buffer]);
        cleanup();
      })
      .catch((e) => {
        if (!job) return;
        if (e && e.kind === 'canceled') {
          cleanup();
          return;
        }
        fail(
          (e && e.kind) || 'failed',
          (e && e.message) || 'Не удалось преобразовать видео в GIF.'
        );
      });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.__vk7tvMp4 !== 1 || data.type !== 'init') return;
    start(data, event);
  });

  try {
    window.addEventListener('pagehide', () => {
      if (job) cleanup();
    });
  } catch (e) {
    // событие недоступно — iframe всё равно выгрузится
  }

  // Небольшая поверхность для стендов: тот же путь открытия видео и
  // кодирования, что и у кнопки загрузки, без канала с контент-скриптом.
  self.VK7TV_MP4_FRAME = {
    LIMITS,
    openVideo,
    encodeSource,
    convertBuffer,
    targetSize,
  };
})();
