// VK7TV — структурная проверка MP4 до декодирования.
//
// Одного ftyp в начале файла мало: так выглядит и обрезанный ролик, и
// переименованный файл. Здесь проверяется цепочка боксов ISO BMFF:
// ftyp -> moov (с видеодорожкой) -> mdat. Боксы читаются по размерам,
// поэтому проверка не загружает mdat в память и работает с файлами,
// метаданные которых лежат в конце.
//
// Модуль работает в контент-скрипте, в iframe конвертера и в worker:
// раскладывает API в глобальную область.

(function (root) {
  if (root.VK7TV_MP4_PARSE) return;

  // Ограничения расширения, не VK. Длительность и частота относятся
  // только к преобразованию в GIF; исходный MP4 можно загрузить и больше.
  const LIMITS = Object.freeze({
    sourceBytes: 32 * 1024 * 1024,
    framePixels: 4 * 1000 * 1000,
    gifBytes: 50 * 1024 * 1024,
    timeoutMs: 60000,
    durationMs: 15000,
    fps: 15,
    maxSide: 480,
  });

  const MAX_BOX_DEPTH = 12;
  const MAX_MOOV_BYTES = 32 * 1024 * 1024;
  const VIDEO_HANDLER = 'vide';
  const AUDIO_HANDLER = 'soun';

  function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    throw error;
  }

  function tagAt(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) return '';
    const out = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    return /^[\x20-\x7e]{4}$/.test(out) ? out : '';
  }

  function u32(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) fail('corrupt');
    return (
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]
    ) >>> 0;
  }

  function u64(bytes, offset) {
    const high = u32(bytes, offset);
    const low = u32(bytes, offset + 4);
    // Размер бокса больше 2^53 всё равно не поместится в память страницы.
    if (high > 0x1fffff) fail('limit');
    return high * 0x100000000 + low;
  }

  function boxHeader(bytes, offset, end) {
    if (offset < 0 || offset + 8 > end) fail('corrupt');
    let size = u32(bytes, offset);
    const type = tagAt(bytes, offset + 4);
    if (!type) fail('corrupt');
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) fail('corrupt');
      size = u64(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header) fail('corrupt');
    const next = offset + size;
    if (next > end) fail('corrupt');
    return {
      type,
      start: offset,
      dataStart: offset + header,
      end: next,
      size,
      header,
    };
  }

  // Обход вложенных боксов moov. Ограничение глубины защищает от
  // специально собранного файла с бесконечной вложенностью.
  function walkBoxes(bytes, start, end, depth, visit) {
    if (depth > MAX_BOX_DEPTH) fail('corrupt');
    let offset = start;
    while (offset < end) {
      const box = boxHeader(bytes, offset, end);
      visit(box, depth);
      offset = box.end;
    }
    if (offset !== end) fail('corrupt');
  }

  function inspectMoov(bytes, start, end) {
    let videoTracks = 0;
    let audioTracks = 0;
    let encrypted = false;

    function scanTrak(box, depth) {
      walkBoxes(bytes, box.dataStart, box.end, depth + 1, (child) => {
        if (child.type === 'mdia') scanMdia(child, depth + 1);
      });
    }

    function scanMdia(box, depth) {
      walkBoxes(bytes, box.dataStart, box.end, depth + 1, (child) => {
        if (child.type === 'hdlr') {
          // hdlr: version/flags (4), pre_defined (4), handler_type (4).
          const handler = tagAt(bytes, child.dataStart + 8);
          if (handler === VIDEO_HANDLER) videoTracks++;
          else if (handler === AUDIO_HANDLER) audioTracks++;
        } else if (child.type === 'minf') {
          walkBoxes(bytes, child.dataStart, child.end, depth + 1, (inner) => {
            if (inner.type === 'stbl') {
              walkBoxes(bytes, inner.dataStart, inner.end, depth + 1, (leaf) => {
                if (leaf.type === 'stsd') {
                  scanSampleEntries(leaf, depth + 1);
                }
              });
            }
          });
        }
      });
    }

    function scanSampleEntries(box, depth) {
      // stsd: version/flags (4), entry_count (4), затем sample entry.
      let offset = box.dataStart + 8;
      if (offset > box.end) fail('corrupt');
      while (offset < box.end) {
        const entry = boxHeader(bytes, offset, box.end);
        if (entry.type === 'encv' || entry.type === 'enca') encrypted = true;
        offset = entry.end;
      }
    }

    walkBoxes(bytes, start, end, 0, (box, depth) => {
      if (box.type === 'trak') scanTrak(box, depth);
    });

    return { videoTracks, audioTracks, encrypted };
  }

  function checkFtyp(bytes, box) {
    if (box.type !== 'ftyp') fail('corrupt');
    const payload = box.size - box.header;
    if (payload < 8 || payload > 1024) fail('corrupt');
    const major = tagAt(bytes, box.dataStart);
    if (!major) fail('corrupt');
    // Строка бренда не должна быть мусором из переименованного файла.
    if (!/^[A-Za-z0-9 ._-]{4}$/.test(major)) fail('corrupt');
  }

  function result(fileSize, moov) {
    return {
      container: 'mp4',
      fileSize,
      hasVideo: moov.videoTracks > 0,
      videoTracks: moov.videoTracks,
      audioTracks: moov.audioTracks,
      encrypted: !!moov.encrypted,
    };
  }

  // Полный разбор уже прочитанного файла: удобен конвертеру, у которого
  // исходник и так лежит в ArrayBuffer.
  function parse(bytes) {
    if (!bytes || !bytes.length) fail('corrupt');
    let offset = 0;
    let ftyp = null;
    let moov = null;
    let mediaData = 0;
    let count = 0;
    while (offset < bytes.length) {
      const box = boxHeader(bytes, offset, bytes.length);
      count++;
      if (!ftyp) {
        checkFtyp(bytes, box);
        ftyp = box;
      } else if (box.type === 'ftyp') {
        fail('corrupt');
      } else if (box.type === 'moov') {
        if (moov) fail('corrupt');
        moov = inspectMoov(bytes, box.dataStart, box.end);
      } else if (box.type === 'mdat') {
        if (!box.size) fail('corrupt');
        mediaData++;
      }
      offset = box.end;
    }
    if (!count || !ftyp) fail('corrupt');
    if (!moov) fail('corrupt');
    if (!mediaData) fail('corrupt');
    return result(bytes.length, moov);
  }

  function readSlice(file, offset, length) {
    return file
      .slice(offset, offset + length)
      .arrayBuffer()
      .then((buffer) => new Uint8Array(buffer));
  }

  // Проверка File без чтения mdat: читаются только заголовки и moov.
  // Так проверяется и файл, у которого moov записан в конец.
  async function inspectFile(file) {
    if (!file || typeof file.size !== 'number' || !file.size) fail('corrupt');
    const total = file.size;
    let offset = 0;
    let ftyp = null;
    let moov = null;
    let mediaData = 0;
    while (offset < total) {
      const head = await readSlice(file, offset, Math.min(16, total - offset));
      if (head.length < 8) fail('corrupt');
      const size32 = u32(head, 0);
      const type = tagAt(head, 4);
      if (!type) fail('corrupt');
      let header = 8;
      let size = size32;
      if (size32 === 1) {
        if (head.length < 16) fail('corrupt');
        size = u64(head, 8);
        header = 16;
      } else if (size32 === 0) {
        size = total - offset;
      }
      if (size < header || offset + size > total) fail('corrupt');

      if (!ftyp) {
        if (type !== 'ftyp' || size - header < 8 || size - header > 1024) {
          fail('corrupt');
        }
        const payload = await readSlice(file, offset + header, size - header);
        checkFtyp(payload, {
          type,
          size: payload.length,
          header: 0,
          dataStart: 0,
        });
        ftyp = { type, size };
      } else if (type === 'ftyp') {
        fail('corrupt');
      } else if (type === 'moov') {
        if (moov) fail('corrupt');
        const payloadSize = size - header;
        if (payloadSize > MAX_MOOV_BYTES) fail('limit');
        const payload = await readSlice(file, offset + header, payloadSize);
        if (payload.length !== payloadSize) fail('corrupt');
        moov = inspectMoov(payload, 0, payload.length);
      } else if (type === 'mdat') {
        if (size <= header) fail('corrupt');
        mediaData++;
      }
      offset += size;
    }
    if (!ftyp || !moov) fail('corrupt');
    if (!mediaData) fail('corrupt');
    return result(total, moov);
  }

  root.VK7TV_MP4_PARSE = { LIMITS, parse, inspectFile };
})(typeof self !== 'undefined' ? self : globalThis);
