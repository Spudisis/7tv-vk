// VK7TV — разбор контейнера WebP до декодирования.
//
// Нужен, чтобы отличить статичный WebP от анимированного и отсеять файл
// до запуска ImageDecoder. Формат — RIFF/WebP: чанки с 32-битным размером
// и выравниванием до чётного байта. Анимация описана парой чанков ANIM
// (число циклов) и ANMF (кадр); один ANMF — всё равно анимация.
//
// Модуль работает и в контент-скрипте, и в worker: в обоих случаях
// раскладывает API в глобальную область.

(function (root) {
  if (root.VK7TV_WEBP_PARSE) return;

  // Ограничения расширения, не VK. Все проверяются по метаданным, до того
  // как ImageDecoder начнёт держать кадры в памяти.
  const LIMITS = Object.freeze({
    sourceBytes: 32 * 1024 * 1024,
    framePixels: 4 * 1000 * 1000,
    frameCount: 1000,
    totalPixels: 100 * 1000 * 1000,
    gifBytes: 50 * 1024 * 1024,
    timeoutMs: 60000,
  });
  // GIF хранит ширину и высоту в 16 битах.
  const GIF_MAX_SIDE = 65535;

  const ANIMATION_FLAG = 0x02;

  function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    throw error;
  }

  function tagAt(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) return '';
    return String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
  }

  function u16(bytes, offset) {
    if (offset < 0 || offset + 2 > bytes.length) fail('corrupt');
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function u24(bytes, offset) {
    if (offset < 0 || offset + 3 > bytes.length) fail('corrupt');
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  }

  function u32(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) fail('corrupt');
    // >>> 0: размер RIFF и чанка — беззнаковые, не Int32.
    return (
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0
    );
  }

  function checkHeader(bytes, totalSize) {
    if (!bytes || bytes.length < 12) fail('corrupt');
    if (tagAt(bytes, 0) !== 'RIFF' || tagAt(bytes, 8) !== 'WEBP') fail('corrupt');
    const riffSize = u32(bytes, 4);
    if (riffSize + 8 !== totalSize) fail('corrupt');
  }

  // Возвращает чанки без вложенного разбора; payload нужен только тем,
  // чьи поля читаются дальше (VP8X/ANIM/ANMF).
  function readChunks(bytes, start, end) {
    const out = [];
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) fail('corrupt');
      const tag = tagAt(bytes, offset);
      if (!tag) fail('corrupt');
      const size = u32(bytes, offset + 4);
      const dataStart = offset + 8;
      const dataEnd = dataStart + size;
      if (dataEnd < dataStart || dataEnd > end) fail('corrupt');
      const pad = size & 1;
      const next = dataEnd + pad;
      if (next > end) fail('corrupt');
      out.push({ tag, size, dataStart, dataEnd });
      offset = next;
    }
    return out;
  }

  function vp8xInfo(bytes, chunk) {
    if (chunk.size !== 10) fail('corrupt');
    const flags = bytes[chunk.dataStart];
    const width = u24(bytes, chunk.dataStart + 4) + 1;
    const height = u24(bytes, chunk.dataStart + 7) + 1;
    if (!width || !height) fail('corrupt');
    if (width * height > 0xffffffff) fail('corrupt');
    return { flags, width, height, animated: !!(flags & ANIMATION_FLAG) };
  }

  function animInfo(bytes, chunk) {
    if (chunk.size !== 6) fail('corrupt');
    return { loopCount: u16(bytes, chunk.dataStart + 4) };
  }

  function anmfInfo(bytes, chunk, canvasWidth, canvasHeight) {
    if (chunk.size < 16) fail('corrupt');
    const x = u24(bytes, chunk.dataStart) * 2;
    const y = u24(bytes, chunk.dataStart + 3) * 2;
    const width = u24(bytes, chunk.dataStart + 6) + 1;
    const height = u24(bytes, chunk.dataStart + 9) + 1;
    const duration = u24(bytes, chunk.dataStart + 12);
    if (!width || !height) fail('corrupt');
    if (x + width > canvasWidth || y + height > canvasHeight) fail('corrupt');
    return { x, y, width, height, duration };
  }

  function checkLimits(width, height, frameCount) {
    const frameArea = width * height;
    if (frameArea > LIMITS.framePixels) fail('limit');
    if (frameCount > LIMITS.frameCount) fail('limit');
    if (frameArea * frameCount > LIMITS.totalPixels) fail('limit');
    if (width > GIF_MAX_SIDE || height > GIF_MAX_SIDE) fail('limit');
  }

  // Общая проверка структуры для полного разбора и для быстрого чтения
  // заголовков файла. Принимает чанки с уже прочитанными полями.
  function analyze(chunks, fileSize, strict) {
    if (!chunks.length) fail('corrupt');
    const first = chunks[0];
    let vp8x = null;
    let anim = null;
    let frameCount = 0;
    let imageChunks = 0;
    let alphaChunks = 0;
    const frames = [];

    if (first.tag === 'VP8X') {
      vp8x = vp8xInfo(first.bytes, first);
    } else if (first.tag !== 'VP8 ' && first.tag !== 'VP8L') {
      fail('corrupt');
    }

    for (const chunk of chunks) {
      if (chunk.tag === 'VP8X') {
        if (chunk !== first) fail('corrupt');
        continue;
      }
      if (chunk.tag === 'ANIM') {
        if (!vp8x || anim || frameCount > 0) fail('corrupt');
        anim = animInfo(chunk.bytes, chunk);
        continue;
      }
      if (chunk.tag === 'ANMF') {
        if (!vp8x || !anim || !vp8x.animated) fail('corrupt');
        const info = anmfInfo(chunk.bytes, chunk, vp8x.width, vp8x.height);
        if (strict) {
          const sub = readChunks(
            chunk.bytes,
            chunk.dataStart + 16,
            chunk.dataEnd
          );
          let bitstream = 0;
          let alpha = 0;
          for (const item of sub) {
            if (item.tag === 'VP8 ' || item.tag === 'VP8L') {
              if (!item.size) fail('corrupt');
              bitstream++;
            } else if (item.tag === 'ALPH') {
              if (bitstream || alpha || !item.size) fail('corrupt');
              alpha++;
            }
          }
          if (bitstream !== 1) fail('corrupt');
        }
        frameCount++;
        frames.push(info);
        continue;
      }
      if (chunk.tag === 'VP8 ' || chunk.tag === 'VP8L') {
        if (vp8x && vp8x.animated) fail('corrupt');
        if (chunk.size < 1) fail('corrupt');
        imageChunks++;
        continue;
      }
      if (chunk.tag === 'ALPH') {
        if (!vp8x || vp8x.animated) fail('corrupt');
        if (alphaChunks++) fail('corrupt');
        continue;
      }
    }

    if (!vp8x) {
      if (anim || frameCount) fail('corrupt');
      if (imageChunks !== 1) fail('corrupt');
      return {
        animated: false,
        width: 0,
        height: 0,
        frameCount: 0,
        loopCount: 0,
        fileSize,
        frames: [],
      };
    }

    if (vp8x.animated) {
      if (!anim || !frameCount) fail('corrupt');
      if (imageChunks) fail('corrupt');
      checkLimits(vp8x.width, vp8x.height, frameCount);
      return {
        animated: true,
        width: vp8x.width,
        height: vp8x.height,
        frameCount,
        loopCount: anim.loopCount,
        fileSize,
        frames,
      };
    }

    if (anim || frameCount) fail('corrupt');
    if (imageChunks !== 1) fail('corrupt');
    return {
      animated: false,
      width: vp8x.width,
      height: vp8x.height,
      frameCount: 0,
      loopCount: 0,
      fileSize,
      frames: [],
    };
  }

  function parse(bytes) {
    checkHeader(bytes, bytes.length);
    const chunks = readChunks(bytes, 12, bytes.length);
    for (const chunk of chunks) chunk.bytes = bytes;
    const info = analyze(chunks, bytes.length, true);
    if (info.animated && bytes.length > LIMITS.sourceBytes) fail('limit');
    return info;
  }

  function readSlice(file, offset, length) {
    return file
      .slice(offset, offset + length)
      .arrayBuffer()
      .then((buffer) => new Uint8Array(buffer));
  }

  // Для файла больше лимита не читаем всё в память: поля VP8X/ANIM/ANMF
  // помещаются в начало чанков, а тела кадров пропускаются по размеру.
  async function inspectFile(file) {
    if (!file || typeof file.size !== 'number' || !file.size) fail('corrupt');
    const header = await readSlice(file, 0, 12);
    checkHeader(header, file.size);
    const chunks = [];
    let offset = 12;
    while (offset < file.size) {
      const head = await readSlice(file, offset, 8);
      if (head.length !== 8) fail('corrupt');
      const tag = tagAt(head, 0);
      if (!tag) fail('corrupt');
      const size = u32(head, 4);
      const dataStart = offset + 8;
      const dataEnd = dataStart + size;
      if (dataEnd < dataStart || dataEnd > file.size) fail('corrupt');
      const next = dataEnd + (size & 1);
      if (next > file.size) fail('corrupt');

      let bytes = head;
      if (tag === 'VP8X') {
        bytes = await readSlice(file, offset, 8 + 10);
        if (bytes.length !== 18) fail('corrupt');
      } else if (tag === 'ANIM') {
        bytes = await readSlice(file, offset, 8 + 6);
        if (bytes.length !== 14) fail('corrupt');
      } else if (tag === 'ANMF') {
        bytes = await readSlice(file, offset, 8 + 16);
        if (bytes.length < 24) fail('corrupt');
      }
      chunks.push({ tag, size, dataStart, dataEnd, bytes });
      offset = next;
    }

    // analyze() читает поля по chunk.dataStart/dataEnd, а здесь payload
    // начинается сразу после восьмибайтного заголовка прочитанного куска.
    for (const chunk of chunks) {
      chunk.dataStart = 8;
      chunk.dataEnd = 8 + chunk.size;
    }
    const info = analyze(chunks, file.size, false);
    if (info.animated && file.size > LIMITS.sourceBytes) fail('limit');
    return info;
  }

  root.VK7TV_WEBP_PARSE = { LIMITS, parse, inspectFile, GIF_MAX_SIDE };
})(typeof self !== 'undefined' ? self : globalThis);
