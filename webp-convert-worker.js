// VK7TV — декодирование анимированного WebP и кодирование GIF.
//
// Worker не получает ни токен, ни доступ к API: только байты файла.
// ImageDecoder отдаёт уже скомпонованный кадр (blending/disposal учтены
// декодером), поэтому в GIF пишется полный кадр с его собственным disposal.
// gifenc лежит рядом, версия 1.0.3, MIT (vendor/gifenc.LICENSE.md).

import './webp-parse.js';
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';

const PARSER = self.VK7TV_WEBP_PARSE;
const LIMITS = PARSER.LIMITS;
const ALPHA_THRESHOLD = 128;
const TRANSPARENT_INDEX = 0;
const MAX_COLORS = 255;
const MAX_GIF_DELAY_CS = 65535;

let decoder = null;
let canceled = false;
let running = false;
let startedAt = 0;

function errorMessage(kind) {
  switch (kind) {
    case 'unsupported':
      return 'Этот браузер не поддерживает преобразование анимированного WebP. Загрузите GIF.';
    case 'limit':
      return 'Анимированный WebP превышает лимит преобразования (32 МиБ, 4 млн пикселей на кадр, 1000 кадров или 100 млн пикселей суммарно).';
    case 'gif-size':
      return 'Получившийся GIF больше 50 МиБ.';
    case 'timeout':
      return 'Преобразование WebP в GIF заняло больше 60 секунд.';
    case 'corrupt':
      return 'Файл повреждён или его содержимое не совпадает с расширением.';
    case 'decode':
      return 'Не удалось декодировать анимированный WebP.';
    default:
      return 'Не удалось преобразовать анимированный WebP в GIF.';
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

// WebP: Loop Count — число проигрываний (0 — бесконечно). GIF Netscape:
// число дополнительных повторов после первого (0 — бесконечно), а -1
// означает отсутствие расширения и один проход.
function gifRepeat(loopCount) {
  if (loopCount === 0) return 0;
  if (loopCount === 1) return -1;
  return loopCount - 1;
}

function delayPlan(frames) {
  const out = [];
  let cumulativeMs = 0;
  let previousCs = 0;
  for (const frame of frames) {
    cumulativeMs += Math.max(0, Number(frame.duration) || 0);
    // Округляем накопленное время, а не каждый кадр: иначе ошибка
    // округления складывается за сотни кадров и GIF уезжает по времени.
    const targetCs = Math.max(previousCs + 1, Math.round(cumulativeMs / 10));
    // Поле задержки GIF — 16 бит. Более длинную паузу формат не хранит;
    // ограничиваем её, а остаток переходит в следующие кадры, чтобы общая
    // длительность не потерялась и значение не завернулось через 65535.
    const frameCs = Math.min(MAX_GIF_DELAY_CS, targetCs - previousCs);
    out.push(frameCs * 10);
    previousCs += frameCs;
  }
  return out;
}

// Один кадр: полный RGBA -> палитра до 255 цветов + отдельный прозрачный
// индекс. Альфа ниже 128 считается прозрачной, остальные пиксели —
// непрозрачными с исходным RGB.
function encodeFrame(encoder, rgba, width, height) {
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
  };
}

async function convert(data) {
  if (typeof ImageDecoder === 'undefined' || typeof ImageDecoder.isTypeSupported !== 'function') {
    fail('unsupported');
  }
  if (!(await ImageDecoder.isTypeSupported('image/webp'))) fail('unsupported');

  let bytes;
  try {
    bytes = new Uint8Array(data);
    const info = PARSER.parse(bytes);
    if (!info.animated) fail('corrupt');
    if (info.fileSize > LIMITS.sourceBytes) fail('limit');

    await decoderReady(info, bytes);
    return await encode(info);
  } catch (e) {
    if (e && e.kind) throw e;
    if (canceled) {
      const error = new Error('canceled');
      error.kind = 'canceled';
      throw error;
    }
    if (e && e.code === 'limit') fail('limit');
    if (e && e.code === 'corrupt') fail('corrupt');
    fail(bytes ? 'decode' : 'corrupt');
  }
}

async function decoderReady(info, bytes) {
  decoder = new ImageDecoder({
    data: bytes,
    type: 'image/webp',
    preferAnimation: true,
  });
  if (!decoder.complete) await decoder.completed;
  await decoder.tracks.ready;
  const list = Array.from(decoder.tracks);
  const track = decoder.tracks.selectedTrack || list[0];
  if (!track) fail('decode');
  const count = Number(track.frameCount) || 0;
  if (count !== info.frameCount) fail('decode');
  if (count > LIMITS.frameCount) fail('limit');
}

async function encode(info) {
  const width = info.width;
  const height = info.height;
  const total = info.frameCount;
  const delays = delayPlan(info.frames);
  const repeat = gifRepeat(info.loopCount);
  const encoder = GIFEncoder({ initialCapacity: Math.min(1024 * 1024, width * height) });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) fail('decode');

  try {
    for (let i = 0; i < total; i++) {
      if (canceled) fail('canceled');
      checkTime();

      let result;
      try {
        result = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      } catch (e) {
        if (canceled) fail('canceled');
        fail('decode');
      }
      const frame = result && result.image;
      if (!frame) fail('decode');
      try {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(frame, 0, 0, width, height);
      } finally {
        try {
          frame.close();
        } catch (e) {
          // кадр уже закрыт
        }
      }

      let imageData;
      try {
        imageData = ctx.getImageData(0, 0, width, height);
      } catch (e) {
        fail('decode');
      }
      const encoded = encodeFrame(encoder, imageData.data, width, height);
      encoder.writeFrame(encoded.index, width, height, {
        palette: encoded.palette,
        transparent: true,
        transparentIndex: TRANSPARENT_INDEX,
        delay: delays[i],
        repeat,
        dispose: 2,
      });
      imageData = null;
      encoded.index = null;

      checkTime();
      if (encoder.bytesView().byteLength > LIMITS.gifBytes) fail('gif-size');
      self.postMessage({ type: 'progress', frame: i + 1, total });
    }

    encoder.finish();
    const out = encoder.bytes();
    if (out.byteLength > LIMITS.gifBytes) fail('gif-size');
    return out;
  } finally {
    try {
      decoder.close();
    } catch (e) {
      // декодер уже закрыт
    }
    decoder = null;
  }
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'cancel') {
    canceled = true;
    if (decoder) {
      try {
        decoder.close();
      } catch (e) {
        // декодер уже закрыт
      }
    }
    return;
  }
  if (data.type !== 'convert' || running) return;
  running = true;
  canceled = false;
  startedAt = Date.now();
  convert(data.data)
    .then((bytes) => {
      self.postMessage({ type: 'done', bytes: bytes.buffer }, [bytes.buffer]);
    })
    .catch((e) => {
      const kind = (e && e.kind) || 'failed';
      if (kind === 'canceled') {
        self.postMessage({ type: 'canceled' });
        return;
      }
      self.postMessage({ type: 'error', kind, message: errorMessage(kind) });
    })
    .finally(() => {
      running = false;
    });
};
