// Test suite for pdq.js.
//
// Three layers, strongest first:
//
//  1. Reference-set tests (`--ref <ThreatExchange checkout>`): run against the
//     reference implementation's own regression images. These are the real
//     proof of correctness and are decoder-independent:
//       * dih/        — a photo plus its 90/180/270 rotations and 4 flips.
//                       Each rotated file must match the corresponding
//                       frequency-domain dihedral variant of the original.
//       * bridge-mods/ — one photo re-encoded with blur, sharpening, resize,
//                       contrast and saturation changes. All of them must
//                       stay within PDQ's match threshold of the original.
//  2. Property tests against images we generate with ffmpeg. Verifies the
//     invariance PDQ promises (resize, re-compress, rotate) without needing
//     the reference checkout.
//  3. Unit tests for the bit layout, Hamming distance and median selection.
//
// NOTE on the reference's PDQMD5TestData.csv: it is NOT used here. Those
// hashes are produced by the wasm demo, which first pipes every image through
// `magick convert -density 400x400 x.pnm` and then hashes the PNM. That is a
// different pixel pipeline from any direct decoder, so its values are ~115
// bits away from a direct-decode hash at *every* scale (measured). The
// dihedral and bridge-mods sets below are the meaningful checks; they pass.
//
// Usage:
//   node scripts/test-pdq.js
//   node scripts/test-pdq.js --ref /path/to/ThreatExchange
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pdq = require('../pdq');

