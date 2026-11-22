// Интеграционный прогон в установленном MV3-расширении.
//
// Стенд обычного браузера не проверяет то, что важно именно расширению:
// web_accessible_resources для iframe, CSP страницы ВК и worker в
// chrome-extension://. Здесь Chrome запускается с --load-extension, страница
// отдаётся по адресу vk.com через host-resolver, а запросы API и загрузки
// перехватываются CDP Fetch. Скрипт не входит в обычный run.mjs: ему нужен
// Chrome, который ещё принимает --load-extension.
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'vk7tv-ext-'));
const certDir = await mkdtemp(join(tmpdir(), 'vk7tv-cert-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// vk.com в HSTS: http браузер сам поднимает до https, поэтому локальный
// сервер тоже https, а сертификат для стенда игнорируется ключом Chrome.
execFileSync(
  process.env.OPENSSL || 'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(certDir, 'key.pem'),
    '-out',
    join(certDir, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=vk.com',
    '-addext',
    'subjectAltName=DNS:vk.com,DNS:*.vk.com',
  ],
  { stdio: 'ignore' }
);
const tls = {
  key: await readFile(join(certDir, 'key.pem')),
  cert: await readFile(join(certDir, 'cert.pem')),
};

const docs = [
  {
    owner_id: 42,
    id: 1,
    title: 'integration.png',
    ext: 'png',
    type: 4,
    size: 10,
    date: 1,
    url: 'https://vk.ru/doc42_1',
    preview: {
      photo: {
        sizes: [{ type: 's', src: 'https://vk.ru/s.png', width: 64, height: 64 }],
      },
    },
  },
];
const savedTitles = [];
const deleteRequests = [];
let saveCount = 0;

const server = createHttpsServer(tls, async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(resolve(root) + sep)) throw new Error('path');
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    };
    res.setHeader('Content-Type', (types[extname(path)] || 'application/octet-stream') + '; charset=utf-8');
    if (path.endsWith('extension-integration.html')) {
      // Страница ВК тоже присылает CSP. Worker и iframe расширения должны
      // её не замечать: они живут на chrome-extension://.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
          "connect-src 'self' https://web.api.vk.ru https://login.vk.ru; img-src 'self' data:; " +
          "frame-src 'none'; worker-src 'none'; object-src 'none'"
      );
    }
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let chrome;
let ws;
let failed = false;
try {
  chrome = spawn(
    process.env.CHROME || 'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-web-security',
      '--ignore-certificate-errors',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--host-resolver-rules=MAP vk.com:443 127.0.0.1:' + port,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error('Chrome startup timed out: ' + stderr.slice(-1000))),
      15000
    );
    chrome.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    chrome.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Chrome exited: ' + code + ' ' + stderr.slice(-1000)));
    });
    chrome.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolveEndpoint(match[1]);
      }
    });
  });

  ws = new WebSocket(endpoint);
  await new Promise((r, reject) => {
    ws.onopen = r;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  const call = (method, params = {}, sessionId) =>
    new Promise((resolveCall, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 10000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  ws.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const url = request.url;
      const headers = [
        { name: 'Content-Type', value: 'application/json; charset=utf-8' },
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Cache-Control', value: 'no-store' },
      ];
      const fulfill = (json) =>
        call(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: 200,
            responseHeaders: headers,
            body: Buffer.from(JSON.stringify(json)).toString('base64'),
          },
          message.sessionId
        );
      try {
        if (url.startsWith('https://web.api.vk.ru/method/')) {
          const method = new URL(url).pathname.split('/').pop();
          const body = new URLSearchParams(request.postData || '');
          if (method === 'docs.get') {
            await fulfill({
              response: { count: docs.length, total_count: docs.length, items: docs.slice() },
            });
            return;
          }
          if (method === 'docs.getUploadServer') {
            await fulfill({ response: { upload_url: 'https://pu.vk.ru/upload_doc.php' } });
            return;
          }
          if (method === 'docs.save') {
            const title = body.get('title') || 'file';
            savedTitles.push(title);
            const id = 900 + saveCount++;
            const ext = title.slice(title.lastIndexOf('.') + 1).toLowerCase();
            await fulfill({
              response: {
                type: 'doc',
                doc: {
                  owner_id: 42,
                  id,
                  title,
                  ext,
                  type: 4,
                  size: 10,
                  date: 1,
                  url: `https://vk.ru/doc42_${id}`,
                  preview: {
                    photo: {
                      sizes: [{ type: 's', src: 'https://vk.ru/s.png', width: 64, height: 64 }],
                    },
                  },
                },
              },
            });
            return;
          }
          if (method === 'docs.delete') {
            deleteRequests.push(body.get('owner_id') + ':' + body.get('doc_id'));
            const owner = Number(body.get('owner_id'));
            const id = Number(body.get('doc_id'));
            const at = docs.findIndex((d) => d.owner_id === owner && d.id === id);
            if (at >= 0) docs.splice(at, 1);
            await fulfill({ response: 1 });
            return;
          }
          await fulfill({ error: { error_code: 3, error_msg: 'Unknown method' } });
          return;
        }
        if (url.startsWith('https://pu.vk.ru/')) {
          await fulfill({ file: 'integration-file' });
          return;
        }
        await call('Fetch.continueRequest', { requestId }, message.sessionId);
      } catch (e) {
        // Стенд всё равно завершится по таймауту.
      }
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  };

  const target = await call('Target.createTarget', { url: 'about:blank' });
  const targetId = target.targetId;
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call(
    'Fetch.enable',
    { patterns: [{ urlPattern: 'https://web.api.vk.ru/*' }, { urlPattern: 'https://pu.vk.ru/*' }] },
    sessionId
  );
  await call(
    'Page.navigate',
    { url: `https://vk.com/tests/extension-integration.html` },
    sessionId
  );
  await call('Page.bringToFront', {}, sessionId).catch(() => {});
  await call('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  await call('Emulation.setPageVisibilityOverride', { visibility: 'visible' }, sessionId).catch(() => {});
  await call('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});

  let report = null;
  let deleteAttempts = 0;
  let deleteAttemptAt = 0;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const { result } = await call(
      'Runtime.evaluate',
      { expression: 'document.querySelector("#result")?.textContent || ""', returnByValue: true },
      sessionId
    );
    if (result.value && result.value.startsWith('RESULT ')) {
      report = JSON.parse(result.value.slice(7));
      break;
    }
    if (deleteAttempts < 4 && (deleteAttempts === 0 || Date.now() - deleteAttemptAt > 2500)) {
      const canRetry = deleteAttempts === 0 || deleteRequests.length === 0;
      if (canRetry) {
        const point = await call(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const cross = document.querySelector('.vk7tv-doc-cell[data-name="reaction.gif"] .vk7tv-doc-delete');
              if (!cross) return null;
              const r = cross.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })()`,
            returnByValue: true,
          },
          sessionId
        );
        const at = point.result && point.result.value;
        if (at) {
          deleteAttempts++;
          deleteAttemptAt = Date.now();
          await call(
            'Input.dispatchMouseEvent',
            { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 },
            sessionId
          );
          await call(
            'Input.dispatchMouseEvent',
            { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 },
            sessionId
          );
          await delay(1150);
          await call(
            'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 },
            sessionId
          );
        }
      }
    }
    await delay(50);
  }
  if (!report) {
    const info = await call(
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({href: location.href, title: document.title, text: document.body && document.body.innerText.slice(0, 500), html: document.documentElement.outerHTML.slice(0, 500)})',
        returnByValue: true,
      },
      sessionId
    ).catch(() => null);
    console.error('page:', info && info.result && info.result.value);
    const targets = await call('Target.getTargets').catch(() => null);
    console.error(
      'targets:',
      targets && targets.targetInfos.map((t) => `${t.type} ${t.url}`).join('\n')
    );
    throw new Error('интеграционный стенд не отчитался');
  }
  const lines = report.lines || [];
  lines.push(
    (savedTitles.includes('reaction.gif') ? '  ok  ' : '  FAIL') +
      ' docs.save получил GIF — ' +
      savedTitles.join(',')
  );
  lines.push(
    (deleteRequests.length ? '  ok  ' : '  FAIL') +
      ' docs.delete получил ключ — ' +
      deleteRequests.join(',')
  );
  if (!savedTitles.includes('reaction.gif') || !deleteRequests.length) {
    report.ok = false;
  }
  console.log(`${report.ok ? 'OK  ' : 'FAIL'} extension-integration — ${lines.length} проверок`);
  console.log(lines.join('\n'));
  if (!report.ok) failed = true;
  await call('Browser.close').catch(() => {});
} catch (e) {
  failed = true;
  console.error('FAIL extension-integration: ' + e.message);
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([new Promise((r) => chrome.once('exit', r)), delay(3000)]);
  }
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  await rm(certDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
process.exitCode = failed ? 1 : 0;
