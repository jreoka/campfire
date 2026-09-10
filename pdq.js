// PDQ perceptual image hashing — pure JS, zero dependencies.
//
// A faithful port of Meta/Thorn's PDQ reference implementation:
//   pdq/cpp/hashing/pdqhashing.cpp      (DCT + binarization + quality)
//   pdq/cpp/downscaling/downscaling.cpp (Jarosz box-filter pyramid + decimate)
//   pdq/cpp/hashing/torben.cpp          (median selection, public domain)
//   pdq/cpp/common/pdqhashtypes.{h,cpp} (256-bit layout + hex order)
// Reference: https://github.com/facebook/ThreatExchange/tree/main/pdq
//
// PDQ is the perceptual hash used by NCMEC's hash-sharing programme, Project
// Arachnid's Shield, IWF and the StopNCII/Thorn ecosystem, so hashes produced
// here are directly comparable to the hash lists those bodies publish.
//
// Why we're allowed to reimplement it: PDQ is BSD-licensed by Meta. The port
// exists because this project ships no native modules and no build step, and
// PDQ's own README warns that different *decoders* already produce hashes up
// to ~10 bits apart for the same image. Everything is therefore validated
// against the reference test vectors in scripts/test-pdq.js.
//
// Bit layout (identical to the reference):
//   bit k (0..255) lives in 16-bit word (k>>4) at bit (k&15).
//   Words are serialised big-endian, word 0 first -> 64 hex chars.
//
// API:
//   hashLuma(luma, rows, cols)  -> { hash:Uint8Array(32), quality:0..100 }
//   hashRgb(rgb, rows, cols)    -> same (rgb = RGB24 bytes)
//   hashRgbDihedral(...)        -> { hash, quality, dihedral:[8 hashes] }
//   hamming(a, b)               -> 0..256 bit distance
//   toHex(hash) / fromHex(hex)
'use strict';

const HASH_BYTES = 32;
// Reference constants (pdqhashing.cpp).
const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114;
const MIN_HASHABLE_DIM = 5;
const JAROSZ_XY_PASSES = 2;
// PDQ's documented defaults (pdq/README.md "Matching"):
//   distance <= 31 => similar, quality <= 49 => discard as featureless.
const MATCH_DISTANCE = 31;
const QUALITY_FLOOR = 49;

// 16x64 DCT-II basis: D[i][j] = sqrt(2/64) * cos((pi/128) * (i+1) * (2j+1)).
// Note there is no 1/sqrt(2) special case for row 0 in the reference.
const DCT_MATRIX = (() => {
  const scale = Math.sqrt(2.0 / 64);
  const m = new Float64Array(16 * 64);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 64; j++) {
      m[i * 64 + j] = scale * Math.cos((Math.PI / 2.0 / 64) * (i + 1) * (2 * j + 1));
    }
  }
  return m;
})();

// ---------- hex / bit plumbing ----------

function toHex(hash) {
  let s = '';
  for (let i = 0; i < HASH_BYTES; i++) s += hash[i].toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex) {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  const out = new Uint8Array(HASH_BYTES);
  for (let i = 0; i < HASH_BYTES; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// bit k -> byte/bit position in the 32-byte big-endian serialisation
// (see pdqhashtypes.h:setBit + the "%04hx" x16 hex dump).
function setBit(hash, k) {
  const w = k >> 4;
  const b = k & 15;
  const byte = 2 * w + (b >= 8 ? 0 : 1);
  hash[byte] |= 1 << (b & 7);
}

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < HASH_BYTES; i++) d += POPCOUNT[a[i] ^ b[i]];
  return d;
}

const EMPTY_HASH = new Uint8Array(HASH_BYTES);

// ---------- luma ----------

// RGB24 bytes (rows*cols*3) -> float luma plane. Matches fillFloatLumaFromRGB.
function lumaFromRgb(rgb, rows, cols) {
  const n = rows * cols;
  const luma = new Float64Array(n);
  for (let p = 0, i = 0; i < n; i++, p += 3) {
    luma[i] = LUMA_R * rgb[p] + LUMA_G * rgb[p + 1] + LUMA_B * rgb[p + 2];
  }
  return luma;
}

// ---------- Jarosz box filter (downscaling.cpp) ----------

