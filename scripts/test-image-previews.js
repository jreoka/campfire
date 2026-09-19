// Chat-image previews: a channel's backlog must not cost a full-size photo per
// picture (see AGENTS.md verification conventions).
//
// The complaint: "if the internet connection isn't the best, the backlog of
// messages loaded when you open a chat takes a while." The picture bytes are
// what dominate it — one photo is 10-30x its own 640px WebP preview. So a chat
// image renders its DERIVED preview (/uploads/thumbs/files/<name>.<ext>.webp,
// minted on first request by media-compress.js, served by server.js) and falls
// back to the attachment's own bytes exactly once when the preview cannot be
// minted. The lightbox keeps opening the ORIGINAL.
//
// This test has two halves:
//   [0] static wiring, always: the key derivation round-trips and refuses
//       anything that is not a chat still image (viewonce/ must never get a
//       preview — that would be a way around its ticket gate), the server mints
//       and serves thumbs with the scan gate reading through to the source, and
//       the orphan sweep never lists the derived objects;
//   [1] the REAL attachmentHTML + the REAL document error handler in headless
//       Chrome against a server that 404s the preview once (the cold-cache path
//       the fallback exists for) and serves it for another image: the original
//       is requested exactly once in the first case, never in the second.
//
// Skips the browser half (exit 0) when Chrome is unavailable.
//
// Usage: node scripts/test-image-previews.js

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9352', 10);

// A 64x43 JPEG and its WebP preview, both tiny and committed as base64 so the
// browser half needs no ffmpeg.
const JPG_B64 = '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';
const WEBP_B64 = 'UklGRjoCAABXRUJQVlA4IC4CAACwDgCdASpAACsAPp1EmUklpCIhKrgN+LATiWwAnTKEf4fIeYJX37NvVpc/fTzAboB/leoA9ADpR/3B9IAHto1EsgwgaNbyry/AD2uFHIY/5gt8+9iiUtCROeuF4b9lPipMuoL6M939bgOrl3Hokpeg5K9BoJ9Davqh9jk/i8AA9ya1+UmU2RBaf5/Xy9YKkTXKtGyVx7R0P4GDeRFUswOVI0mDHXjaqN5CMr0KSLRgXUnKfcx3vYJ0bFSnDGUaErYQ5ScbzgMKWutLqda0uul3E0aPKy3KFsYe7W4YrIBZyOQQxZvTT3ckJ/g9pKoKeNMy/jeh8HJHkaG9V6ycK0jryye4GgN0++fAoAWdpHkxWwPc/8qYWc8pr3G1S4ywjmFtijM99kF+V1v2pcoyDobdR9SsieUTXLp/Y1tEfdmCmFDOYuBgvUv6ZxntMYD8l1aCvyKqoohGHbduu+N1n6PX8yR88DRBVfjk9ttcaGgZbF/ZKPAIw86ig3DDq5pKqVZ7UN/yufNF23lUmcr0rrYzFmpZxBvwVqYaXYrsgbBwjoMSIzJUaYoqIVyHVXq+LGc3dNdGrlY3u45AZyfy2SjeyaXNRsljGUR7eV1cbXoNHytcgolzJJY1tIanSAD5TDHJnQOXL0jJ3WB3ooRmNP7cqcK1IgeKQ+DZyhExKy8KkvxFTZK79Qk98am/UggTT7un46axrmb+GmUGH0EmSz5WmaadAf4i4FpT9sEwAAA=';

