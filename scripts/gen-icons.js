// Generates /public/icons/icon-192.png and icon-512.png (campfire emoji on dark rounded square).
// Zero dependencies — hand-encodes PNGs with zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function roundedSquare(size, radius, rgb) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      // crude rounded corner: cut circles at corners
      let a = 255;
      const cx = radius - 1 - x, cy = radius - 1 - y;
      const corners = [
        [x, y, radius], [size - 1 - x, y, radius],
        [x, size - 1 - y, radius], [size - 1 - x, size - 1 - y, radius],
      ];
      // inside corner circle check
      const inCorner = (qx, qy) => qx < radius && qy < radius && (radius - 1 - qx) ** 2 + (radius - 1 - qy) ** 2 > radius * radius;
      if (inCorner(x, y) || inCorner(size - 1 - x, y) || inCorner(x, size - 1 - y) || inCorner(size - 1 - x, size - 1 - y)) a = 0;
      // warm radial glow in the middle (campfire vibe)
      const nx = (x / size - 0.5), ny = (y / size - 0.52);
      const d = Math.sqrt(nx * nx + ny * ny);
      const glow = Math.max(0, 1 - d * 2.2);
      const i = (y * size + x) * 4;
      px[i] = Math.round(rgb[0] + (250 - rgb[0]) * glow * 0.55);
      px[i + 1] = Math.round(rgb[1] + (140 - rgb[1]) * glow * 0.45);
      px[i + 2] = Math.round(rgb[2] + (60 - rgb[2]) * glow * 0.35);
      px[i + 3] = a;
      // flame dot in center
      const fd = Math.sqrt((x / size - 0.5) ** 2 + (y / size - 0.42) ** 2);
      if (fd < 0.13) { px[i] = 255; px[i + 1] = 150; px[i + 2] = 60; }
      if (fd < 0.06) { px[i] = 255; px[i + 1] = 220; px[i + 2] = 150; }
    }
  }
  return px;
}

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
function encodePNG(size) {
  const raw = roundedSquare(size, Math.round(size * 0.22), [88, 101, 242]);
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]));
    rows.push(raw.subarray(y * size * 4, (y + 1) * size * 4));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), encodePNG(192));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), encodePNG(512));
console.log('icons written to', outDir);
