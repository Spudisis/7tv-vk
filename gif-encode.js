// VK7TV — общее кодирование RGBA-кадров в GIF на базе gifenc.
//
// Модуль используют оба конвертера: WebP -> GIF и MP4 -> GIF. WebP
// сохраняет прежние правила: альфа ниже 128 становится прозрачной, под
// прозрачность резервируется индекс 0, а непрозрачные цвета сдвигаются на
// единицу. Видео кодируется непрозрачным: все 256 цветов доступны кадру.
//
// Здесь же лежат расчёты повторов и задержек, чтобы оба worker'а считали
// время одинаково. gifenc лежит рядом, версия 1.0.3, MIT
// (vendor/gifenc.LICENSE.md).

import {
  GIFEncoder,
  quantize,
  applyPalette,
} from './vendor/gifenc.esm.js';

export const ALPHA_THRESHOLD = 128;
export const TRANSPARENT_INDEX = 0;
export const MAX_COLORS = 255;
export const MAX_OPAQUE_COLORS = 256;
export const MAX_GIF_DELAY_CS = 65535;
export const MIN_GIF_DELAY_MS = 10;

// Начальная ёмкость буфера GIF: один кадр RGBA обычно сжимается меньше,
// чем занимает в памяти, а лишний рост буфера стоит копирования.
export function createGifEncoder(width, height) {
  const pixels = Math.max(1, Number(width) * Number(height) || 1);
  return GIFEncoder({ initialCapacity: Math.min(1024 * 1024, pixels) });
}

// WebP: Loop Count — число проигрываний (0 — бесконечно). GIF Netscape:
// число дополнительных повторов после первого (0 — бесконечно), а -1
// означает отсутствие расширения и один проход.
export function gifRepeat(loopCount) {
  if (loopCount === 0) return 0;
  if (loopCount === 1) return -1;
  return loopCount - 1;
}

// Задержки по длительностям кадров WebP. Округляем накопленное время, а не
// каждый кадр: иначе ошибка складывается за сотни кадров и GIF уезжает по
// времени. Поле задержки GIF — 16 бит, более длинная пауза не хранится;
// остаток переходит в следующие кадры.
export function delayPlan(frames) {
  const out = [];
  let cumulativeMs = 0;
  let previousCs = 0;
  for (const frame of frames) {
    cumulativeMs += Math.max(0, Number(frame.duration) || 0);
    previousCs = pushDelay(out, cumulativeMs, previousCs);
  }
  return out;
}

// Задержки видео: кадр i занимает интервал [i/fps, (i+1)/fps], последний
// интервал обрезается по фактической длительности ролика. Минимальная
// задержка GIF — 10 мс, чтобы декодер не склеил соседние кадры.
export function videoDelayPlan(durationMs, frameCount, fps) {
  const out = [];
  const total = Math.max(1, Math.floor(Number(frameCount) || 0));
  const rate = Number(fps) > 0 ? Number(fps) : 1;
  const duration = Math.max(0, Number(durationMs) || 0);
  let previousCs = 0;
  for (let i = 0; i < total; i++) {
    const endMs =
      i === total - 1 ? duration : Math.min(duration, ((i + 1) * 1000) / rate);
    previousCs = pushDelay(out, endMs, previousCs);
  }
  return out;
}

function pushDelay(out, cumulativeMs, previousCs) {
  const targetCs = Math.max(previousCs + 1, Math.round(cumulativeMs / 10));
  const frameCs = Math.min(MAX_GIF_DELAY_CS, targetCs - previousCs);
  out.push(frameCs * MIN_GIF_DELAY_MS);
  return previousCs + frameCs;
}

// Прозрачный кадр: полный RGBA -> палитра до 255 цветов + отдельный
// прозрачный индекс. Альфа ниже 128 считается прозрачной, остальные
// пиксели — непрозрачными с исходным RGB.
function encodeTransparent(rgba, width, height) {
  const length = width * height;
  let opaqueCount = 0;
  for (let i = 0; i < length; i++) {
    const alpha = rgba[i * 4 + 3];
    if (alpha >= ALPHA_THRESHOLD) {
      opaqueCount++;
    } else {
      rgba[i * 4] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0;
    }
  }

  let palette = [];
  if (opaqueCount) {
    const opaque = new Uint8Array(opaqueCount * 4);
    let at = 0;
    for (let i = 0; i < length; i++) {
      if (rgba[i * 4 + 3] < ALPHA_THRESHOLD) continue;
      opaque[at++] = rgba[i * 4];
      opaque[at++] = rgba[i * 4 + 1];
      opaque[at++] = rgba[i * 4 + 2];
      opaque[at++] = 255;
    }
    palette = quantize(opaque, MAX_COLORS);
  }

  let index;
  if (palette.length) {
    index = applyPalette(rgba, palette);
    // Индекс 0 оставлен прозрачности. Сдвигаем все непрозрачные цвета на
    // единицу, чтобы чёрный цвет кадра не стал прозрачным.
    for (let i = 0; i < index.length; i++) index[i]++;
  } else {
    index = new Uint8Array(length);
  }
  for (let i = 0; i < length; i++) {
    if (rgba[i * 4 + 3] < ALPHA_THRESHOLD) index[i] = TRANSPARENT_INDEX;
  }

  return {
    palette: [[0, 0, 0]].concat(palette),
    index,
    transparent: true,
    transparentIndex: TRANSPARENT_INDEX,
  };
}

// Непрозрачный кадр видео: палитра до 256 цветов, прозрачного индекса нет.
// Альфа в таком GIF не хранится, поэтому квантуем только RGB.
function encodeOpaque(rgba, width, height) {
  const length = width * height;
  const palette = quantize(rgba, MAX_OPAQUE_COLORS);
  const index = palette.length ? applyPalette(rgba, palette) : new Uint8Array(length);
  return {
    palette,
    index,
    transparent: false,
    transparentIndex: 0,
  };
}

// transparent: true — прежние правила WebP (альфа и прозрачный индекс).
// false — непрозрачный кадр видео с полной палитрой на 256 цветов.
export function encodeRgbaFrame(rgba, width, height, options) {
  const transparent = !options || options.transparent !== false;
  if (transparent) return encodeTransparent(rgba, width, height);
  return encodeOpaque(rgba, width, height);
}
