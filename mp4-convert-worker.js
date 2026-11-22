// VK7TV — кодирование GIF из RGBA-кадров видео.
//
// Кадры приходят по одному: worker подтверждает обработку, и только после
// этого iframe присылает следующий. Все кадры сразу не накапливаются, а
// размер готового GIF проверяется на каждом шаге.
//
// Worker не получает ни токен, ни доступ к API: только размеры кадра и
// пиксели. gifenc и общее кодирование — в gif-encode.js.

import './mp4-parse.js';
import {
  createGifEncoder,
  encodeRgbaFrame,
  videoDelayPlan,
} from './gif-encode.js';

const PARSER = self.VK7TV_MP4_PARSE;
const LIMITS = PARSER.LIMITS;

let encoder = null;
let width = 0;
let height = 0;
let total = 0;
let expectedBytes = 0;
let delays = [];
let nextIndex = 0;
let startedAt = 0;
let canceled = false;
let running = false;

function errorMessage(kind) {
  switch (kind) {
    case 'gif-size':
      return 'Получившийся GIF больше 50 МиБ.';
    case 'timeout':
      return 'Преобразование видео в GIF заняло больше 60 секунд.';
    case 'frame':
      return 'Не удалось закодировать кадр видео.';
    case 'canceled':
      return 'Преобразование отменено';
    default:
      return 'Не удалось преобразовать видео в GIF.';
  }
}

function fail(kind) {
  const error = new Error(errorMessage(kind));
  error.kind = kind;
  throw error;
}

function checkTime() {
  if (Date.now() - startedAt > LIMITS.timeoutMs) fail('timeout');
}

function reset() {
  encoder = null;
  width = 0;
  height = 0;
  total = 0;
  expectedBytes = 0;
  delays = [];
  nextIndex = 0;
  startedAt = 0;
}

function start(data) {
  if (running || canceled) return;
  const w = Math.floor(Number(data.width) || 0);
  const h = Math.floor(Number(data.height) || 0);
  const count = Math.floor(Number(data.total) || 0);
  const durationMs = Number(data.durationMs) || 0;
  const fps = Number(data.fps) || LIMITS.fps;
  if (!w || !h || w * h > LIMITS.framePixels) fail('frame');
  if (!count || count > Math.ceil((LIMITS.durationMs * LIMITS.fps) / 1000) + 1) {
    fail('frame');
  }
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) fail('frame');
  if (!(fps > 0) || !Number.isFinite(fps)) fail('frame');

  width = w;
  height = h;
  total = count;
  expectedBytes = w * h * 4;
  delays = videoDelayPlan(durationMs, total, fps);
  encoder = createGifEncoder(w, h);
  running = true;
  startedAt = Date.now();
  self.postMessage({ type: 'ready', total });
}

function frame(data) {
  if (!running || !encoder) fail('frame');
  if (canceled) fail('canceled');
  checkTime();
  const index = Math.floor(Number(data.index));
  if (index !== nextIndex) fail('frame');
  const buffer = data.data;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== expectedBytes) {
    fail('frame');
  }

  const rgba = new Uint8ClampedArray(buffer);
  const encoded = encodeRgbaFrame(rgba, width, height, { transparent: false });
  encoder.writeFrame(encoded.index, width, height, {
    palette: encoded.palette,
    transparent: false,
    delay: delays[index],
    // Первый кадр задаёт Netscape-расширение: 0 — бесконечный повтор.
    repeat: 0,
    dispose: 1,
  });

  nextIndex++;
  checkTime();
  if (encoder.bytesView().byteLength > LIMITS.gifBytes) fail('gif-size');
  self.postMessage({ type: 'ack', index });
}

function finish() {
  if (!running || !encoder) fail('frame');
  if (canceled) fail('canceled');
  if (nextIndex !== total) fail('frame');
  checkTime();
  encoder.finish();
  const out = encoder.bytes();
  if (out.byteLength > LIMITS.gifBytes) fail('gif-size');
  self.postMessage({ type: 'done', bytes: out.buffer }, [out.buffer]);
  running = false;
  reset();
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'cancel') {
    canceled = true;
    running = false;
    reset();
    return;
  }
  if (canceled) return;
  try {
    if (data.type === 'start') start(data);
    else if (data.type === 'frame') frame(data);
    else if (data.type === 'finish') finish();
  } catch (e) {
    const kind = (e && e.kind) || 'failed';
    running = false;
    reset();
    self.postMessage({ type: 'error', kind, message: errorMessage(kind) });
  }
};
