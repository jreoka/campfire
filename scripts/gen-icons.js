// Derives all PWA/app icons from public/icons/campfire-logo.png (the single
// source of truth for the campfire mark) — zero dependencies.
//
// campfire-logo.png is the canonical artwork (transparent background). This
// script regenerates:
//   icon-192.png        transparent, area-resampled to 192x192  (manifest "any")
//   icon-512.png        transparent, 512x512                    (manifest "any")
//   icon-maskable-512.png  campfire mark centered at ~72% on the #1a1d29
//                       theme background (Android adaptive-icon safe zone)
//   apple-touch-icon.png   180x180 on the #1a1d29 theme background (iOS)
// Keeping the Dockerfile's `RUN node scripts/gen-icons.js` step is safe:
// it reproduces the committed icons instead of clobbering them with
// stale procedurally-drawn art.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  const table = crc32.t || (crc32.t = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Minimal PNG decoder: 8-bit, non-interlaced, truecolor(+alpha).
function decodePNG(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + file);
  let p = 8, w = 0, h = 0, colorType = 0, bitDepth = 0, interlace = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.subarray(p + 4, p + 8).toString('ascii');
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6))
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}): ${file}`);
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const cur = Buffer.alloc(stride);
    raw.copy(cur, 0, pos, pos + stride); pos += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const bUp = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = cur[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + bUp) & 0xff;
      else if (filter === 3) v = (v + ((a + bUp) >> 1)) & 0xff;
      else if (filter === 4) {
        const pA = Math.abs(bUp - c), pB = Math.abs(a - c), pC = Math.abs(a + bUp - 2 * c);
        const pr = pA <= pB && pA <= pC ? a : pB <= pC ? bUp : c;
        v = (v + pr) & 0xff;
      }
      cur[i] = v;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      px[o] = cur[s]; px[o + 1] = cur[s + 1]; px[o + 2] = cur[s + 2];
      px[o + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, px };
}

function encodePNG(w, h, px) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0]));
    rows.push(Buffer.from(px.subarray(y * w * 4, (y + 1) * w * 4)));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Area-average resample (crisp downscales, no ringing).
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw, yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * yRatio, y1 = y0 + yRatio;
    const ya = Math.floor(y0), yb = Math.min(Math.ceil(y1), sh);
    for (let x = 0; x < dw; x++) {
      const x0 = x * xRatio, x1 = x0 + xRatio;
      const xa = Math.floor(x0), xb = Math.min(Math.ceil(x1), sw);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = ya; sy < yb; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = xa; sx < xb; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const wt = wx * wy;
          const i = (sy * sw + sx) * 4;
          // Premultiplied accumulation so translucent edges stay clean.
          const sa = src[i + 3] / 255;
          r += src[i] * sa * wt; g += src[i + 1] * sa * wt; b += src[i + 2] * sa * wt;
          a += sa * wt; wsum += wt;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 1e-6) {
        out[o] = Math.min(255, Math.max(0, Math.round(r / a)));
        out[o + 1] = Math.min(255, Math.max(0, Math.round(g / a)));
        out[o + 2] = Math.min(255, Math.max(0, Math.round(b / a)));
        out[o + 3] = Math.min(255, Math.max(0, Math.round((a / wsum) * 255)));
      } else {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      }
    }
  }
  return out;
}

// Composite an RGBA layer over a solid background.
function compositeOver(bg, layer, lw, lh, size, dbl) {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255;
  }
  const off = Math.round((size - dbl) / 2);
  for (let y = 0; y < dbl; y++) {
    // Map destination box back onto the (already resampled) layer.
    const sy = Math.min(lh - 1, Math.floor((y / dbl) * lh));
    for (let x = 0; x < dbl; x++) {
      const sx = Math.min(lw - 1, Math.floor((x / dbl) * lw));
      const s = (sy * lw + sx) * 4;
      const sa = layer[s + 3] / 255;
      if (sa <= 0) continue;
      const o = ((y + off) * size + (x + off)) * 4;
      out[o] = Math.round(layer[s] * sa + out[o] * (1 - sa));
      out[o + 1] = Math.round(layer[s + 1] * sa + out[o + 1] * (1 - sa));
      out[o + 2] = Math.round(layer[s + 2] * sa + out[o + 2] * (1 - sa));
    }
  }
  return out;
}

const dir = path.join(__dirname, '..', 'public', 'icons');
const logoFile = path.join(dir, 'campfire-logo.png');
const { w: lw, h: lh, px: logo } = decodePNG(logoFile);
if (lw !== lh) throw new Error(`campfire-logo.png must be square, got ${lw}x${lh}`);

const THEME = [0x1a, 0x1d, 0x29]; // --bg / manifest theme_color

// Transparent "any" icons — the raw mark, matching favicon/home art.
fs.writeFileSync(path.join(dir, 'icon-512.png'), encodePNG(lw, lh, logo));
fs.writeFileSync(path.join(dir, 'icon-192.png'), encodePNG(192, 192, resample(logo, lw, lh, 192, 192)));

// Maskable: mark at 72% on the theme background (adaptive-icon safe zone).
const maskBox = Math.round(512 * 0.72);
const maskLayer = resample(logo, lw, lh, maskBox, maskBox);
fs.writeFileSync(
  path.join(dir, 'icon-maskable-512.png'),
  encodePNG(512, 512, compositeOver(THEME, maskLayer, maskBox, maskBox, 512, maskBox))
);

// Apple touch icon: 180x180 on the theme background.
const appleBox = Math.round(180 * 0.8);
const appleLayer = resample(logo, lw, lh, appleBox, appleBox);
fs.writeFileSync(
  path.join(dir, 'apple-touch-icon.png'),
  encodePNG(180, 180, compositeOver(THEME, appleLayer, appleBox, appleBox, 180, appleBox))
);

console.log('icons derived from campfire-logo.png ->', dir);
