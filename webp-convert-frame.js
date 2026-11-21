// VK7TV — служебный iframe расширения для конвертера WebP -> GIF.
//
// iframe загружается с origin расширения, поэтому worker и gifenc не зависят
// от CSP страницы ВК. Канал с контент-скриптом — отдельный MessagePort:
// байты файла и результат не проходят через window страницы. При установке
// канала проверяются источник, точный origin страницы и одноразовый id.

(() => {
  const PARSER = self.VK7TV_WEBP_PARSE;
  const LIMITS = PARSER ? PARSER.LIMITS : { sourceBytes: 32 * 1024 * 1024, timeoutMs: 60000 };

  let job = null;

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
    if (current.worker) {
      try {
        current.worker.terminate();
      } catch (e) {
        // worker уже завершён
      }
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

    job = {
      id,
      origin: event.origin,
      port,
      worker: null,
      timer: 0,
    };

    port.onmessage = (e) => {
      const msg = e.data || {};
      if (!job || msg.jobId !== job.id) return;
      if (msg.type === 'cancel') {
        if (job.worker) {
          try {
            job.worker.postMessage({ type: 'cancel' });
          } catch (err) {
            // worker уже завершён
          }
        }
        cleanup();
      }
    };

    const buffer = data.data;
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) {
      fail('corrupt', 'Файл пустой или повреждён.');
      return;
    }
    if (buffer.byteLength > LIMITS.sourceBytes) {
      fail('limit');
      return;
    }

    let worker;
    try {
      worker = new Worker(new URL('webp-convert-worker.js', location.href), {
        type: 'module',
      });
    } catch (e) {
      fail('worker', 'Не удалось запустить преобразование WebP в GIF.');
      return;
    }
    job.worker = worker;

    worker.onmessage = (e) => {
      if (!job) return;
      const msg = e.data || {};
      if (msg.type === 'progress') {
        post('progress', { frame: msg.frame, total: msg.total });
      } else if (msg.type === 'done') {
        post('done', { bytes: msg.bytes }, [msg.bytes]);
        cleanup();
      } else if (msg.type === 'error') {
        fail(msg.kind || 'failed', msg.message);
      } else if (msg.type === 'canceled') {
        post('canceled', {});
        cleanup();
      }
    };
    worker.onerror = () => {
      fail('worker', 'Преобразование WebP в GIF аварийно завершилось.');
    };
    worker.onmessageerror = () => {
      fail('worker', 'Преобразование WebP в GIF аварийно завершилось.');
    };

    job.timer = setTimeout(() => {
      fail('timeout', 'Преобразование WebP в GIF заняло больше 60 секунд.');
    }, LIMITS.timeoutMs);

    try {
      worker.postMessage(
        { type: 'convert', data: buffer, fileSize: buffer.byteLength },
        [buffer]
      );
    } catch (e) {
      fail('worker', 'Не удалось передать файл конвертеру.');
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.__vk7tvWebp !== 1 || data.type !== 'init') return;
    start(data, event);
  });
})();