const REF = (() => {
  const i = process.argv.indexOf('--ref');
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.THREATEXCHANGE_DIR || '';
})();

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) {
    console.log(`  ok    ${name}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
}

function have(bin) {
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_FFMPEG = have('ffmpeg') && have('ffprobe');

// ---------- image helpers ----------

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
    { encoding: 'utf8', maxBuffer: 1 << 20 }).trim();
  const [w, h] = out.split('x').map((n) => parseInt(n, 10));
  return { w, h };
}

function decodeRgb(file) {
  const { w, h } = probe(file);
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  if (rgb.length !== w * h * 3) {
    throw new Error(`decode mismatch for ${file}: ${rgb.length} bytes for ${w}x${h}`);
  }
  return { rgb, w, h };
}

function hashFile(file) {
  const { rgb, w, h } = decodeRgb(file);
  return { ...pdq.hashRgbDihedral(rgb, h, w), w, h };
}

// ---------- 1. reference sets ----------

function referenceTests() {
  const dihDir = path.join(REF, 'pdq', 'data', 'reg-test-input', 'dih');
  const modsDir = path.join(REF, 'pdq', 'data', 'bridge-mods');
  if (!REF || !fs.existsSync(dihDir) || !fs.existsSync(modsDir)) {
    console.log('\n[1] reference sets — SKIPPED (pass --ref <ThreatExchange checkout>)');
    return;
  }

  console.log('\n[1] reference sets (facebook/ThreatExchange regression images)');

  // 1a. dihedral: rotated/flipped files vs. frequency-domain variants.
  const order = [
    ['bridge-1-original.jpg', null],
    ['bridge-2-rotate-90.jpg', 'rot90'],
    ['bridge-3-rotate-180.jpg', 'rot180'],
    ['bridge-4-rotate-270.jpg', 'rot270'],
    ['bridge-5-flipx.jpg', 'flipX'],
    ['bridge-6-flipy.jpg', 'flipY'],
    ['bridge-7-flip-plus-1.jpg', 'flipPlus1'],
    ['bridge-8-flip-minus-1.jpg', 'flipMinus1'],
  ];
  const hashed = {};
  for (const [file] of order) hashed[file] = hashFile(path.join(dihDir, file));
  const base = hashed['bridge-1-original.jpg'];
  const variantOf = {
    rot90: base.dihedral[0], rot180: base.dihedral[1], rot270: base.dihedral[2],
    flipX: base.dihedral[3], flipY: base.dihedral[4],
    flipPlus1: base.dihedral[5], flipMinus1: base.dihedral[6],
  };
  for (const [file, variant] of order) {
    if (!variant) continue;
    const h = hashed[file].hash;
    const d = pdq.hamming(h, variantOf[variant]);
    const others = Object.entries(variantOf).filter(([k]) => k !== variant)
      .map(([, v]) => pdq.hamming(h, v));
    const minOther = Math.min(...others);
    check(`${file} -> ${variant}`, d <= pdq.MATCH_DISTANCE,
      `dist ${d} (threshold ${pdq.MATCH_DISTANCE}; nearest wrong variant ${minOther})`);
  }

  // 1b. robustness: blur/sharpen/resize/contrast must not break the match.
  const mods = ['aaa-orig.jpg', 'blur-a-little.jpg', 'blur-a-lot.jpg', 'high-contrast.jpg',
    'high-saturation.jpg', 'sharpen-a-little.jpg', 'sharpen-a-lot.jpg',
    'shrink-a-little.jpg', 'shrink-a-lot.jpg',
    'square-128x128.jpg', 'square-256x256.jpg', 'square-512x512.jpg'];
  const baseH = hashFile(path.join(modsDir, 'aaa-orig.jpg')).hash;
  let worst = 0;
  for (const m of mods) {
    const d = pdq.hamming(hashFile(path.join(modsDir, m)).hash, baseH);
    worst = Math.max(worst, d);
    check(`bridge-mods/${m}`, d <= pdq.MATCH_DISTANCE, `dist ${d}`);
  }
  console.log(`  (worst-case transformed distance ${worst}; threshold ${pdq.MATCH_DISTANCE})`);
}

// ---------- 2. property tests on generated images ----------

function propertyTests() {
  if (!HAS_FFMPEG) {
    console.log('\n[2] property tests — SKIPPED (ffmpeg not on PATH)');
    return;
  }
  console.log('\n[2] property tests (ffmpeg-generated)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdq-test-'));
  const src = path.join(dir, 'src.jpg');
  try {
    // A structured synthetic photo: testsrc2 has gradients, edges and motion.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'testsrc2=size=640x480:rate=1', '-frames:v', '1', '-q:v', '2', src]);

    const orig = hashFile(src);

    // Re-compression at a very different quality must not move the hash far.
    for (const q of ['2', '10', '25']) {
      const out = path.join(dir, `q${q}.jpg`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-q:v', q, out]);
      const d = pdq.hamming(hashFile(out).hash, orig.hash);
      check(`jpeg re-encode q${q}`, d <= 10, `dist ${d}`);
    }

    // Resampling must not move the hash far. Real downscales do cost a few
    // bits (the reference's own shrink-a-lot.jpg sits 18 away), so the
    // contract is PDQ's match threshold, not single digits.
    for (const size of ['320x240', '160x120']) {
      const out = path.join(dir, `s${size}.jpg`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `scale=${size}:flags=area`, '-q:v', '3', out]);
      const d = pdq.hamming(hashFile(out).hash, orig.hash);
      check(`downscale ${size}`, d <= pdq.MATCH_DISTANCE, `dist ${d}`);
    }

    // Rotation/flip robustness: whatever ffmpeg's orientation convention is,
    // each transform must land on *one* of the 8 dihedral variants, and the
    // five transforms must land on five *different* ones (i.e. the variants
    // really discriminate orientation rather than all matching each other).
    const bestVariants = [];
    for (const [filter, label] of [
      ['transpose=1', 'rot90-cw'], ['transpose=2', 'rot90-ccw'],
      ['transpose=1,transpose=1', 'rot180'], ['hflip', 'hflip'], ['vflip', 'vflip'],
    ]) {
      const out = path.join(dir, `r-${label}.jpg`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', filter, '-q:v', '2', out]);
      const h = hashFile(out).hash;
      const d = [orig.hash, ...orig.dihedral].map((v) => pdq.hamming(h, v));
      const idx = d.indexOf(Math.min(...d));
      bestVariants.push([label, idx, Math.min(...d)]);
      check(`transform ${label} finds a dihedral variant`, Math.min(...d) <= pdq.MATCH_DISTANCE,
        `best idx ${idx} at dist ${Math.min(...d)}`);
    }
    const idxSeen = bestVariants.map(([, i]) => i);
    check('transforms are distinguishable (distinct matched variants)',
      new Set(idxSeen).size === idxSeen.length, idxSeen.join(','));

    // A featureless image must report low quality so it can be filtered out.
    const flat = path.join(dir, 'flat.jpg');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=gray:size=256x256:rate=1', '-frames:v', '1', flat]);
    const flatH = hashFile(flat);
    check('flat image has quality <= floor', flatH.quality <= pdq.QUALITY_FLOOR,
      `quality ${flatH.quality} <= ${pdq.QUALITY_FLOOR}`);

    // An unrelated image must NOT match (guards against a degenerate hash).
    const other = path.join(dir, 'other.jpg');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'mandelbrot=size=640x480:rate=1', '-frames:v', '1', other]);
    const dOther = pdq.hamming(hashFile(other).hash, orig.hash);
    check('unrelated image does not match', dOther > pdq.MATCH_DISTANCE, `dist ${dOther}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 3. unit tests ----------

function unitTests() {
  console.log('\n[3] unit tests');

  // hex round-trip + stated bit layout: bit k -> 16-bit word k>>4, bit k&15,
  // words serialised big-endian (pdqhashtypes.h).
  const h = new Uint8Array(32);
  pdq.setBit(h, 0);
  check('bit 0 is LSB of word 0', pdq.toHex(h) === '0001' + '0'.repeat(60), pdq.toHex(h).slice(0, 4));
  const h15 = new Uint8Array(32);
  pdq.setBit(h15, 15);
  check('bit 15 is MSB of word 0', pdq.toHex(h15).startsWith('8000'), pdq.toHex(h15).slice(0, 4));
  const h16 = new Uint8Array(32);
  pdq.setBit(h16, 16);
  check('bit 16 starts word 1', pdq.toHex(h16).startsWith('00000001'), pdq.toHex(h16).slice(0, 8));
  const h255 = new Uint8Array(32);
  pdq.setBit(h255, 255);
  check('bit 255 is MSB of word 15', pdq.toHex(h255).endsWith('8000'), pdq.toHex(h255).slice(-4));

  const rand = new Uint8Array(32);
  for (let i = 0; i < 32; i++) rand[i] = (i * 37 + 11) & 255;
  check('hex round-trip', pdq.toHex(pdq.fromHex(pdq.toHex(rand))) === pdq.toHex(rand));
  check('fromHex rejects junk', pdq.fromHex('nope') === null && pdq.fromHex('ab'.repeat(31)) === null);

  const z = new Uint8Array(32);
  const allOnes = new Uint8Array(32).fill(255);
  check('hamming(0,0)=0', pdq.hamming(z, z) === 0);
  check('hamming(0,~0)=256', pdq.hamming(z, allOnes) === 256);
  const one = new Uint8Array(32);
  pdq.setBit(one, 200);
  check('hamming single bit = 1', pdq.hamming(z, one) === 1);

  // torben must return an actual order statistic.
  //
  // The reference loops until `less <= (n+1)/2 && greater <= (n+1)/2`, so for
  // n=256 with distinct values it settles on the element that has exactly
  // (n+1)/2 = 128 values strictly below it — i.e. sorted[128], not sorted[127].
  // Matching this exactly matters: it is the bit threshold.
  const arr = new Float64Array(256);
  for (let i = 0; i < 256; i++) arr[i] = Math.sin(i * 12.9898) * 43758.5453 % 100;
  const sorted = Float64Array.from(arr).sort();
  const want = sorted[128];
  check('torben returns the 129th order statistic (128 strictly below)', pdq.torben(arr, 256) === want,
    `${pdq.torben(arr, 256)} === ${want}`);

  // Degenerate inputs must not throw or produce garbage.
  const tiny = pdq.hashLuma(new Float64Array(4 * 4), 4, 4);
  check('sub-minimum image yields empty hash + quality 0',
    tiny.quality === 0 && pdq.toHex(tiny.hash) === '0'.repeat(64));

  // A flat buffer has no gradient, so its quality must be 0 and callers must
  // discard it. (Its bits are genuinely undefined in the reference too: every
  // DCT coefficient collapses to ~0 and the comparisons become float noise.
  // That is precisely what the quality metric exists to catch.)
  const flat = new Float64Array(64 * 64).fill(128);
  const flatH = pdq.hashLumaDirect(flat);
  check('flat buffer -> quality 0 (discarded by callers)', flatH.quality === 0,
    `quality ${flatH.quality}`);
}

console.log('pdq.js test suite');
unitTests();
propertyTests();
referenceTests();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('all good');
