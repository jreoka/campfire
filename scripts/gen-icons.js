// Generates /public/icons/icon-192.png and icon-512.png — flat campfire mark.
// Zero dependencies — hand-rasterized with 2x supersampling, hand-encoded PNGs.
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

const dist2 = (x1, y1, x2, y2) => { const dx = x1 - x2, dy = y1 - y2; return dx * dx + dy * dy; };
// capsule (thick segment) test for logs
function inCapsule(x, y, x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy || 1;
  let t = ((x - x1) * dx + (y - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return dist2(x, y, x1 + t * dx, y1 + t * dy) <= r * r;
}

function renderCampfire(size) {
  const SS = 2, S = size * SS;
  const px = Buffer.alloc(S * S * 4);
  const cx = S / 2, u = S / 100; // unit
  const R = S * 0.24;
  const ORANGE = [255, 107, 53], AMBER = [255, 179, 0], CORE = [255, 224, 130];
  const LOG1 = [141, 110, 99], LOG2 = [109, 76, 65], LOGEND = [62, 39, 35];
  const STONE = [130, 134, 139], STONE_D = [105, 109, 114];
  const BG = [14, 17, 16];

  const flame = (x, y) => {
    const at = (dx, dy, r) => dist2(x, y, cx + dx * u, (54 - dy) * u) <= (r * u) ** 2;
    // innermost first so layers nest instead of hiding each other
    const core = [[0, 26, 5.2], [0, 20, 3.6], [0.5, 15.5, 2.2]];
    for (const [dx, dy, r] of core) if (at(dx, dy, r)) return CORE;
    const mid = [[0, 24, 9], [-5.5, 28.5, 7], [5.5, 28.5, 7], [0, 15, 6.4], [0.8, 7, 4.2], [1.5, 1, 2.5]];
    for (const [dx, dy, r] of mid) if (at(dx, dy, r)) return AMBER;
    const outer = [[0, 22, 13.5], [-7.5, 27, 9.5], [7.5, 27, 9.5], [0, 12, 10], [-4, 4, 6.8], [4, 4, 6.8], [1, -3, 5], [2, -9, 3.2], [2.5, -13.5, 1.7]];
    for (const [dx, dy, r] of outer) if (at(dx, dy, r)) return ORANGE;
    return null;
  };
  // log endpoints for capsule segments (unit space, y down from top)
  const rad = (d) => (d * Math.PI) / 180;
  const seg = (angDeg, len) => {
    const a = rad(angDeg), hl = len / 2;
    return [cx - Math.cos(a) * hl * u, 68 * u + Math.sin(a) * hl * u, cx + Math.cos(a) * hl * u, 68 * u - Math.sin(a) * hl * u];
  };
  const backLog = seg(-16, 46), frontLog = seg(16, 46);
  const stones = [[-30, 74, 8, 6.4], [-15, 78, 8.6, 6.8], [0, 79, 8.6, 6.8], [15, 78, 8.6, 6.8], [30, 74, 8, 6.4]];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const inR = !(x < R && y < R && (R - x) ** 2 + (R - y) ** 2 > R * R)
        && !(x > S - 1 - R && y < R && (x - (S - R)) ** 2 + (R - y) ** 2 > R * R)
        && !(x < R && y > S - 1 - R && (R - x) ** 2 + (y - (S - R)) ** 2 > R * R)
        && !(x > S - 1 - R && y > S - 1 - R && (x - (S - R)) ** 2 + (y - (S - R)) ** 2 > R * R);
      let col = BG, a = inR ? 255 : 0;
      if (inR) {
        // back stones
        for (let s = 0; s < stones.length; s++) {
          const [dx, dy, rx, ry] = stones[s];
          const ex = (x - (cx + dx * u)) / (rx * u), ey = (y - dy * u) / (ry * u);
          if (ex * ex + ey * ey <= 1) { col = s % 2 ? STONE_D : STONE; break; }
        }
        // back log
        if (inCapsule(x, y, ...backLog, 3.4 * u)) col = LOG2;
        // flame
        const f = flame(x, y);
        if (f) col = f;
        // front log + end cap
        if (inCapsule(x, y, ...frontLog, 3.6 * u)) col = LOG1;
        const ex = frontLog[2], ey = frontLog[3]; // right end cap
        if (dist2(x, y, ex, ey) <= (3.6 * u) ** 2) col = LOGEND;
      }
      const i = (y * S + x) * 4;
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = a;
    }
  }
  // box downsample 2x
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, al = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
        const i = (((y * SS + dy) * S) + (x * SS + dx)) * 4;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; al += px[i + 3];
      }
      const o = (y * size + x) * 4, n = SS * SS;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = al / n;
    }
  }
  return out;
}

function encodePNG(size) {
  const raw = renderCampfire(size);
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]));
    rows.push(raw.subarray(y * size * 4, (y + 1) * size * 4));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), encodePNG(192));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), encodePNG(512));
console.log('campfire icons written to', outDir);