// The reported bug's own subject, in 1.2 KB: a 32x32 GIF that is RED for its
// first five frames and BLUE for the next five (verified by decoding it), so a
// browser asked for it really does change the pixels it paints. Its derived
// still preview is the 82-byte WebP of frame 1 — the frozen picture an uploaded
// GIF used to be rendered as.
const GIF_B64 = 'R0lGODlhIAAgAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEBAAfACwAAAAAIAAgAAAIWQAPCBxIsKDBgwgTKlzIsGFBAwchGpT40KHFixgzakRIkWDHgR8FhtxIsqTJiCgnpjzJsqVLkCs9xnxJsybHmSJx2tzJs6LKnz57Cn05sqjOoUhdGgUqU2BAACH5BAUEAAAALB8AHwABAAEAAAgEAAEEBAAh+QQFBAAAACwfAB8AAQABAAAIBAABBAQAIfkEBQQAAAAsHwAfAAEAAQAACAQAAQQEACH5BAUEAAAALB8AHwABAAEAAAgEAAEEBAAh+QQFBAAAACwAAAAAIAAgAAAIWAABARtIEJjAggMPIlSIsKHDhxAjSpxIsSJEhgQxJnSo0aLHjyBDPuxIkqPIkyhTnizZkKXKlzBRuiw4M6bNmyFrbmyJs6dPnkAXmvxJtCjNoUKDGl2aMiAAIfkEBQQAAAAsHwAfAAEAAQAACAQAAQQEACH5BAUEAAAALB8AHwABAAEAAAgEAAEEBAAh+QQFBAAAACwfAB8AAQABAAAIBAABBAQAIfkEBQQAAAAsHwAfAAEAAQAACAQAAQQEADs=';
const GIF_STILL_B64 = 'UklGRkoAAABXRUJQVlA4ID4AAAAwAwCdASogACAAPok+mkmlIyKhKAgAoBEJZQC7LoAAQFBQAP7vdtf+A3XxbTL/92T/+4z/+4z/3nG46QgAAA==';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const finalJs = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mediaCompress = fs.readFileSync(path.join(ROOT, 'media-compress.js'), 'utf8');
const storageSweep = fs.readFileSync(path.join(ROOT, 'storage-sweep.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The real markup generator (attachmentHTML and the helpers it needs) — the same
// slice test-video-placeholder.js uses, so a regression in either is caught.
const MARK_START = messages.indexOf('const DL_ICON =');
const MARK_END = messages.indexOf('// ---------- video posters:');
if (MARK_START < 0 || MARK_END < 0) {
  console.error('[test] could not locate the attachmentHTML block in public/js/messages.js');
  process.exit(1);
}
const markSource = messages.slice(MARK_START, MARK_END);

// The real broken-image / preview-fallback handler out of final.js.
const ERR_START = finalJs.indexOf('// Broken images');
const ERR_END = finalJs.indexOf('}, true);', ERR_START);
if (ERR_START < 0 || ERR_END < 0) {
  console.error('[test] could not locate the image error handler in public/js/final.js');
  process.exit(1);
}
const errSource = finalJs.slice(ERR_START, ERR_END + '}, true);'.length);

// The real attFromEl (actions.js): the handler reads the attachment's identity
// off the element it is replacing, and that is where the name/size the card
// shows comes from.
const ACT_START = actions.indexOf('function attFromEl(el) {');
const ACT_END = actions.indexOf('function absUrl(', ACT_START);
if (ACT_START < 0 || ACT_END < 0) {
  console.error('[test] could not locate attFromEl in public/js/actions.js');
  process.exit(1);
}
const attSource = actions.slice(ACT_START, ACT_END);

// The real key derivation out of media-compress.js, with extOf supplied.
function loadThumbHelpers() {
  const start = mediaCompress.indexOf('const THUMB_DIR =');
  const end = mediaCompress.indexOf('function thumbsPossible()');
  if (start < 0 || end < 0) { console.error('[test] could not locate the thumbnail helpers in media-compress.js'); process.exit(1); }
  const src = mediaCompress.slice(start, end);
  const factory = new Function('extOf', src + '\nreturn { thumbKeyFor: thumbKeyFor, thumbSourceKey: thumbSourceKey };');
  const extOf = (name) => { const m = /(\.[a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
  return factory(extOf);
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;background:#0e1420}</style>
</head><body>
<div id="host" style="padding:12px;display:flex;flex-direction:column;align-items:flex-start;gap:16px"></div>
<script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize() { return '1 KB'; }
function toast() {}
function audioPlayerHTML() { return ''; }
function textPreviewable() { return false; }
function textFileHTML() { return ''; }
${markSource}
${attSource}
${errSource}
window.__mk = function (att) {
  const host = document.getElementById('host');
  const d = document.createElement('div');
  d.innerHTML = attachmentHTML(att);
  // The slot is the verdict patch's handle (see messages.js); the media wrapper
  // inside it is what carries the preview and the original.
  const slot = d.firstElementChild;
  host.appendChild(slot);
  return slot.querySelector('.att-wrap') || slot;
};
// The degraded card a picture this browser cannot decode ends as: every field a
// plain file card has, plus the attachment identity the menus read.
window.__card = function (wrap) {
  const c = wrap && wrap.querySelector('.file-card');
  if (!c) return null;
  const nameEl = c.querySelector('.fname'), sizeEl = c.querySelector('.fsize');
  const ph = wrap.querySelector('.att-ph');
  return {
    tag: c.tagName,
    href: c.getAttribute('href'),
    icon: !!c.querySelector('svg'),
    name: nameEl ? nameEl.textContent : null,
    size: sizeEl ? sizeEl.textContent : null,
    attId: c.dataset.attId || '',
    kind: c.dataset.fbKind || '',
    url: c.dataset.fbUrl || '',
    sizeAttr: c.dataset.fbSize || '',
    stillImg: !!wrap.querySelector('img.att-img'),
    phDisplay: ph ? getComputedStyle(ph).display : '',
  };
};
window.__state = function (wrap) {
  const img = wrap.querySelector('img.att-img');
  return {
    tag: img ? img.tagName : wrap.firstElementChild.tagName,
    src: img ? img.getAttribute('src') : '',
    current: img ? (img.currentSrc || '') : '',
    thumb: img ? !!img.dataset.fbThumb : false,
    fbUrl: img ? (img.dataset.fbUrl || '') : '',
    lazy: img ? img.getAttribute('loading') : '',
    natural: img ? img.naturalWidth : 0,
  };
};
</script>
</body></html>`;
}

async function main() {
  console.log('\n[0] the preview is a derived key, and only for chat still images');
  const { thumbKeyFor, thumbSourceKey } = loadThumbHelpers();
  check(thumbKeyFor('files/abc123.jpg') === 'thumbs/files/abc123.jpg.webp', 'a chat upload derives thumbs/files/<name>.<ext>.webp');
  check(thumbKeyFor('files/abc123.PNG') === 'thumbs/files/abc123.PNG.webp', 'case is preserved in the key (the stored name is used verbatim)');
  check(thumbKeyFor('files/a.webp') === 'thumbs/files/a.webp.webp', 'an already-webp upload still derives a distinct key');
  check(thumbSourceKey(thumbKeyFor('files/a.png')) === 'files/a.png', 'and the inverse resolves back to the source');
  check(thumbKeyFor('viewonce/secret.jpg') === null, 'view-once media never gets a preview (that would be a way around its ticket gate)');
  check(thumbKeyFor('stories/s.jpg') === null, 'nor story media');
  check(thumbKeyFor('avatars/a.jpg') === null, 'nor profile media (chat backlogs are the problem, not a 40px avatar)');
  check(thumbKeyFor('files/clip.mp4') === null, 'nor a video');
  check(thumbKeyFor('files/notes.txt') === null, 'nor a non-image');
  check(thumbKeyFor('files/../../etc/passwd.jpg') === null, 'nor anything with a path escape');
  check(thumbSourceKey('thumbs/files/a.jpg') === null, 'a thumbs/ key without the .webp suffix is not a preview');
  check(thumbSourceKey('thumbs/avatars/a.jpg.webp') === null, 'and a thumbs/ key over a non-chat prefix is refused by the round trip');
  check(thumbSourceKey('thumbs/files/clip.mp4.webp') === null, 'so is a preview of a non-image');

  console.log('\n[1] the server mints, serves and protects the preview');
  check(/app\.use\('\/uploads\/thumbs'/.test(server), 'server.js serves the derived previews');
  check(/thumbSourceKey\(key\)/.test(server), 'the route resolves the source key through the shared helper');
  check(/ensureThumb\(src, \{ waitMs: THUMB_WAIT_MS \}\)/.test(server), 'and mints it with a bounded wait instead of parking the reader');
  check(/Cache-Control', 'no-store'[\s\S]{0,80}404/.test(server), 'a preview that is not ready answers 404 without being cached, so the fallback is one-shot');
  check(/const src = require\('\.\/media-compress'\)\.thumbSourceKey\(key\);[\s\S]{0,40}if \(src\) key = src;/.test(server),
    'the scan gate reads a preview through to the source key (a preview of a pending/infected upload is still those bytes)');
  check(/thumbKeyFor\(key\)/.test(server) && /if \(!url \|\| !url\.startsWith\('\/uploads\/'\)\) return;/.test(server),
    'deleting an upload takes its derived preview with it');
  check(/const THUMB_WAIT = Symbol/.test(mediaCompress) && /return raced === THUMB_WAIT \? null : raced;/.test(mediaCompress),
    'the mint never lets a request wait for the whole encode');
  check(/if \(load\.active >= load\.concurrency \|\| load\.queued > 0\) return null;/.test(mediaCompress),
    'and it does not wait at all when an encode already owns the box (the fallback is immediate then)');
  check(/await withCompressLock\(\(\) => encodeThumb\(srcKey, tkey\)\)/.test(mediaCompress),
    'the encode runs through the shared lock — the one-encode-across-the-pod promise still holds');
  check(/scale='min\(\$\{THUMB_PX\},iw\)':'min\(\$\{THUMB_PX\},ih\)'/.test(mediaCompress),
    'the preview box never upscales a small image (a 200px photo must not grow)');
  check(/'-frames:v', '1'/.test(mediaCompress) && /'-an'/.test(mediaCompress), 'one frame, no audio');
  check(/result\.thumbsQueued = queued/.test(mediaCompress) && /thumbBacklog\.push\(o\.key\)/.test(mediaCompress),
    'the bucket scan queues previews for the existing backlog instead of parking the pass on them');
  check(/while \(thumbBacklog\.length && minted < 2\)/.test(mediaCompress) && /thumbBacklog\.length\) \? 'more' : 'idle'/.test(mediaCompress),
    'and the worker drains them a couple per tick, staying hot while any remain');

  console.log('\n[2] the orphan sweep must never list or keep a derived object');
  check(/const DERIVED_PREFIX = 'thumbs\/'/.test(storageSweep) && /function isDerivedKey/.test(storageSweep), 'thumbs/ is a known derived prefix');
  check(/if \(isDerivedKey\(o\.key\)\) continue;/.test(storageSweep), 'the bucket listing skips it (no DB row points at a preview)');
  check(/if \(isDerivedKey\(key\)\) continue;/.test(storageSweep), 'and so does the local walk');
  check(/thumbKeyFor\(f\.key\)/.test(storageSweep), 'a deleted source takes its preview with it');
  check(/if \(o\.key === storage\.BACKUP_PREFIX\.slice\(0, -1\) \|\| o\.key\.startsWith\(storage\.BACKUP_PREFIX\)\) continue;/.test(storageSweep),
    'the backups/ rule is untouched');

  console.log('\n[3] the client asks for the preview, with the original one error away');
  check(/class="att-img"[^>]*\ssrc="\$\{esc\(preview \|\| thumb \|\| a\.url\)\}"/.test(markSource),
    'the markup prefers the derived preview (and this browser\'s own picked bytes first, when it still has them)');
  check(/data-fb-thumb="1"/.test(markSource) && /data-fb-url="\$\{esc\(a\.url\)\}"/.test(markSource),
    'and carries the original it falls back to');
  check(/loading="lazy"/.test(markSource), 'integration with native lazy loading is kept');
  check(/function thumbSrcFor\(url\)[\s\S]{0,220}\^\\\/uploads\\\/files\\\//.test(markSource), 'only chat/uploads prefixes derive a preview');
  check(/if \(t\.dataset\.fbThumb && t\.dataset\.fbUrl\) \{\s*t\.removeAttribute\('data-fb-thumb'\);\s*t\.src = t\.dataset\.fbUrl;\s*return;/.test(errSource),
    'the error handler swaps in the original exactly once (the marker is cleared first, so a second failure degrades to the file card)');
  check(/if \(t\.dataset\.fbName\) \{/.test(errSource), 'and the broken-image file card is still the last resort');
  check(/function attFileCardHTML\(a\)/.test(markSource), 'the plain-file card is built in ONE place (attFileCardHTML), which the fallback reuses');
  check(/return attFileCardHTML\(a\);/.test(markSource), 'a file attachment renders through it');
  check(/box\.innerHTML = attFileCardHTML\(Object\.assign\(\{\}, att, \{ kind: 'file' \}\)\)/.test(errSource),
    'and so does the degraded picture — icon, name, size and identity, not a bare box around the name');
  check(/attFromEl\(t\)/.test(errSource), 'the fallback reads the real attachment identity (id/url/name/size/kind) off the element it replaces');
  check(/data-fb-size="\$\{esc\(\(a && a\.size\) \|\| 0\)\}"/.test(markSource), 'every rendering carries its size for that fallback to read');
  check(/openLightbox\(imgEl\.dataset\.fbUrl \|\| imgEl\.src/.test(pickers), 'the lightbox opens the ORIGINAL, never the preview');
  check(/attDl\(a\)\}/.test(markSource) || /function attDl\(a\)/.test(markSource),
    'the download link is unchanged (it was always the original), and is offered with every rendering');
  // The bug this section's last checks exist for: "a manually uploaded GIF
  // doesn't autoplay, linked ones do." A Klipy GIF is an https url with no
  // /uploads/ key, so it never had a preview to be frozen by; an uploaded one did
  // — the derived preview is ONE frame.
  check(/function attIsAnimated\(a\)/.test(markSource) && /mime === 'image\/gif' \|\| mime === 'image\/apng'/.test(markSource),
    'an animated picture is recognized from its mime or its stored extension');
  check(/ATT_ANIMATED_EXT_RE = \/\\\.\(gif\|apng\)\$\/i/.test(markSource), 'GIF and APNG are the animated formats (a WebP cannot be told apart from a still one without its bytes)');
  check(/const thumb = \(preview \|\| attIsAnimated\(a\)\) \? '' : imageSrcFor\(a\);/.test(markSource),
    'and an animated attachment skips the still preview, so the chat paints its own animating bytes');
  check(/imageSrcFor\(x\) \|\| x\.url/.test(fs.readFileSync(path.join(ROOT, 'public/js/security.js'), 'utf8')),
    'while a LIST that wants a still tile still asks for the preview (the inbox bookmark thumbnails)');
  check(/The single frame is deliberate for an ANIMATED source too/.test(mediaCompress),
    'the server keeps minting the still preview (it is what those tiles paint), and says why');

  const chromePath = findChrome();
  if (!chromePath) {
    console.log('\n[4] SKIP the browser half: no Chrome/Edge found (set CHROME_PATH)');
    return finish();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-img-prev-'));
  const jpg = Buffer.from(JPG_B64, 'base64');
  const webp = Buffer.from(WEBP_B64, 'base64');
  const gif = Buffer.from(GIF_B64, 'base64');
  const gifStill = Buffer.from(GIF_STILL_B64, 'base64');
  const hits = [];
  const srv = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageHtml());
    }
    hits.push(url);
    // A phone photo this browser has no decoder for: the preview cannot be
    // minted from it and the original cannot be painted either (a HEIC on
    // Windows). Both answer 404, which is what the fallback card is for.
    if (url.startsWith('/uploads/thumbs/files/broken.heic') || url.startsWith('/uploads/files/broken.heic')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"not_found"}');
    }
    if (url.startsWith('/uploads/thumbs/files/warm.jpg')) {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': webp.length });
      return res.end(webp);
    }
    // The derived preview of the animated GIF: a perfectly valid STILL webp, and
    // exactly what a frozen GIF used to be painted from. It is served (not
    // 404ed) so that a client which wrongly asks for it renders a still picture
    // rather than falling back to the original and hiding the bug.
    if (url.startsWith('/uploads/thumbs/files/anim.gif')) {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': gifStill.length });
      return res.end(gifStill);
    }
    if (url.startsWith('/uploads/files/anim.gif')) {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': gif.length });
      return res.end(gif);
    }
    if (url.startsWith('/uploads/files/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length });
      return res.end(jpg);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;

  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    // Chrome throttles (and can suspend) an animated image in a backgrounded or
    // occluded renderer, which is exactly what a headless target looks like — the
    // GIF check at the end samples painted pixels and needs it really running.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--hide-scrollbars', '--window-size=520,640', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');

    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const evaluate = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };

    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Emulation.setDeviceMetricsOverride', { width: 420, height: 620, deviceScaleFactor: 2, mobile: true });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sess('Page.bringToFront').catch(() => {});
    await sleep(500);
    if (!(await evaluate('typeof window.__mk === "function"'))) {
      console.error('[test] the extracted messages.js / final.js code did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[4] a cold preview 404s once and the original bytes land');
    await evaluate(`window.__mk({ kind: 'image', url: '/uploads/files/pic.jpg?v=abc', name: 'pic.jpg' })`);
    let cold = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      cold = await evaluate('window.__state(document.querySelector(".att-slot"))');
      if (cold.natural > 0) break;
    }
    check(cold && cold.natural > 0, 'the picture still renders when the preview cannot be minted', cold);
    check(cold && cold.tag === 'IMG', 'and it is not degraded to the broken-file card', cold);
    check(cold && !cold.thumb, 'the fallback marker is consumed (no loop)', cold);
    check(cold && /\/uploads\/files\/pic\.jpg\?v=abc$/.test(cold.current), 'the browser landed on the ORIGINAL upload', cold);
    check(hits.filter((h) => h.startsWith('/uploads/files/pic.jpg')).length === 1, 'the original was requested exactly once', hits);
    check(hits.some((h) => h.startsWith('/uploads/thumbs/files/pic.jpg.webp')), 'and the preview was asked for first', hits);
    check(cold && cold.lazy === 'lazy', 'the inline picture is still lazy', cold);

    console.log('\n[5] a warm preview means the original is never fetched');
    await evaluate(`window.__mk({ kind: 'image', url: '/uploads/files/warm.jpg?v=zz', name: 'warm.jpg', spoiler: true })`);
    let warm = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      warm = await evaluate('window.__state(document.querySelectorAll(".att-slot")[1])');
      if (warm.natural > 0) break;
    }
    check(warm && warm.natural > 0, 'the preview renders', warm);
    check(warm && /\/uploads\/thumbs\/files\/warm\.jpg\.webp\?v=zz$/.test(warm.current), 'straight off the derived URL, cache key and all', warm);
    check(!hits.some((h) => h.startsWith('/uploads/files/warm.jpg')), 'the full-size photo was never downloaded', hits);
    check(await evaluate('!!document.querySelectorAll(".att-slot")[1].querySelector(".spoiler-veil")'), 'a spoilered image keeps its veil');
    check(await evaluate('!!document.querySelectorAll(".att-slot")[1].querySelector(".att-wrap").classList.contains("spoiler")'), 'and its blur class');

    console.log('\n[6] a picture the browser cannot decode degrades to a REAL file card');
    // The reported shape: an iPhone HEIC on Windows rendered as an outlined box
    // with nothing but the file name in it — no icon, no size, and no
    // attachment identity, so the menus could not act on the file either. The
    // fallback now goes through the same attFileCardHTML a plain file uses.
    await evaluate(`window.__mk({ kind: 'image', id: 'att-heic', url: '/uploads/files/broken.heic?v=1', name: 'D5D3E71D-987A-4389-998E-3E95C60CF5C9_1_201_a.heic', size: 471520, w: 512, h: 512 })`);
    let card = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      card = await evaluate('window.__card(document.querySelectorAll(".att-slot")[2])');
      if (card) break;
    }
    check(!!card, 'the picture ends as a file card rather than a broken-image box', card);
    check(card && card.tag === 'A', 'it is a link to the file', card);
    check(card && card.href === '/uploads/files/broken.heic?v=1', 'pointing at the ORIGINAL upload', card);
    check(card && card.icon, 'with the file icon the plain card has', card);
    check(card && card.name === 'D5D3E71D-987A-4389-998E-3E95C60CF5C9_1_201_a.heic', 'the full name, not an ellipsised or empty label', card);
    check(card && card.size === '1 KB', 'and the size line under it (fmtSize is stubbed to 1 KB in this page)', card);
    check(card && card.attId === 'att-heic' && card.kind === 'file' && card.sizeAttr === '471520',
      'the card carries the attachment identity, so Copy/Save/Scan info still resolve', card);
    check(card && !card.stillImg, 'the failed <img> is gone (no broken-image box behind it)', card);
    check(card && card.phDisplay === 'none', 'and the loading placeholder is hidden by the card', card);
    check(hits.some((h) => h.startsWith('/uploads/thumbs/files/broken.heic')) && hits.some((h) => h.startsWith('/uploads/files/broken.heic')),
      'both the preview and the original were tried exactly once before degrading', hits.filter((h) => h.includes('broken.heic')));
    check(hits.filter((h) => h.startsWith('/uploads/files/broken.heic')).length === 1, 'the original is not requested again after the card lands', hits.filter((h) => h.includes('broken.heic')));

    console.log('\n[7] an uploaded GIF animates: it paints its own bytes, never the still preview');
    // "A manually uploaded GIF doesn't autoplay, linked ones do." The preview is
    // one frame, so a GIF rendered from it was a still picture. The element must
    // be pointed at the attachment itself — and it must MOVE, which is what the
    // screenshots below prove: the picture has to be pointed at the animating
    // file for that to be possible at all.
    //
    // The change is measured by hashing screenshots of the picture's own box
    // rather than by drawing it to a canvas: Chrome's drawImage keeps painting an
    // animated image's FIRST frame, so a canvas sample reads as a still picture
    // however the element is pointed (measured, not assumed).
    const shotBox = async (idx) => {
      const rect = await evaluate(`(() => { const r = document.querySelectorAll(".att-slot")[${idx}].querySelector("img.att-img").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      const hashes = new Set();
      for (let i = 0; i < 12 && hashes.size < 2; i++) {
        const shot = (await sess('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } })).data;
        hashes.add(crypto.createHash('md5').update(shot).digest('hex'));
        await sleep(80);
      }
      return hashes.size;
    };
    // The control first: a still picture's box cannot change between screenshots,
    // which is what makes the GIF's answer below mean something.
    check(await shotBox(1) === 1, 'a still picture paints the same pixels every time it is looked at');
    await evaluate(`window.__mk({ kind: 'image', id: 'att-gif', url: '/uploads/files/anim.gif?v=g1', name: 'party.gif', mime: 'image/gif', size: ${gif.length}, w: 32, h: 32 })`);
    await evaluate('document.querySelectorAll(".att-slot")[3].scrollIntoView()');
    let anim = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      anim = await evaluate('window.__state(document.querySelectorAll(".att-slot")[3])');
      if (anim.natural > 0) break;
    }
    check(anim && anim.natural > 0, 'the GIF renders', anim);
    check(anim && anim.tag === 'IMG' && !anim.thumb, 'as a plain <img> with no preview marker', anim);
    check(anim && /\/uploads\/files\/anim\.gif\?v=g1$/.test(anim.current), 'pointed at the attachment itself, not its thumbnail', anim);
    check(!hits.some((h) => h.startsWith('/uploads/thumbs/files/anim.gif')), 'the derived still was never even requested', hits.filter((h) => h.includes('anim.gif')));
    check(hits.filter((h) => h.startsWith('/uploads/files/anim.gif')).length === 1, 'and the GIF was fetched exactly once', hits.filter((h) => h.includes('anim.gif')));
    check(await shotBox(3) >= 2, 'and it really animates — the box it paints changes from frame to frame');

    console.log('\n[8] the stylesheet still sizes the inline picture');
    check(/\.msg-attsimg\.att-img\{max-width:100%;max-height:320px/.test(css.replace(/\s+/g, '')), 'the chat image box is unchanged');
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return finish();
}

function finish() {
  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
