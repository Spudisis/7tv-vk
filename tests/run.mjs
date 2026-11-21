// Run real browser pages until the harness reports completion. Virtual time
// can outrun Blob reads and animation frames, producing false timeouts.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'vk7tv-tests-'));
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(resolve(root) + sep)) throw new Error('path');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.setHeader('Content-Type', (types[extname(path)] || 'application/octet-stream') + '; charset=utf-8');
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let chrome;
let ws;
let failed = false;
const delay = ms => new Promise(r => setTimeout(r, ms));
try {
  chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out: ' + stderr.slice(-1000))), 15000);
    chrome.once('error', e => { clearTimeout(timer); reject(e); });
    chrome.once('exit', code => { clearTimeout(timer); reject(new Error('Chrome exited: ' + code)); });
    chrome.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    // Native image requests bypass the stands' fetch mocks. Serve this
    // reserved test URL locally so poster errors are not DNS-dependent.
    if (message.method === 'Fetch.requestPaused') {
      const image = await readFile(join(root, 'tests/poster.svg'));
      await call('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }], body: image.toString('base64') }, message.sessionId);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  };
  const call = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 10000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  for (const page of (await readdir(join(root, 'tests'))).filter(p => p.endsWith('.test.html')).sort()) {
    let targetId;
    let contextId;
    try {
      // Separate storage and cookies for every stand.
      contextId = (await call('Target.createBrowserContext')).browserContextId;
      targetId = (await call('Target.createTarget', { url: 'about:blank', browserContextId: contextId })).targetId;
      const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
      await call('Fetch.enable', { patterns: [{ urlPattern: 'https://media.test/poster.png' }] }, sessionId);
      await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/tests/${page}` }, sessionId);
      let report;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          const { result, exceptionDetails } = await call('Runtime.evaluate', {
            expression: 'document.querySelector("#result")?.textContent || ""', returnByValue: true,
          }, sessionId);
          if (!exceptionDetails && result.value?.startsWith('RESULT ')) {
            report = JSON.parse(result.value.slice(7));
            break;
          }
        } catch (e) {
          // Стенд может перезагрузить страницу между проходами: в момент
          // навигации evaluate отменяется, но цель и сессия остаются живы.
          if (!/navigated or closed/i.test(e.message)) throw e;
        }
        await delay(25);
      }
      if (!report) throw new Error('stand did not report within 30 seconds');
      console.log(`${report.failed ? 'FAIL' : 'OK  '} ${page} — checks ${report.total}, failures ${report.failed}`);
      if (report.failed || process.argv.includes('-v')) console.log(report.lines.join('\n'));
      if (report.failed) failed = true;
    } catch (e) {
      failed = true;
      console.error(`FAIL ${page}: ${e.message}`);
    } finally {
      if (targetId) await call('Target.closeTarget', { targetId }).catch(() => {});
      if (contextId) await call('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
    }
  }
  await call('Browser.close').catch(() => {});
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([new Promise(r => chrome.once('exit', r)), delay(3000)]);
  }
  await new Promise(r => server.close(r));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
process.exitCode = failed ? 1 : 0;
