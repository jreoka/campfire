// Intrinsic pixel size of an image, read from its own header.
//
// A chat picture needs its SHAPE before its bytes arrive: the client reserves
// the box with width/height attributes so the conversation doesn't collapse to
// nothing and then shove itself as the picture pops in. That makes a header
// parse the right tool — it costs microseconds, needs no ffmpeg, never decodes
// a pixel, and (unlike a guess) is exact.
//
// JPEG, PNG, GIF, WebP and BMP are what people actually post. Anything else
// (AVIF, HEIC, TIFF, SVG, RAW, a corrupt file) answers null and simply gets no
// reservation: a WRONG shape is worse than no shape, and the client falls back
// to learning the size from the image itself once it paints.
//
// Both callers hand in a bounded head of the file (see HEAD_BYTES): every
// format here declares its size within the first handful of bytes except JPEG,
// whose SOF marker sits behind whatever EXIF the camera wrote.
'use strict';

// Enough for the formats above, EXIF and all. A size past this is not a chat
// picture; the backfill keeps its ranged GETs small on purpose.
const HEAD_BYTES = 256 * 1024;

// No real image is wider or taller than this. Anything past it is a misparse
// (or a decompression bomb), and a bogus shape is exactly what this module
// exists to avoid — so it is refused rather than clamped.
const MAX_DIM = 65535;

const ok = (w, h) => {
  const W = Number(w) || 0, H = Number(h) || 0;
  if (W < 1 || H < 1 || W > MAX_DIM || H > MAX_DIM) return null;
  return { w: W, h: H };
};

// PNG: 8-byte signature, then the IHDR chunk — length(4) type(4) width(4) height(4).
function png(b, o) {
  if (b.length < o + 24) return null;
  if (b.readUInt32BE(o + 12) !== 0x49484452) return null; // 'IHDR' must be first
  return ok(b.readUInt32BE(o + 16), b.readUInt32BE(o + 20));
}

// GIF: logical screen descriptor right after the 6-byte signature (LE).
function gif(b, o) {
  if (b.length < o + 10) return null;
  return ok(b.readUInt16LE(o + 6), b.readUInt16LE(o + 8));
}

// BMP: BITMAPINFOHEADER width/height at 18/22 (LE, height may be negative for a
// top-down bitmap).
function bmp(b, o) {
  if (b.length < o + 26) return null;
  return ok(b.readInt32LE(o + 18), Math.abs(b.readInt32LE(o + 22)));
}

// JPEG: walk the marker segments to the frame header. Standalone markers carry
// no length; SOF0-15 do, and C4/C8/CC are DHT/JPG/DAC wearing a SOF number.
function jpeg(b, o) {
  let i = o + 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }        // resync on padding/fill bytes
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }           // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      // SOF: len(2) precision(1) height(2) width(2)
      return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    }
    i += 2 + len;
  }
  return null; // the frame header is past the head we were given
}

// WebP: RIFF container, three possible bitstreams under one shape.
function webp(b, o) {
  if (b.length < o + 30) return null;
  const fourcc = String(b.toString('latin1', o + 12, o + 16));
  if (fourcc === 'VP8X') {
    // flags(4) then the canvas size MINUS ONE, 24-bit LE each.
    return ok(b.readUIntLE(o + 24, 3) + 1, b.readUIntLE(o + 27, 3) + 1);
  }
  if (fourcc === 'VP8 ') {
    // frame tag(3) start code 9d 01 2a(3) then 14-bit width, 14-bit height.
    if (b[o + 23] !== 0x9d || b[o + 24] !== 0x01 || b[o + 25] !== 0x2a) return null;
    return ok(b.readUInt16LE(o + 26) & 0x3fff, b.readUInt16LE(o + 28) & 0x3fff);
  }
  if (fourcc === 'VP8L') {
    if (b[o + 20] !== 0x2f) return null; // lossless signature
    const bits = b.readUInt32LE(o + 21);
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

// The size of an image whose head is in `buf`, or null when this module does not
// recognise the format (never a guess). Only the head is ever looked at, so a
// mislabeled 50 MB video cannot make this walk a whole file.
function dimsFromBuffer(buf) {
  const all = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const b = all.length > HEAD_BYTES ? all.subarray(0, HEAD_BYTES) : all;
  if (b.length < 12) return null; // enough for every signature below
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return png(b, 0);
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b, 0);
  const six = b.toString('latin1', 0, 6);
  if (six === 'GIF87a' || six === 'GIF89a') return gif(b, 0);
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return webp(b, 0);
  if (b[0] === 0x42 && b[1] === 0x4d) return bmp(b, 0);
  return null;
}

// The same answer for a file on disk, reading only its head.
async function dimsFromFile(fs, filePath, headBytes = HEAD_BYTES) {
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(headBytes);
    const { bytesRead } = await fh.read(buf, 0, headBytes, 0);
    return dimsFromBuffer(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    try { if (fh) await fh.close(); } catch {}
  }
}

module.exports = { dimsFromBuffer, dimsFromFile, HEAD_BYTES, MAX_DIM };