// One pass of a 1-D sliding-window box filter along a strided vector.
function box1D(inv, outv, inOff, outOff, vectorLength, stride, fullWindowSize) {
  const halfWindowSize = (fullWindowSize + 2) >> 1; // 7->4, 8->5
  const phase1 = halfWindowSize - 1;
  const phase2 = fullWindowSize - halfWindowSize + 1;
  const phase3 = vectorLength - fullWindowSize;
  const phase4 = halfWindowSize - 1;

  let li = 0, ri = 0, oi = 0;
  let sum = 0, currentWindowSize = 0;

  for (let i = 0; i < phase1; i++) { sum += inv[inOff + ri]; currentWindowSize++; ri += stride; }
  for (let i = 0; i < phase2; i++) {
    sum += inv[inOff + ri]; currentWindowSize++;
    outv[outOff + oi] = sum / currentWindowSize;
    ri += stride; oi += stride;
  }
  for (let i = 0; i < phase3; i++) {
    sum += inv[inOff + ri]; sum -= inv[inOff + li];
    outv[outOff + oi] = sum / currentWindowSize;
    li += stride; ri += stride; oi += stride;
  }
  for (let i = 0; i < phase4; i++) {
    sum -= inv[inOff + li]; currentWindowSize--;
    outv[outOff + oi] = sum / currentWindowSize;
    li += stride; oi += stride;
  }
}

// X,Y,X,Y passes of 1-D box filters == one 2-D tent filter.
function jaroszFilter(buf1, buf2, numRows, numCols, windowRows, windowCols, reps) {
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < numRows; i++) box1D(buf1, buf2, i * numCols, i * numCols, numCols, 1, windowRows);
    for (let j = 0; j < numCols; j++) box1D(buf2, buf1, j, j, numRows, numCols, windowCols);
  }
}

function computeJaroszFilterWindowSize(oldDimension, newDimension) {
  return Math.floor((oldDimension + 2 * newDimension - 1) / (2 * newDimension));
}

// Sample at pixel centres, not corners (decimateFloat).
function decimate(inBuf, inRows, inCols, outRows, outCols) {
  const out = new Float64Array(outRows * outCols);
  for (let oi = 0; oi < outRows; oi++) {
    const ini = Math.floor(((oi + 0.5) * inRows) / outRows);
    for (let oj = 0; oj < outCols; oj++) {
      const inj = Math.floor(((oj + 0.5) * inCols) / outCols);
      out[oi * outCols + oj] = inBuf[ini * inCols + inj];
    }
  }
  return out;
}

// Reproduces pdqFloat256FromFloatLuma's downscale + quality steps.
function downsampleTo64(luma, rows, cols) {
  let buf1, buf64;
  if (rows === 64 && cols === 64) {
    buf64 = new Float64Array(luma); // already 64x64 (e.g. pre-scaled video frames)
  } else {
    buf1 = new Float64Array(luma); // jaroszFilterFloat mutates buffer1 in place
    const buf2 = new Float64Array(rows * cols);
    const winRows = computeJaroszFilterWindowSize(cols, 64);
    const winCols = computeJaroszFilterWindowSize(rows, 64);
    jaroszFilter(buf1, buf2, rows, cols, winRows, winCols, JAROSZ_XY_PASSES);
    buf64 = decimate(buf1, rows, cols, 64, 64);
  }
  return buf64;
}

// Sum of significant gradients, scaled. Higher = more structure. (pdqImageDomainQualityMetric)
function qualityMetric(buf64x64) {
  let gradientSum = 0;
  for (let i = 0; i < 63; i++) {
    for (let j = 0; j < 64; j++) {
      const u = buf64x64[i * 64 + j];
      const v = buf64x64[(i + 1) * 64 + j];
      gradientSum += Math.abs(Math.trunc(((u - v) * 100) / 255));
    }
  }
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 63; j++) {
      const u = buf64x64[i * 64 + j];
      const v = buf64x64[i * 64 + j + 1];
      gradientSum += Math.abs(Math.trunc(((u - v) * 100) / 255));
    }
  }
  const q = Math.trunc(gradientSum / 90);
  return q > 100 ? 100 : q;
}

// Only slots (1..16)x(1..16) of the full 64x64 DCT are needed (dct64To16).
function dct64To16(buf64) {
  const T = new Float64Array(16 * 64);
  for (let i = 0; i < 16; i++) {
    const di = i * 64;
    for (let j = 0; j < 64; j++) {
      let sum = 0;
      for (let k = 0; k < 64; k++) sum += DCT_MATRIX[di + k] * buf64[k * 64 + j];
      T[i * 64 + j] = sum;
    }
  }
  const B = new Float64Array(16 * 16);
  for (let i = 0; i < 16; i++) {
    const ti = i * 64;
    for (let j = 0; j < 16; j++) {
      const dj = j * 64;
      let sum = 0;
      for (let k = 0; k < 64; k++) sum += T[ti + k] * DCT_MATRIX[dj + k];
      B[i * 16 + j] = sum;
    }
  }
  return B;
}

