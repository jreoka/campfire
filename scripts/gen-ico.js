// Generates app/src-tauri/icons/icon.ico from public/icons/icon-512.png.
// Zero dependencies: decodes the source PNG (zlib is built-in), fills the
// campfire mark's enclosed regions (the mark is hollow line art), colors the
// fill from the nearest stroke pixel, tiles onto solid deep-navy, and writes
// a classic multi-size ICO (BMP entries — RC.EXE-compatible, unlike
// PNG-wrapped ICOs).
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

// Fill the mark's enclosed regions: the stroke is dashed line art, so first
// dilate it (radius 10) to close the gaps, then flood the exterior from (0,0)
// through non-stroke pixels; everything not reached is interior and gets filled.
function fillMask({ w, h, px }, threshold) {
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = px[i * 4 + 3] > threshold ? 1 : 0;
  for (let p = 0; p < 10; p++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) hit = 1;
          }
        }
        next[y * w + x] = hit;
      }
    }
    mask = next;
  }
  const ext = new Uint8Array(w * h);
  const stack = [0];
  ext[0] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (ext[j] || mask[j]) continue;
      ext[j] = 1;
      stack.push(j);
    }
  }
  for (let i = 0; i < w * h; i++) if (!ext[i]) mask[i] = 1;
  return mask;
}

// Multi-source BFS from stroke pixels: each fill pixel takes the nearest
// stroke pixel's composited color.
function fillColor({ w, h, px }, mask, bg) {
  const N = w * h;
  const color = new Uint32Array(N); // 0xRRGGBB
  const dist = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    if (px[i * 4 + 3] > 16) {
      dist[i] = 0;
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      color[i] = (r << 16) | (g << 8) | b;
      queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w, y = (i / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (dist[j] !== -1) continue;
      dist[j] = dist[i] + 1;
      color[j] = color[i];
      queue[qt++] = j;
    }
  }
  // Build the final opaque tile: filled regions get stroke colors, rest gets bg.
  const tile = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    if (mask[i] && dist[i] !== -1) {
      const c = color[i];
      tile[i * 4] = (c >> 16) & 0xff;
      tile[i * 4 + 1] = (c >> 8) & 0xff;
      tile[i * 4 + 2] = c & 0xff;
    } else {
      tile[i * 4] = bg[0]; tile[i * 4 + 1] = bg[1]; tile[i * 4 + 2] = bg[2];
    }
    tile[i * 4 + 3] = 255;
  }
  return tile;
}

// Bilinear scale to size x size.
function scaleTo({ w, h, px }, size) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const fy = (y + 0.5) * (h / size);
    const y0 = Math.min(h - 1, Math.floor(fy));
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) * (w / size);
      const x0 = Math.min(w - 1, Math.floor(fx));
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = px[i00 + c] * (1 - tx) + px[i01 + c] * tx;
        const bot = px[i10 + c] * (1 - tx) + px[i11 + c] * tx;
        out[(y * size + x) * 4 + c] = Math.round(top * (1 - ty) + bot * ty);
      }
    }
  }
  return out;
}

// One classic ICO image entry: BITMAPINFOHEADER + bottom-up BGRA + zero AND mask.
function icoEntry(w, h, rgbaTopDown) {
  const andRowBytes = Math.ceil(w / 32) * 4; // AND mask rows padded to 32-bit boundaries
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

// ICO header: count at 4, 16-byte directory entries (offset field at byte 10).
function writeIco(sizes, tiled) {
  const entries = sizes.map((s) => icoEntry(s, s, scaleTo(tiled, s)));
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
    // color count (2) + reserved (3) stay zero
    dir.writeUInt16LE(1, 4); // planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(e.length, 8); // bytes in resource
    dir.writeUInt32LE(off, 12); // image offset
    e.copy(out, off);
    off += e.length;
  });
  return out;
}

const src = path.join(__dirname, '..', 'public', 'icons', 'icon-512.png');
const out = path.join(__dirname, '..', 'app', 'src-tauri', 'icons', 'icon.ico');
const BG = [0x0e, 0x12, 0x18]; // --bg deep navy, matches the app surface
const img = decodePng(fs.readFileSync(src));
const mask = fillMask(img, 64);
const tile = fillColor(img, mask, BG);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, writeIco([16, 32, 48, 256], { w: img.w, h: img.h, px: tile }));
console.log(`icon.ico written (${fs.statSync(out).size} bytes) from ${path.basename(src)} (${img.w}x${img.h})`);
