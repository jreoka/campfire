'use strict';
/*
 * Crop a profile picture to the frame its owner chose — and keep a GIF a GIF.
 *
 * The settings pane sets an avatar, a banner and a member-list banner, and the
 * "Use GIF" button fills any of them from Klipy. All three now go through a crop
 * stage first (public/js/crop.js), because the pictures people actually pick are
 * a photo with their face off-centre or a GIF whose subject is in one corner,
 * and the render sites (`background-size: cover`, a circle for an avatar) decide
 * the framing on their own — so the only place the framing can be *chosen* is
 * before the bytes are stored.
 *
 * The engine is ffmpeg, for one reason: a crop is a re-encode, and the browser's
 * canvas would flatten an animated GIF to its first frame. A GIF cropped to a
 * still is not the picture the reader picked, and "animated" is half of what the
 * GIF buttons are for. ffmpeg is already the box's media engine (media-compress.js)
 * and the app image already installs it, so this is the same tool with a
 * different filtergraph, sharing its encode slot (withCompressLock) so a crop
 * cannot become a second, unbudgeted encoder on a small host.
 *
 * What comes out follows ONE rule, and the rule is about the BYTES, not the
 * request:
 *   - animated  -> GIF. The `gif` encoder is always in the build, every browser
 *                  has always played one, and the extension is the one the
 *                  picker handed us.
 *   - still     -> WebP (libwebp, which the box's ffmpeg carries). WebP is what
 *                  the derived chat previews are already served as, it holds
 *                  transparency, and a 512px photo lands around 30 KB. If a
 *                  build ever lacks libwebp the crop falls back to PNG rather
 *                  than failing.
 * An animated WebP becomes a GIF by that rule — one animated output format, one
 * path to prove, and nothing the app renders cares which of the two it is.
 *
 * The rectangle comes from the client and is CLAMPED here rather than trusted:
 * the stage owns the framing (each surface has its own window shape and there is
 * no aspect in this module at all), while the source's true size is measured
 * from its own header here, because a rect outside the picture is either an
 * ffmpeg error or a silent pad, and a client bug should not decide which.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runFfmpeg, checkFfmpeg, withCompressLock } = require('./media-compress');
const imageSize = require('./image-size');

// A crop is a click away from a spinner, so it gets a hard ceiling of its own —
// the compressor's 15 minutes is for a video nobody is waiting on.
const CROP_TIMEOUT_MS = Math.max(5000, parseInt(process.env.CROP_TIMEOUT_MS || '60000', 10) || 60000);
const WEBP_Q = 88;
// Below this a crop is a smudge, not a picture: a client sending 0 or 1 is
// broken, and ffmpeg would answer with an encoder error instead of a 400.
const MIN_SIDE = 4;
const MIME_EXT = { 'image/gif': '.gif', 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/bmp': '.bmp' };

// The three surfaces that offer the stage, and the one number each one adds: how
// long the stored picture may be on its long side. The SHAPES are the client's
// (CROP_KINDS in public/js/crop.js — the window it draws and the preview under
// it), because what a surface looks like at render time is a stylesheet's
// business; the cap is here, where the bytes are made.
const CROP_KINDS = {
  avatar: { col: 'avatar_url', sub: 'avatars', hist: 'avatar', cap: 512, label: 'Avatar' },
  banner: { col: 'banner_url', sub: 'banners', hist: 'banner', cap: 1200, label: 'Banner' },
  sidebar: { col: 'sidebar_banner_url', sub: 'sidebar', hist: null, cap: 1080, label: 'Member list banner' },
};

// ---------- what the source really is ----------
// GIF: the logical screen descriptor, then the block stream — 0x21 is an
// extension (a label byte plus sub-blocks), 0x2C is an image descriptor (nine
// bytes, an optional local colour table, the LZW minimum code size, then
// sub-blocks), 0x3B is the trailer. A SECOND 0x2C is what makes it animated.
function gifIsAnimated(buf) {
  let p = 13; // header (6) + logical screen descriptor (7)
  if (buf.length < p) return false;
  const packed = buf[10];
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));
  const skipSubBlocks = () => {
    while (p < buf.length) {
      const n = buf[p++];
      if (n === 0) return true;
      p += n;
    }
    return false;
  };
  let frames = 0;
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      if (p >= buf.length) break;
      p++; // the extension's label byte
      if (!skipSubBlocks()) break;
      continue;
    }
    if (b === 0x2c) {
      frames++;
      if (frames > 1) return true;
      if (p + 9 > buf.length) break;
      const lpacked = buf[p + 8];
      p += 9;
      if (lpacked & 0x80) p += 3 * (1 << ((lpacked & 0x07) + 1));
      if (p >= buf.length) break;
      p++; // LZW minimum code size
      if (!skipSubBlocks()) break;
      continue;
    }
    break; // anything else is not a GIF block: stop rather than guess
  }
  return false;
}
// WebP: a RIFF chunk walk. An ANIM chunk is the animation, and the VP8X flag
// byte carries the same bit for a file that has one.
function webpIsAnimated(buf) {
  let p = 12;
  while (p + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (fourcc === 'ANIM') return true;
    if (fourcc === 'VP8X' && p + 9 <= buf.length && (buf[p + 8] & 0x02)) return true;
    p += 8 + size + (size % 2);
  }
  return false;
}
// APNG: an acTL chunk, which the spec puts before IDAT.
function pngIsAnimated(buf) {
  let p = 8;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false; // acTL must come first
    p += 12 + size;
  }
  return false;
}
// Is this a picture that moves? Unknown bytes answer "no": the still path is
// bounded to one frame, so a wrong "no" costs the animation while a wrong "yes"
// would only cost bytes.
function isAnimatedImage(buf, mime) {
  if (!buf || buf.length < 16) return false;
  const mt = String(mime || '').toLowerCase();
  try {
    if (mt === 'image/gif' || buf.toString('latin1', 0, 3) === 'GIF') return gifIsAnimated(buf);
    if (mt === 'image/webp' || (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')) return webpIsAnimated(buf);
    if (mt === 'image/png' || buf.toString('latin1', 1, 4) === 'PNG') return pngIsAnimated(buf);
  } catch { return false; }
  return false;
}

// ---------- the frame ----------
// The client's rectangle, clamped into a picture of this size. Null when the
// numbers are not numbers at all — a 400, not a guess.
function normalizeRect(input, dims) {
  const num = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : NaN;
  };
  const src = input || {};
  let x = num(src.x), y = num(src.y), w = num(src.w), h = num(src.h);
  if ([x, y, w, h].some((n) => Number.isNaN(n))) return null;
  const dw = Math.max(1, Math.floor(Number(dims && dims.w) || 0));
  const dh = Math.max(1, Math.floor(Number(dims && dims.h) || 0));
  if (!dw || !dh) return null;
  w = Math.min(Math.max(w, MIN_SIDE), dw);
  h = Math.min(Math.max(h, MIN_SIDE), dh);
  x = Math.min(Math.max(x, 0), dw - w);
  y = Math.min(Math.max(y, 0), dh - h);
  return { x, y, w, h };
}

// What the stored picture measures: the frame itself, shrunk to fit `cap` on its
// long side. Never enlarged — a 120px face cropped out of a 4000px photo is a
// 120px avatar, and upscaling it would only make the file bigger.
function outputSize(w, h, cap) {
  const long = Math.max(w, h) || 1;
  const k = long > cap ? cap / long : 1;
  const even = (v) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { w: Math.min(w, even(w)), h: Math.min(h, even(h)) };
}

// The filtergraph. One crop, one lanczos scale, then — for an animation — the
// usual palette pair, because a GIF has 256 colours per frame and the encoder's
// default palette makes a cropped animation look like it was dug up. `-loop 0`
// is what keeps it looping forever the way the source did.
function buildCropArgs({ inPath, outPath, rect, size, animated }) {
  const chain = `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=${size.w}:${size.h}:flags=lanczos`;
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-threads', '1', '-map_metadata', '-1', '-an'];
  if (animated) {
    return [...common,
      '-filter_complex', `${chain},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[out]`,
      '-map', '[out]', '-loop', '0', outPath];
  }
  return [...common, '-vf', chain, '-frames:v', '1', '-c:v', 'libwebp', '-q:v', String(WEBP_Q), outPath];
}

// Crop one picture. `buf` is the source's bytes, `mime` what it claims to be,
// `rect` the frame the reader chose and `cap` the long side of the result.
// Returns { buffer, mime, ext, w, h, animated }, or null when the box cannot do
// it at all (no ffmpeg, undecodable bytes) — the caller answers an error rather
// than storing something the reader did not ask for.
async function cropImage({ buf, mime, rect, cap }) {
  if (!buf || !buf.length || !checkFfmpeg()) return null;
  let dims = null;
  try { dims = imageSize.dimsFromBuffer(buf); } catch { dims = null; }
  if (!dims || !dims.w || !dims.h) return null;
  const frame = normalizeRect(rect, dims);
  if (!frame) return null;
  const animated = isAnimatedImage(buf, mime);
  const size = outputSize(frame.w, frame.h, Math.max(16, Number(cap) || 512));

  const rand = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(os.tmpdir(), `cf-crop-in-${rand}${MIME_EXT[String(mime || '').toLowerCase()] || '.bin'}`);
  const cleanup = [inPath];
  try {
    await fs.promises.writeFile(inPath, buf);
    // One attempt: run ffmpeg for one container and hand back the bytes when it
    // produced a real file. `-frames:v 1` in the still graph is the guard that
    // makes a missed animation detection merely static instead of broken.
    const attempt = async (isAnim, format) => {
      const ext = format === 'gif' ? '.gif' : (format === 'png' ? '.png' : '.webp');
      const outPath = path.join(os.tmpdir(), `cf-crop-out-${rand}${ext}`);
      cleanup.push(outPath);
      try { await fs.promises.unlink(outPath); } catch {}
      const args = buildCropArgs({ inPath, outPath, rect: frame, size, animated: isAnim });
      if (!isAnim && format === 'png') {
        // The same still graph, encoded where libwebp is missing.
        const i = args.lastIndexOf('-c:v');
        args.splice(i, 2, '-c:v', 'png', '-compression_level', '6');
      }
      const r = await withCompressLock(() => runFfmpeg(args, { timeoutMs: CROP_TIMEOUT_MS }));
      if (!r || !r.ok) return null;
      try {
        const out = await fs.promises.readFile(outPath);
        if (!out.length) return null;
        return out;
      } catch { return null; }
    };
    if (animated) {
      const out = await attempt(true, 'gif');
      if (!out) return null;
      return { buffer: out, mime: 'image/gif', ext: '.gif', w: size.w, h: size.h, animated: true };
    }
    const webp = await attempt(false, 'webp');
    if (webp) return { buffer: webp, mime: 'image/webp', ext: '.webp', w: size.w, h: size.h, animated: false };
    const png = await attempt(false, 'png');
    if (png) return { buffer: png, mime: 'image/png', ext: '.png', w: size.w, h: size.h, animated: false };
    return null;
  } catch {
    return null;
  } finally {
    for (const f of cleanup) { try { await fs.promises.unlink(f); } catch {} }
  }
}

function available() { return checkFfmpeg(); }

module.exports = {
  cropImage, available, isAnimatedImage, normalizeRect, outputSize, buildCropArgs, CROP_KINDS,
};