// Exact median selection (torben.cpp — public domain, Mogensen/Devillard).
// Returns an element of the array, not an average, which is load-bearing:
// PDQ sets a bit only when the coefficient is strictly greater.
function torben(m, n) {
  let min = m[0], max = m[0];
  for (let i = 1; i < n; i++) {
    if (m[i] < min) min = m[i];
    if (m[i] > max) max = m[i];
  }
  // NB: less/greater/equal are read after the loop, exactly as in the
  // original C (where they are function-scoped, not loop-scoped).
  let guess = 0, maxLtGuess = min, minGtGuess = max;
  let less = 0, greater = 0, equal = 0;
  for (;;) {
    guess = (min + max) / 2;
    less = 0; greater = 0; equal = 0;
    maxLtGuess = min;
    minGtGuess = max;
    for (let i = 0; i < n; i++) {
      if (m[i] < guess) {
        less++;
        if (m[i] > maxLtGuess) maxLtGuess = m[i];
      } else if (m[i] > guess) {
        greater++;
        if (m[i] < minGtGuess) minGtGuess = m[i];
      } else equal++;
    }
    if (less <= (n + 1) / 2 && greater <= (n + 1) / 2) break;
    else if (less > greater) max = maxLtGuess;
    else min = minGtGuess;
  }
  if (less >= (n + 1) / 2) return maxLtGuess;
  if (less + equal >= (n + 1) / 2) return guess;
  return minGtGuess;
}

// dctOutput16x16 -> 256 bits by thresholding against the median (pdqBuffer16x16ToBits).
function bitsFromDct(dct) {
  const median = torben(dct, 16 * 16);
  const hash = new Uint8Array(HASH_BYTES);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      if (dct[i * 16 + j] > median) setBit(hash, i * 16 + j);
    }
  }
  return hash;
}

// ---------- dihedral (rotation/flip) variants ----------
// The reference derives these from the 16x16 DCT in the frequency domain (cheap)
// rather than re-hashing rotated pixels (expensive, and lossy for odd sizes).

function dihedralDcts(dct) {
  const at = (i, j) => dct[i * 16 + j];
  const rot90 = new Float64Array(256), rot180 = new Float64Array(256), rot270 = new Float64Array(256);
  const flipX = new Float64Array(256), flipY = new Float64Array(256);
  const flipPlus = new Float64Array(256), flipMinus = new Float64Array(256);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      const v = at(i, j);
      rot90[j * 16 + i] = (j & 1) ? v : -v;
      rot180[i * 16 + j] = ((i + j) & 1) ? -v : v;
      rot270[j * 16 + i] = (i & 1) ? v : -v;
      flipX[i * 16 + j] = (i & 1) ? v : -v;
      flipY[i * 16 + j] = (j & 1) ? v : -v;
      flipPlus[j * 16 + i] = v;
      flipMinus[j * 16 + i] = ((i + j) & 1) ? -v : v;
    }
  }
  return [rot90, rot180, rot270, flipX, flipY, flipPlus, flipMinus];
}

// ---------- public entry points ----------

function hashFromLumaCore(luma, rows, cols) {
  if (rows < MIN_HASHABLE_DIM || cols < MIN_HASHABLE_DIM) {
    return { hash: EMPTY_HASH, quality: 0, dct: null };
  }
  const buf64 = downsampleTo64(luma, rows, cols);
  const quality = qualityMetric(buf64);
  const dct = dct64To16(buf64);
  return { hash: bitsFromDct(dct), quality, dct };
}

// luma: Float64Array/Float32Array of rows*cols values (0..255-ish).
function hashLuma(luma, rows, cols) {
  const r = hashFromLumaCore(luma, rows, cols);
  return { hash: r.hash, quality: r.quality };
}

// rgb: Buffer/Uint8Array of RGB24 bytes, rows*cols*3 long.
function hashRgb(rgb, rows, cols) {
  return hashLuma(lumaFromRgb(rgb, rows, cols), rows, cols);
}

// Same as hashRgb but also returns the 7 dihedral variants, so a rotated or
// mirrored re-upload still matches a reference hash. `dihedral` holds
// [rot90, rot180, rot270, flipX, flipY, flipPlus1, flipMinus1].
function hashRgbDihedral(rgb, rows, cols) {
  const core = hashFromLumaCore(lumaFromRgb(rgb, rows, cols), rows, cols);
  if (!core.dct) return { hash: core.hash, quality: core.quality, dihedral: [] };
  return { hash: core.hash, quality: core.quality, dihedral: dihedralDcts(core.dct).map(bitsFromDct) };
}

// Convenience: reference hashes are usually `hashOf(gray64x64)` in tests.
function hashLumaDirect(buf64) {
  const quality = qualityMetric(buf64);
  const dct = dct64To16(buf64);
  return { hash: bitsFromDct(dct), quality };
}

module.exports = {
  toHex, fromHex, hamming, setBit,
  lumaFromRgb, hashLuma, hashRgb, hashRgbDihedral, hashLumaDirect,
  // internals exposed for tests / tuning
  downsampleTo64, qualityMetric, dct64To16, torben, bitsFromDct,
  MATCH_DISTANCE, QUALITY_FLOOR, HASH_BYTES,
};
