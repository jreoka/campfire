// Generates app/src-tauri/icons/icon.ico from public/icons/icon-512.png.
// Zero dependencies: decodes the source PNG (zlib is built-in), scales to
// 16/32/48/256 with nearest-neighbor, and writes a classic multi-size ICO
// (BMP entries — RC.EXE-compatible, unlike PNG-wrapped ICOs).
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

// Decode an 8-bit PNG (color type 2 = RGB, 6 = RGBA), non-interlaced.
function decodePng(buf) {
  let off = 8;
  let w = 0, h = 0, bitdepth = 0, ct = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString('latin1', off, off + 4); off += 4;
    const data = buf.subarray(off, off + len); off += len + 4; // +4 crc
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitdepth = data[8]; ct = data[9]; interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  if (bitdepth !== 8 || interlace !== 0) throw new Error('only 8-bit non-interlaced PNG supported');
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : ct === 6 ? 4 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const prevRow = y > 0 ? raw.subarray(rowStart - (stride + 1) + 1, rowStart) : null;
    for (let x = 0; x < w; x++) {
      const ci = x * channels;
      for (let c = 0; c < channels; c++) {
        const cur = row[ci + c];
        const a = x > 0 ? row[ci + c - channels] : 0;
        const b = prevRow ? prevRow[ci + c] : 0;
        const cc = (x > 0 && prevRow) ? prevRow[ci + c - channels] : 0;
        let recon = cur;
        if (filter === 1) recon = (cur + a) & 0xff;
        else if (filter === 2) recon = (cur + b) & 0xff;
        else if (filter === 3) recon = (cur + ((a + b) >> 1)) & 0xff;
        else if (filter === 4) {
          const p = a + b - cc;
          const pa = Math.abs(a - b), pb = Math.abs(b - cc), pc = Math.abs(a - b - cc);
          const q = pa <= pb && pa <= pc ? a : (pb <= pc ? b : cc);
          recon = (cur + q) & 0xff;
        }
        px[(y * w + x) * 4 + c] = recon;
      }
    }
  }
  return { w, h, px };
}

// Nearest-neighbor scale to size x size.
function scaleTo({ w, h, px }, size) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / size));
      const si = (sy * w + sx) * 4, di = (y * size + x) * 4;
      out[di] = px[si]; out[di + 1] = px[si + 1]; out[di + 2] = px[si + 2]; out[di + 3] = px[si + 3];
    }
  }
  return out;
}

// One classic ICO image entry: BITMAPINFOHEADER + bottom-up BGRA + zero AND mask.
function icoEntry(w, h, rgbaTopDown) {
  const andRowBytes = Math.ceil(w / 8);
  const sizeImage = w * h * 4 + h * andRowBytes;
  const data = Buffer.alloc(40 + sizeImage);
  data.writeUInt32LE(40, 0);          // biSize
  data.writeInt32LE(w, 4);            // biWidth
  data.writeInt32LE(h * 2, 8);        // biHeight (XOR + AND)
  data.writeUInt16LE(1, 12);          // planes
  data.writeUInt16LE(32, 14);         // bpp
  data.writeUInt32LE(sizeImage, 20);  // biSizeImage
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y; // bottom-up
    for (let x = 0; x < w; x++) {
      const si = (srcRow * w + x) * 4;
      const di = 40 + y * w * 4 + x * 4;
      data[di] = rgbaTopDown[si + 2];   // B
      data[di + 1] = rgbaTopDown[si + 1]; // G
      data[di + 2] = rgbaTopDown[si];     // R
      data[di + 3] = rgbaTopDown[si + 3]; // A
    }
  }
  return data; // AND mask stays zero (fully opaque)
}

function writeIco(sizes, src) {
  const entries = sizes.map((s) => icoEntry(s, s, scaleTo(src, s)));
  const total = 6 + entries.length * 16 + entries.reduce((a, e) => a + e.length, 0);
  const out = Buffer.alloc(total);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(entries.length, 4);
  let off = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    const dir = out.subarray(6 + i * 16, 6 + i * 16 + 16);
    dir[0] = sizes[i] === 256 ? 0 : sizes[i];
    dir[1] = sizes[i] === 256 ? 0 : sizes[i];
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(e.length, 8);
    dir.writeUInt32LE(off, 12);
    e.copy(out, off);
    off += e.length;
  });
  return out;
}

const src = path.join(__dirname, '..', 'public', 'icons', 'icon-512.png');
const out = path.join(__dirname, '..', 'app', 'src-tauri', 'icons', 'icon.ico');
const img = decodePng(fs.readFileSync(src));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, writeIco([16, 32, 48, 256], img));
console.log(`icon.ico written (${fs.statSync(out).size} bytes) from ${path.basename(src)} (${img.w}x${img.h})`);
