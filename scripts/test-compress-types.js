// Offline check of what the compressor will ATTEMPT — no server, no database:
//   - the size floor (there is none by default: any size is attempted),
//   - the type routing (every image / video / audio family, plus what must
//     never be handed to ffmpeg),
//   - how a deferred 'still' plan resolves against real bytes (alpha -> PNG,
//     opaque -> JPEG, an animation left exactly as it is).
//
// The plumbing around it (slot, serving gate, ledger, bucket scan) is covered
// end-to-end by scripts/test-upload-pipeline.js; this file is the coverage
// contract itself, so it runs anywhere and only needs ffmpeg + ffprobe.
//
// Re-run after touching media-compress.js: planFor, resolvePlan, MIN_BYTES.
// Usage: node scripts/test-compress-types.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const media = require('../media-compress');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const gen = (args, out) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], { stdio: 'ignore' });
  return !!(r && r.status === 0 && fs.existsSync(out) && fs.statSync(out).size);
};

async function main() {
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!ff || ff.status !== 0) return skip('ffmpeg not found on PATH');
  const fp = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
  if (!fp || fp.status !== 0) return skip('ffprobe not found on PATH');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-types-'));
  const f = (n) => path.join(tmp, n);
  try {
    const enc = media.probeEncoders();

    console.log('-- size: there is no floor, so every size is attempted --');
    check('MIN_BYTES is empty by default',
      media.MIN_KB === 0 && ['image', 'gif', 'video', 'audio'].every((g) => media.MIN_BYTES[g] === 0),
      JSON.stringify(media.MIN_BYTES));
    check('a 174-byte png is a candidate', media.isCandidate('image/png', 'files/a.png', 174) === true);
    check('a 300-byte mp4 is a candidate', media.isCandidate('video/mp4', 'files/a.mp4', 300) === true);
    check('a 2 KB wav is a candidate', media.isCandidate('audio/wav', 'files/a.wav', 2048) === true);
    check('a tiny gif is a candidate', media.isCandidate('image/gif', 'files/a.gif', 512) === true);
    check('a zip is NOT a candidate', media.isCandidate('application/zip', 'files/a.zip', 9 * 1024 * 1024) === false);
    check('a pdf is NOT a candidate', media.isCandidate('application/pdf', 'files/a.pdf', 9 * 1024 * 1024) === false);
    check('source code is NOT a candidate', media.isCandidate('text/plain', 'files/a.ts', 4096) === false);
    check('an svg is NOT a candidate', media.isCandidate('image/svg+xml', 'files/a.svg', 4096) === false);
    check('an unidentifiable binary is NOT a candidate', media.isCandidate('application/octet-stream', 'files/a.bin', 9 * 1024 * 1024) === false);

    console.log('\n-- routing: every media family the box can decode --');
    check('jpeg -> jpeg', (media.planFor('image/jpeg', 'files/a.jpg') || {}).pipeline === 'jpeg');
    check('png keeps its lossless encoder', (media.planFor('image/png', 'files/a.png') || {}).prefer === 'png');
    check('gif keeps its animation-aware pipeline', (media.planFor('image/gif', 'files/a.gif') || {}).pipeline === 'gif');
    check('webp is routed (own encoder, or alpha-driven)',
      !enc.webp ? (media.planFor('image/webp', 'files/a.webp') || {}).pipeline === 'still' : (media.planFor('image/webp', 'files/a.webp') || {}).prefer === 'webp');

    // Stills with no pipeline of their own are deferred to the bytes. Both the
    // client's MIME and the name alone (what the bucket scan has) must route.
    for (const [mime, key] of [
      ['image/bmp', 'files/a.bmp'], ['image/tiff', 'files/a.tif'], ['image/avif', 'files/a.avif'],
      ['image/jxl', 'files/a.jxl'], ['image/heic', 'files/a.heic'], ['image/vnd.microsoft.icon', 'files/a.ico'],
      ['application/octet-stream', 'files/a.bmp'], ['application/octet-stream', 'files/a.heic'],
    ]) {
      const plan = media.planFor(mime, key);
      check(mime + ' ' + path.extname(key) + ' -> deferred still', !!plan && plan.pipeline === 'still', JSON.stringify(plan));
    }

    for (const [mime, key] of [
      ['video/quicktime', 'files/a.mov'], ['video/x-matroska', 'files/a.mkv'], ['video/webm', 'files/a.webm'],
      ['application/octet-stream', 'files/a.mkv'], ['application/octet-stream', 'files/a.avi'], ['application/octet-stream', 'files/a.m2ts'],
    ]) {
      const plan = media.planFor(mime, key);
      check(mime + ' ' + path.extname(key) + ' -> mp4', enc.x264 ? !!plan && plan.pipeline === 'mp4' : plan === null, JSON.stringify(plan));
    }

    for (const [mime, key, want, need] of [
      ['audio/wav', 'files/a.wav', 'wav2mp3', 'mp3'], ['audio/flac', 'files/a.flac', 'wav2mp3', 'mp3'],
      ['audio/aiff', 'files/a.aiff', 'wav2mp3', 'mp3'], ['application/octet-stream', 'files/a.wma', 'wav2mp3', 'mp3'],
      ['application/octet-stream', 'files/a.amr', 'wav2mp3', 'mp3'], ['audio/mpeg', 'files/a.mp3', 'mp3', 'mp3'],
      ['audio/mp4', 'files/a.m4a', 'm4a', null], ['audio/ogg', 'files/a.ogg', 'ogg', 'opus'],
      ['audio/webm', 'files/a.webm', 'webaudio', 'opus'],
    ]) {
      const plan = media.planFor(mime, key);
      check(mime + ' ' + path.extname(key) + ' -> ' + want, need && !enc[need] ? plan === null : !!plan && plan.pipeline === want, JSON.stringify(plan));
    }

    check('TypeScript is not mistaken for MPEG-TS',
      media.planFor('text/plain', 'files/a.ts') === null && media.planFor('application/octet-stream', 'files/a.ts') === null);
    check('a plain .webm name is read as video, not as a voice note',
      (media.planFor('application/octet-stream', 'files/a.webm') || {}).pipeline === 'mp4');

    // A resolved plan has to name a pipeline buildArgs() knows, or the encode
    // throws instead of compressing (this is how a 'still' that never got
    // resolved would show up).
    for (const p of ['jpeg', 'png', 'webp', 'gif', 'mp4', 'mp3', 'm4a', 'ogg', 'webaudio', 'wav2mp3']) {
      let ok = true;
      try { media.buildArgs(p, 'in', 'out'); } catch { ok = false; }
      check('buildArgs(' + p + ') exists', ok);
    }

    console.log('\n-- bytes: a deferred still plan is settled by the file itself --');
    const made = [];
    const mk = (name, args) => { if (gen(args, f(name))) made.push(name); else console.log('  note  could not generate ' + name + ' (encoder missing) — skipped'); };
    mk('opaque.png', ['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1']);
    mk('alpha.png', ['-f', 'lavfi', '-i', 'color=c=red@0.4:s=64x64,format=rgba', '-frames:v', '1']);
    mk('pic.bmp', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1']);
    mk('pic.tiff', ['-f', 'lavfi', '-i', 'color=c=green:s=64x64', '-frames:v', '1']);
    mk('anim.webp', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:r=5', '-frames:v', '5', '-c:v', 'libwebp', '-loop', '0']);
    mk('anim.png', ['-f', 'lavfi', '-i', 'testsrc=s=64x64:r=5', '-frames:v', '5', '-c:v', 'apng', '-plays', '0', '-f', 'apng']);
    mk('pic.avif', ['-f', 'lavfi', '-i', 'color=c=yellow:s=64x64', '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1']);
    mk('pic.jxl', ['-f', 'lavfi', '-i', 'color=c=purple:s=64x64', '-frames:v', '1', '-c:v', 'libjxl']);

    // What each one must resolve to. A PNG stays a PNG whatever it holds; a
    // format with no promise of its own goes to JPEG unless it has alpha; an
    // animation is left alone, because one frame is all a still encode keeps.
    const MIME = { '.png': 'image/png', '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.webp': 'image/webp', '.avif': 'image/avif', '.jxl': 'image/jxl' };
    const expect = {
      'opaque.png': 'png', 'alpha.png': 'png', 'pic.bmp': 'jpeg', 'pic.tiff': 'jpeg',
      'pic.avif': 'jpeg', 'pic.jxl': 'jpeg', 'anim.webp': null, 'anim.png': null,
    };
    for (const name of made) {
      const src = f(name);
      const ext = path.extname(name);
      const want = expect[name];
      // Route it the way a real upload of that type would be routed, then let
      // the bytes settle the question.
      const plan = media.planFor(MIME[ext] || 'application/octet-stream', 'files/x' + ext);
      let out = null;
      try { out = await media.resolvePlan(plan, src); } catch (e) { out = { error: String((e && e.message) || e) }; }
      const ok = out && out.error ? false : (want === null ? out === null : !!out && out.pipeline === want);
      check(name + ' -> ' + (want === null ? 'left alone' : want), ok, JSON.stringify(out) + ' from ' + JSON.stringify(plan));
      if (!out || out.error || want === null) continue;
      // ...and the resolved pipeline must actually run on those bytes.
      const dst = f('out-' + name + out.outExt);
      const r = spawnSync('ffmpeg', media.buildArgs(out.pipeline, src, dst), { stdio: 'ignore' });
      check(name + ' encodes with the ' + out.pipeline + ' pipeline', r.status === 0 && fs.existsSync(dst) && fs.statSync(dst).size > 0, 'exit=' + r.status);
    }
    check('the multi-frame fixtures really were animations',
      made.includes('anim.webp') && made.includes('anim.png'), 'generated: ' + made.join(', '));

    const direct = media.planFor('image/jpeg', 'files/a.jpg');
    check('a plan that is not deferred passes through untouched', (await media.resolvePlan(direct, f('opaque.png'))) === direct);

    // The knobs are read at require time, so ask a child process what a given
    // environment produces. Concurrency 1 is the low-CPU promise (and the
    // default); the ceiling exists because every extra encode holds its own
    // decoder buffers on a box that is also serving the app.
    console.log('\n-- knobs: how many files at once, and how wide a batch --');
    const knob = (env) => {
      const r = spawnSync(process.execPath, ['-e',
        "const m=require('./media-compress');const s=m.getMediaStats();process.stdout.write(JSON.stringify({c:s.concurrency,b:s.batch,k:s.minKb}))"],
      { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8' });
      try { return JSON.parse(r.stdout); } catch { return null; }
    };
    const dflt = knob({ MEDIA_COMPRESS_CONCURRENCY: '', MEDIA_COMPRESS_BATCH: '', MEDIA_COMPRESS_MIN_KB: '' });
    check('defaults: 1 encode at once, 1 file per tick, no size floor', !!dflt && dflt.c === 1 && dflt.b === 1 && dflt.k === 0, JSON.stringify(dflt));
    const two = knob({ MEDIA_COMPRESS_CONCURRENCY: '2', MEDIA_COMPRESS_BATCH: '4' });
    check('a configured pair is what the worker reports', !!two && two.c === 2 && two.b === 4, JSON.stringify(two));
    const hi = knob({ MEDIA_COMPRESS_CONCURRENCY: '99', MEDIA_COMPRESS_BATCH: '99' });
    check('...and both are clamped (4 encodes, 16 per tick)', !!hi && hi.c === 4 && hi.b === 16, JSON.stringify(hi));
    const lo = knob({ MEDIA_COMPRESS_CONCURRENCY: '0', MEDIA_COMPRESS_BATCH: '-3' });
    check('...and cannot go below one', !!lo && lo.c === 1 && lo.b === 1, JSON.stringify(lo));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const x of failures) console.log('  - ' + x);
    process.exit(1);
  }
  console.log('compress coverage: OK');
}

function skip(why) {
  console.log('[test] SKIP: ' + why);
  process.exit(0);
}

main().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
