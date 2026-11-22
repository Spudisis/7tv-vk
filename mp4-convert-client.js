// VK7TV — клиент конвертера MP4 -> GIF в контент-скрипте.
//
// Конвертер живёт в служебном iframe расширения: только оттуда можно
// запустить worker и встроенный видеодекодер, не завися от CSP страницы ВК.
// Байты передаются по MessageChannel внутри iframe, токен и API документов
// сюда не попадают.

(function () {
  if (window.VK7TV_MP4_CONVERT) return;

  const PARSER = window.VK7TV_MP4_PARSE;
  const LIMITS = PARSER
    ? PARSER.LIMITS
    : {
        sourceBytes: 32 * 1024 * 1024,
        gifBytes: 50 * 1024 * 1024,
        timeoutMs: 60000,
      };

  const active = new Set();

  function makeId() {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) {
      // старые браузеры без randomUUID
    }
    return (
      'v' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
    );
  }

  function error(kind, message) {
    const err = new Error(message || kind);
    err.kind = kind;
    return err;
  }

  function extensionOrigin() {
    try {
      return new URL(chrome.runtime.getURL('mp4-convert.html')).origin;
    } catch (e) {
      return '';
    }
  }

  function startConversion(options) {
    const request = options || {};
    const data = request.data;
    if (!(data instanceof ArrayBuffer) || !data.byteLength) {
      return {
        promise: Promise.reject(error('corrupt', 'Файл пустой или повреждён.')),
        cancel: () => {},
      };
    }
    if (data.byteLength > LIMITS.sourceBytes) {
      return {
        promise: Promise.reject(
          error(
            'limit',
            'Видео больше 32 МиБ — уменьшите файл или загрузите исходное видео.'
          )
        ),
        cancel: () => {},
      };
    }

    const id = makeId();
    let frame = null;
    let port = null;
    let timer = 0;
    let settled = false;
    let resolveResult;
    let rejectResult;

    const promise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    function cleanup() {
      clearTimeout(timer);
      timer = 0;
      active.delete(cancel);
      if (port) {
        try {
          port.close();
        } catch (e) {
          // порт уже закрыт
        }
        port = null;
      }
      if (frame) {
        try {
          frame.remove();
        } catch (e) {
          // iframe уже удалён
        }
        frame = null;
      }
    }

    function settle(ok, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (ok) resolveResult(value);
      else rejectResult(value);
    }

    function cancel(kind, message) {
      if (settled) return;
      if (port) {
        try {
          port.postMessage({
            type: 'cancel',
            jobId: id,
          });
        } catch (e) {
          // канал уже закрыт
        }
      }
      settle(false, error(kind || 'canceled', message || 'Преобразование отменено'));
    }

    function fail(kind, message) {
      settle(false, error(kind, message));
    }

    function onMessage(event) {
      const msg = event.data || {};
      if (msg.jobId !== id) return;
      if (msg.type === 'progress') {
        if (typeof request.onProgress === 'function') {
          try {
            request.onProgress({
              frame: Number(msg.frame) || 0,
              total: Number(msg.total) || 0,
            });
          } catch (e) {
            // ошибка обработчика прогресса не должна ломать конвертацию
          }
        }
        return;
      }
      if (msg.type === 'done') {
        const bytes = msg.bytes;
        if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength) {
          fail('failed', 'Конвертер вернул пустой GIF.');
          return;
        }
        if (bytes.byteLength > LIMITS.gifBytes) {
          fail('gif-size', 'Получившийся GIF больше 50 МиБ.');
          return;
        }
        settle(true, bytes);
        return;
      }
      if (msg.type === 'error') {
        fail(msg.kind || 'failed', msg.message);
        return;
      }
      if (msg.type === 'canceled') {
        settle(false, error('canceled', 'Преобразование отменено'));
      }
    }

    function onLoad() {
      if (settled || !frame) return;
      const origin = extensionOrigin();
      if (!origin) {
        fail('worker', 'Не удалось открыть служебный iframe расширения.');
        return;
      }
      let channel;
      try {
        channel = new MessageChannel();
      } catch (e) {
        fail('worker', 'Не удалось открыть канал конвертера.');
        return;
      }
      port = channel.port1;
      port.onmessage = onMessage;
      try {
        frame.contentWindow.postMessage(
          {
            __vk7tvMp4: 1,
            type: 'init',
            jobId: id,
            parentOrigin: location.origin,
            data,
          },
          origin,
          [channel.port2, data]
        );
      } catch (e) {
        fail('worker', 'Не удалось передать файл конвертеру.');
      }
    }

    active.add(cancel);

    try {
      frame = document.createElement('iframe');
      frame.className = 'vk7tv-mp4-convert-frame';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
      frame.src = chrome.runtime.getURL('mp4-convert.html');
      frame.addEventListener('load', onLoad, { once: true });
      frame.addEventListener(
        'error',
        () => fail('worker', 'Не удалось загрузить служебный iframe расширения.'),
        { once: true }
      );
      (document.documentElement || document.body).appendChild(frame);
    } catch (e) {
      fail('worker', 'Не удалось создать служебный iframe расширения.');
    }

    timer = setTimeout(() => {
      cancel('timeout', 'Преобразование видео в GIF заняло больше 60 секунд.');
    }, LIMITS.timeoutMs);

    return { promise, cancel };
  }

  // Закрытие страницы не оставляет worker и канал висеть.
  try {
    window.addEventListener('pagehide', () => {
      for (const cancel of [...active]) {
        try {
          cancel('canceled', 'Страница закрывается');
        } catch (e) {
          // ничего не осталось
        }
      }
    });
  } catch (e) {
    // событие недоступно — worker всё равно завершится вместе со страницей
  }

  window.VK7TV_MP4_CONVERT = { startConversion, LIMITS };
})();
