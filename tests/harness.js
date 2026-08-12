// Обвязка для стендов: заглушка chrome.* и проверки.
//
// Стенды гоняются в headless Chrome через run-tests.sh. Скрипты расширения
// подключаются к странице как есть, поэтому им нужен chrome.storage
// и chrome.runtime — их и подменяем. Отчёт стенд печатает в #result,
// run-tests.sh читает его из --dump-dom.

window.VK7TV_TEST = (() => {
  const checks = [];
  let done = null;

  // Заглушка хранилища. Формы аргументов те же, что у настоящего API:
  // объект с значениями по умолчанию, массив ключей, строка, null.
  function makeArea(store) {
    const pick = (keys) => {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
      return Object.fromEntries(
        Object.entries(keys).map(([k, d]) => [k, k in store ? store[k] : d])
      );
    };
    return {
      store,
      get: (keys) => Promise.resolve(pick(keys)),
      set: (obj) => {
        Object.assign(store, obj);
        for (const fn of listeners) {
          fn(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { newValue: v }])), area);
        }
        return Promise.resolve();
      },
    };
  }

  const listeners = [];
  let area = 'sync';

  // Картинка нужного размера, которая точно загрузится: сеть в стендах
  // не участвует, иначе прогон зависел бы от доступности cdn.7tv.app.
  const svg = (w, h, fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="100%" height="100%" fill="${fill || 'rgb(76,139,245)'}"/></svg>`;

  const png = (w, h, fill) => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg(w, h, fill));

  // То же, но base64: именно такой data:-URL отдаёт фоновый скрипт, и на нём
  // проверяется настоящий путь «фон -> base64 -> blob», а не запасной.
  const pngB64 = (w, h, fill) => 'data:image/svg+xml;base64,' + btoa(svg(w, h, fill));

  function install({ sync = {}, local = {}, respond, id = 'testextensionid' } = {}) {
    const syncArea = makeArea(sync);
    const localArea = makeArea(local);
    window.chrome = {
      storage: {
        sync: {
          get: (k) => ((area = 'sync'), syncArea.get(k)),
          set: (o) => ((area = 'sync'), syncArea.set(o)),
        },
        local: {
          get: (k) => ((area = 'local'), localArea.get(k)),
          set: (o) => ((area = 'local'), localArea.set(o)),
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
      runtime: {
        id,
        getManifest: () => ({ version: 'test' }),
        // respond(msg) -> ответ, или Promise, или undefined (фон молчит)
        sendMessage: (msg, cb) => {
          const r = respond ? respond(msg) : null;
          if (r && typeof r.then === 'function') r.then((v) => cb && cb(v));
          else if (r !== undefined && cb) cb(r);
        },
      },
    };
    return { sync: syncArea.store, local: localArea.store };
  }

  const check = (name, ok, got) => checks.push({ name, ok: !!ok, got: String(got) });
  const eq = (name, got, want) => check(name, got === want, `${got} (ждали ${want})`);

  // Стенды асинхронные: ждём условие, а не «достаточно большой» таймаут —
  // иначе прогон то падает, то проходит.
  //
  // Опрашиваем через setTimeout, а не requestAnimationFrame: в headless
  // Chrome с --virtual-time-budget кадры кому-то не приходят вовсе, и стенд
  // молча зависал, не доходя до отчёта. Таймеры виртуальное время
  // прокручивает честно.
  function waitFor(what, fn, ms = 3000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (fn()) return resolve(true);
        if (Date.now() - t0 > ms) {
          check(what, false, 'не дождались');
          return resolve(false);
        }
        setTimeout(tick, 16);
      };
      tick();
    });
  }

  const errors = [];
  window.onerror = (msg, src, line) => {
    errors.push(`${msg} @ ${String(src).split('/').pop()}:${line}`);
  };
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    errors.push('REJECT: ' + ((r && r.stack) || r));
  });

  function report() {
    if (done) return;
    done = true;
    check('без исключений на странице', !errors.length, errors.join(' | ') || 'нет');
    const failed = checks.filter((c) => !c.ok);
    // Отчёт кладём в textarea: в обычном узле контент-скрипт заменил бы имена
    // эмоутов из отчёта на картинки, и JSON стал бы неразбираемым. В textarea
    // подмена не заходит (см. renderable в content.js).
    const box = document.createElement('textarea');
    box.id = 'result';
    // именно textContent: значение, выставленное через .value, в разметку
    // не попадает, и --dump-dom отдал бы пустую textarea
    box.textContent =
      'RESULT ' +
      JSON.stringify({
        page: location.pathname.split('/').pop(),
        total: checks.length,
        failed: failed.length,
        lines: checks.map((c) => (c.ok ? '  ok  ' : '  FAIL') + ' ' + c.name + ' — ' + c.got),
      });
    document.body.appendChild(box);
  }

  // Тело стенда гоняем здесь: упавшая проверка не должна лишать отчёта —
  // иначе в прогоне видно только «стенд не дошёл до отчёта».
  async function run(fn) {
    try {
      await fn();
    } catch (e) {
      check('стенд доработал до конца', false, (e && e.stack ? e.stack.split('\n')[0] : e));
    }
    report();
  }

  return { install, check, eq, waitFor, report, run, png, pngB64 };
})();
