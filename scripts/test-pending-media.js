// No load -> unload -> load: a pending upload paints its own picked bytes, and a
// verdict lands on the element instead of rebuilding the list.
//
// The reported bug: "when i upload a photo it loads and then the compressor gets
// it and it disappears into a loading spinner then reappears again." An upload
// posts to chat immediately, but its bytes stay behind the scan gate until the
// scan -> compress -> scan slot has published them, so the message first arrived
// with scan:'pending' and the client drew a spinner CARD where the picture had
// been — then the verdict re-broadcast the message, renderMessages() rebuilt the
// whole list, and the picture came back (an <img> re-created, a <video> loaded
// from scratch, a voice note restarted).
//
// Three halves:
//   [1] the markup: a pending attachment WITH a local preview renders the real
//       media and NOTHING over it (never the spinner card, and never the corner
//       "Processing" chip the owner asked to remove), the download link
//       and the star wait for the final bytes, and the reserved box is the same
//       one the final rendering takes;
//   [2] the patch, driven in headless Chrome against the REAL markup and the REAL
//       patchAttachmentNode: a pending -> clean image keeps the frame the reader
//       is looking at until the new bytes land (the old node is still in the DOM
//       while the preview is in flight), the picture never gains an overlay, an
//       attachment whose kind or aspect changed is REFUSED so the caller can fall
//       back to a render, and an audio player swaps its source without being
//       rebuilt (its playhead survives);
//   [3] the wiring: the socket handlers ask for the patch before rebuilding, and
//       the upload path registers the picked bytes against the attachment id.
//
// Skips the browser half (exit 0) without Chrome.
//
// Usage: node scripts/test-pending-media.js
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9356', 10);

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
const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// The real markup generator AND the real preview store / handover helpers: they
// live in one block on purpose (see the header of the store in messages.js).
const MARK_START = messages.indexOf('const DL_ICON =');
const MARK_END = messages.indexOf('// ---------- video posters:');
if (MARK_START < 0 || MARK_END < 0) {
  console.error('[test] could not locate the attachment markup block in public/js/messages.js');
  process.exit(1);
}
const markSource = messages.slice(MARK_START, MARK_END);
if (!/function attachmentHTML/.test(markSource) || !/function patchAttachmentNode/.test(markSource) || !/function patchAttachmentsIn/.test(markSource)) {
  console.error('[test] the extracted block is missing attachmentHTML / the patch helpers');
  process.exit(1);
}
// The store's own lifetime rules (what keeps the picked bytes alive across the
// send) and the video poster machinery the replaced player borrows a frame from.
const PRUNE_START = messages.indexOf('const attPreviewRendered = new Map();');
const PRUNE_END = messages.indexOf('const CHIP_IMG_ICON =');
const pruneSource = messages.slice(PRUNE_START, PRUNE_END);
if (PRUNE_START < 0 || PRUNE_END < 0 || !/function pruneAttPreviews/.test(pruneSource)) {
  console.error('[test] could not locate the preview-store pruning block in public/js/messages.js');
  process.exit(1);
}
const VID_START = MARK_END;
const VID_END = messages.indexOf('// ---------- stick-to-bottom on media resize ----------');
const videoSource = messages.slice(VID_START, VID_END);
if (VID_END < 0 || !/function rememberVideoPoster/.test(videoSource) || !/function requestVideoPoster/.test(videoSource)) {
  console.error('[test] could not locate the video poster block in public/js/messages.js');
  process.exit(1);
}

// A real PNG of a known shape, so the reserved box can be measured against the
// box the bytes take (same generator the other attachment tests use).
function pngBytes(w, h, shade) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      raw[i] = shade; raw[i + 1] = shade; raw[i + 2] = shade;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;background:#0e1420}
#host{width:420px;padding:10px}
/* The real message chain, with a DEFINITE column width (exactly what .body is in
   the app): the reserved box resolves its width against its containing block, and
   an indefinite one would collapse the percentage inside the width expression to
   zero and prove nothing. */
#host .body{min-width:0;width:400px}
#host *{transition:none!important}</style>
</head><body><div id="host"><div class="msg"><div class="body"><div class="text" id="text"></div><div class="msg-atts" id="atts"></div></div></div></div>
<script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize(n) { return Math.max(0, Math.round(Number(n) / 1024)) + ' KB'; }
function fmtClock() { return '0:00'; }
function toast() {}
function attMetaStub() { return ''; }
function textPreviewable() { return false; }
function textFileHTML() { return ''; }
function audioPlayerHTML(a) {
  const pending = a.scan === 'pending';
  const src = attPreviewSrc(a);
  return '<div class="vplayer" data-url="' + esc(a.url) + '"' + attMeta(a, 'audio') + '>'
    + '<audio src="' + esc(src || a.url) + '" data-fb-src="' + esc(a.url) + '" preload="metadata"></audio>'
    + attDl(a, pending) + '</div>';
}
${markSource}
// The preview store's lifetime rules and the video poster machinery, exactly as
// the app loads them (same order: the markup block, then the pruning block, then
// the poster block), over the two globals pruneAttPreviews() reads.
const S = { pendingAtts: [], uploads: [] };
const pendingByCtx = new Map();
${pruneSource}
${videoSource}
// ---- the harness ----
const host = document.getElementById('atts');
function slotOf(el) { return el.closest ? el.closest('.att-slot') : null; }
window.__render = function (att) {
  host.innerHTML = '';
  host.insertAdjacentHTML('beforeend', attachmentHTML(att));
  const slot = host.firstElementChild;
  if (att.kind === 'image') { try { wireAttImage(slot.querySelector('img.att-img')); } catch (e) {} }
  return true;
};
// The REAL patch path, exactly as a verdict broadcast drives it: the slot list is
// matched to the server's attachments and each one is handed to the patch.
window.__verdict = function (atts) {
  try { return patchAttachmentsIn(host.closest('.msg'), { attachments: atts }); } catch (e) { return 'ERR ' + e.message; }
};
// What the app does when the patch REFUSES (renderMessages): the whole list is
// thrown away and rebuilt from the model. Reproduced here so the fallback path can
// be watched the same way the patch is.
window.__fullRender = function (att) {
  host.innerHTML = '';
  host.insertAdjacentHTML('beforeend', attachmentHTML(att));
  const img = host.querySelector('img.att-img');
  if (img) { try { wireAttImage(img); } catch (e) {} }
  return true;
};
// ---- the visual timeline ----
// One sample per animation frame of what is actually on screen: the box, the
// picture's paint state, and whether the frame the reader was looking at is still
// the one in the document. A "blink" is a sample where the box stops showing a
// painted picture while the element that had been there is gone.
const timeline = [];
let tlOn = false;
let tlNode = null;
function tlSample() {
  if (!tlOn) return;
    const box = host.querySelector('.att-wrap') || host.querySelector('.scan-block');
  if (!box) { timeline.push({ t: Math.round(performance.now()), state: 'empty' }); return requestAnimationFrame(tlSample); }
  const card = box.classList.contains('scan-block');
  const img = host.querySelector('img.att-img');
  const r = box.getBoundingClientRect();
  const cs = img ? getComputedStyle(img) : null;
  timeline.push({
    t: Math.round(performance.now()),
    card,
    boxClass: box.className,
    w: Math.round(r.width), h: Math.round(r.height),
    imgOpacity: cs ? cs.opacity : null,
    imgVisible: cs ? (cs.visibility !== 'hidden' && cs.opacity !== '0') : false,
    natural: img ? img.naturalWidth : 0,
    kept: img ? img === tlNode : false,
    proc: !!host.querySelector('.att-proc'),
    src: img ? String(img.getAttribute('src') || '').slice(0, 46) : null,
  });
  requestAnimationFrame(tlSample);
}
window.__tlStart = function (att) {
  timeline.length = 0;
  const img = host.querySelector('img.att-img');
  tlNode = img || null;
  if (!tlOn) { tlOn = true; requestAnimationFrame(tlSample); }
  return true;
};
window.__tlStop = function () { tlOn = false; return timeline; };
window.__box = function () {
  const box = host.querySelector('.att-wrap');
  if (!box) return null;
  const r = box.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
};
window.__state = function () {
  const slot = host.querySelector('.att-slot');
  const img = host.querySelector('img.att-img');
  const proc = host.querySelector('.att-proc');
  const card = host.querySelector('.scan-block');
  const audio = host.querySelector('audio');
  const box = host.querySelector('.att-wrap');
  return {
    slot: !!slot,
    attId: slot ? slot.dataset.attSlot : null,
    imgTag: img ? img.tagName : null,
    imgSrc: img ? img.getAttribute('src') : null,
    imgCurrent: img ? (img.currentSrc || '') : null,
    imgFbOrig: img ? (img.dataset.fbOrig || '') : null,
    imgFbUrl: img ? (img.dataset.fbUrl || '') : null,
    imgThumb: img ? !!img.dataset.fbThumb : false,
    held: !!host.querySelector('img.att-held'),
    proc: proc ? proc.textContent.trim() : null,
    procDisplay: proc ? getComputedStyle(proc).display : null,
    card: card ? (card.querySelector('b') ? card.querySelector('b').textContent : '') : null,
    dl: !!host.querySelector('.att-dl'),
    dlHref: host.querySelector('.att-dl') ? host.querySelector('.att-dl').getAttribute('href') : null,
    audioSrc: audio ? audio.getAttribute('src') : null,
    audioFbSrc: audio ? (audio.dataset.fbSrc || '') : null,
    audioTime: audio ? audio.currentTime : null,
    boxW: box ? Math.round(box.getBoundingClientRect().width) : 0,
    boxH: box ? Math.round(box.getBoundingClientRect().height) : 0,
    boxClass: box ? box.className : '',
    ready: box ? box.classList.contains('ready') : false,
  };
};
// The node identity the whole test turns on: a rebuild replaces the element, the
// patch keeps the frame the reader was already looking at.
window.__imgNode = function () { return host.querySelector('img.att-img'); };
window.__pin = function () { window.__pinned = host.querySelector('img.att-img'); return !!window.__pinned; };
window.__sameNode = function () { const n = host.querySelector('img.att-img'); return !!n && n === window.__pinned; };
window.__localPreview = function (id, url, src) {
  setAttPreviewFor({ id, url, kind: 'image' }, src, true, 12345);
  return true;
};
// The REAL upload registration: the upload response carries no attachment id (the
// row's id is minted when the message is inserted), so the entry is keyed by the
// url the upload answered with — and the picked bytes are a blob: URL.
window.__uploadPreview = function (url, src, bytes) {
  setAttPreviewFor({ url, kind: 'image' }, src, true, bytes || 12345);
  return true;
};
window.__uploadVideoPreview = function (url, shot) {
  setAttPreviewFor({ url, kind: 'video' }, shot, false);
  return true;
};
window.__pickedBlob = function (w, h, shade) {
  const c = document.createElement('canvas');
  c.width = w || 64; c.height = h || 48;
  const g = c.getContext('2d');
  g.fillStyle = '#101418'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#' + String(shade || 0x303030).padStart(6, '0').slice(-6);
  g.fillRect(4, 4, c.width - 8, c.height - 8);
  return new Promise((res) => c.toBlob((b) => res(URL.createObjectURL(b)), 'image/png'));
};
window.__previewHas = function (url) { return !!attPreviews.get(url); };
// The composer's own repaint, which runs synchronously the moment a message is
// SENT: the list is cleared first, so nothing is staged any more.
window.__send = function () { S.pendingAtts = []; S.uploads = []; pruneAttPreviews(); return attPreviews.size; };
// A message row as the LIST paints it (the store learns from this call).
window.__noteRendered = function (att) { noteAttPreviewRendered(att); return true; };
window.__renderedKeys = function () { return [...attPreviewRendered.keys()]; };
// A clip whose poster this page already captured off the picked file.
window.__videoPoster = function (url, shot) { rememberVideoPoster(url, shot); return true; };
// Hold the verdict INSIDE the patch, and read the DOM there: whether the frame
// that was on screen is still in the new box is a fact about the synchronous
// swap, and by the time a frame later came back the bytes may already have
// landed (on a local test server they usually have).
window.__verdictAndSnapshot = function (atts) {
  window.__snap = null;
  const orig = patchImageNode;
  patchImageNode = function (oldEl, a) {
    const r = orig(oldEl, a);
    const slot = host.querySelector('.att-slot');
    const held = slot ? slot.querySelector('img.att-held') : null;
    const imgs = slot ? [...slot.querySelectorAll('img.att-img')] : [];
    const box = slot ? slot.querySelector('.att-wrap') : null;
    const rect = box ? (() => { const q = box.getBoundingClientRect(); return { w: Math.round(q.width), h: Math.round(q.height) }; })() : null;
    window.__snap = {
      ok: r, rect,
      heldInBox: !!held, heldVisible: held ? getComputedStyle(held).visibility : null,
      imgs: imgs.map((i) => ({ src: String(i.getAttribute('src')), legacySized: i.getBoundingClientRect().width < 8 })),
      dl: !!slot.querySelector('.att-dl'),
    };
    return r;
  };
  const out = patchAttachmentsIn(host.closest('.msg'), { attachments: atts });
  patchImageNode = orig;
  const finalBox = host.querySelector('.att-wrap');
  const bodyEl = document.querySelector('#atts');
  return {
    out, snap: window.__snap,
    boxStyle: finalBox ? finalBox.getAttribute('style') : null,
    bodyW: bodyEl ? Math.round(bodyEl.getBoundingClientRect().width) : null,
    slotW: host.querySelector('.att-slot') ? Math.round(host.querySelector('.att-slot').getBoundingClientRect().width) : null,
  };
};
// The picked bytes, for real: a small canvas PNG as a data URL. The preview
// source has to be bytes this browser can actually paint, or nothing below can
// observe the hand-over (a broken src never fires load, so the old frame stays).
window.__pickedBytes = function (w, h, shade) {
  const c = document.createElement('canvas');
  c.width = w || 64; c.height = h || 48;
  const g = c.getContext('2d');
  g.fillStyle = '#101418'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#' + String(shade || 0x303030).padStart(6, '0').slice(-6);
  g.fillRect(4, 4, c.width - 8, c.height - 8);
  return c.toDataURL('image/png');
};
window.__whenPainted = function () {
  const img = host.querySelector('img.att-img');
  if (!img) return Promise.resolve(false);
  if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
  return new Promise((res) => {
    img.addEventListener('load', () => res(true), { once: true });
    img.addEventListener('error', () => res(false), { once: true });
    setTimeout(() => res(!!(img.complete && img.naturalWidth > 0)), 3000);
  });
};
window.__previewStore = function () { return { size: attPreviews.size, bytes: attPreviewBytes }; };
</script></body></html>`;
}

async function main() {
  console.log('\n[1] the pending rendering is the real media, not a spinner card');
  check(/function attPendingPreview\(a\)/.test(markSource), 'a pending attachment asks for its picked bytes');
  check(/const local = attPendingStandIn\(a\);\s*\n\s*if \(pending && !local\) return `<div class="scan-block scanning"/.test(markSource),
    'the scanning card is now the FALLBACK (no local preview: another device, a reload, a non-media upload, a clip)');
  check(/function attPendingStandIn\(a\) \{/.test(markSource) && /a\.kind !== 'video'/.test(markSource),
    'and it is kind-aware: a clip\'s entry in the store is a still frame, so a pending clip is never painted from it');
  check(!/attProcHTML/.test(markSource) && !/att-proc/.test(markSource),
    'a pending media attachment carries NO processing chip over it (owner request: the corner chip is gone)');
  check(!/\.att-proc/.test(css), 'and the stylesheet carries no chip either');
  check(/const preview = shot \? shot\.src : \(pending \? attPreviewSrc\(a\) : ''\);/.test(markSource) && /src="\$\{esc\(preview \|\| thumb \|\| a\.url\)\}"/.test(markSource),
    'a pending picture paints the picked bytes, falling back to its derived preview and then its own url');
  check(/function attShot\(a\)/.test(markSource) && /const picked = \/\^blob:\/\.test\(String\(hit\.src \|\| ''\)\);/.test(markSource),
    'only the uploading browser\'s own copy (a blob url) or a pending upload counts as a stand-in — a clean file renders its own bytes and preview as before');
  check(/data-fb-orig="\$\{esc\(a\.url\)\}"/.test(markSource), 'the element still records the url it will fall back to');
  check(/function attVideoHTML\(a, opts\)/.test(markSource) && /data-fb-src="\$\{esc\(a\.url\)\}"/.test(markSource),
    'a clip is a player from the start, carrying the CLEAN source it will swap to');
  check(/src="\$\{esc\(a\.url\)\}"/.test(markSource) && !/src="\$\{esc\(shot/.test(markSource),
    'and it is pointed at its OWN bytes — a still frame is the poster, never the source (a <video> fed an image is a broken element)');
  check(/function attPickedFrame\(a\)/.test(markSource) && /poster="\$\{esc\(poster\)\}"/.test(markSource),
    'the frame this page holds is carried as the poster instead');
  check(/attDl\(a, pending\)/.test(markSource) && /attFavHTML\(a, pending\)/.test(markSource),
    'the download link and the star wait for the final bytes (nothing to save or star yet)');
  check(/function attDl\(a, pending\) \{ return pending \? '' :/.test(markSource), 'and that is what attDl does with the flag');

  console.log('\n[2] the verdict is applied to the element, never to the list');
  check(/function patchAttachmentNode\(oldEl, a\)/.test(markSource), 'the per-attachment patch exists');
  check(/function patchAttachmentsIn\(node, m\)/.test(markSource), 'and the per-message one that walks the slots');
  check(/if \(slots\.length !== atts\.length\) return false;/.test(markSource), 'a slot list that no longer lines up is refused (the renderer rebuilds it)');
  check(/data-att-slot="\$\{esc\(a\.id \|\| ''\)\}"/.test(markSource), 'each rendering is keyed by the attachment id, which survives a republish');
  check(/if \(oldRole !== newRole\) return false;/.test(markSource), 'an attachment whose KIND changed is refused');
  check(/if \(a\.scan === 'infected'\) return false;/.test(markSource),
    'and a file the scanner REMOVED is refused — its bytes are gone, so only the renderer can show the warning card');
  check(/if \(!attSameShape\(oldAr, newAr\)\) return false;/.test(markSource), 'so is one whose reserved shape changed');
  check(/function patchImageNode\(oldEl, a\)/.test(markSource) && /function srcPathOf\(u\)/.test(markSource),
    'the still swap compares the FILE the element is showing, not the url string');
  check(/const rawSrc = String\(img\.getAttribute\('src'\) \|\| ''\);/.test(markSource) && /img\.setAttribute\('src', rawSrc\);/.test(markSource),
    'the replacement keeps its real source (an <img> with no source at all is a broken-image box) and loads behind its own placeholder');
  check(/const reveal = \(\) => \{[\s\S]{0,140}if \(!\(img\.complete && img\.naturalWidth > 0\)\) return;/.test(markSource),
    'and the reveal demands bytes that are really there (`complete` is true for a failed load too — revealing on it is the blank/broken frame)');
  check(/if \(oldImg && oldImg\.dataset\.phWired && shownPath && shownPath === wantPath\) \{/.test(markSource),
    'and the same file leaves the painted element exactly as it is (a republish in place must not re-decode it)');
  check(/if \(oldImg\.dataset\.fbUrl\) oldImg\.dataset\.fbUrl = String\(a\.url \|\| ''\);/.test(markSource),
    'while the identity the menus and the lightbox read follows the published url');
  check(/oldImg\.classList\.add\('att-held'\)/.test(markSource) && /img\.att-img\.att-held/.test(css),
    'and holds the frame that is on screen until the new bytes land');
  check(/function patchAudioNode\(oldEl, a\)/.test(markSource) && /audio\.dataset\.fbSrc = String\(a\.url \|\| ''\)/.test(markSource),
    'a voice note moves its <audio> source, so the player keeps its position and chrome');
  check(/function retireAttPreview\(a, oldUrl\)/.test(markSource) && /retireAttPreview\(a, oldUrl\)/.test(markSource),
    'the picked bytes are released once the published file is what is loaded — under the id AND the url the element was showing');
  // What is carried across a republish, and for how long the picked bytes live:
  // both were narrower than the flow they have to survive (see [13]/[14]).
  check(/if \(oldImg && oldImg\.complete && oldImg\.naturalWidth > 0 && oldImg\.getAttribute\('src'\) !== rawSrc\)/.test(markSource),
    'the frame carried over is the one that is really painted — whoever fetched it, not only this browser\'s picked copy');
  check(/const seen = attPreviewRendered\.get\(entry\.id\) \|\| attPreviewRendered\.get\(entry\.url\)/.test(pruneSource),
    'a painted row is found by the attachment id OR by the url the picked bytes were registered under');
  check(/for \(const k of \[String\(a\.id \|\| ''\), String\(a\.url \|\| ''\)\]\)/.test(pruneSource),
    'because the upload response has no id: the url is the only key in the upload -> post window');
  check(/LOCAL_PREVIEW_UNPAINTED_MS/.test(messages) && /entry\.unstagedAt/.test(pruneSource),
    'an entry nothing has painted yet gets a grace window instead of being released as a dropped file');
  check(/revealVideoShell\(nextVid\)/.test(markSource),
    'a replaced clip lifts the loading shell when it already has its frame');
  check(/\^data:\/\.test\(String\(prev\.src \|\| ''\)\)/.test(markSource),
    'and borrows the picked frame when no poster was captured for the source on screen');

  console.log('\n[3] the wiring asks for the patch before it rebuilds');
  check(/patchMessageAttachmentsInList\(m\.message\.id, m\.message,/.test(socket), 'message-updated patches the attachments first');
  check(/case 'dm-updated':[\s\S]{0,600}patchMessageAttachmentsInList\(m\.message\.id, m\.message,/.test(socket),
    'so does dm-updated (a DM photo or voice note must not blink either)');
  const upBlock = socket.slice(socket.indexOf("case 'message-updated'"), socket.indexOf("case 'reaction-update'"));
  check(/!upOnScreen\)\) renderMessages\(\)/.test(upBlock) || /!upOnScreen && !inHistUp\)/.test(upBlock) || /&& !upOnScreen\) renderMessages/.test(upBlock),
    'and the full rebuild is skipped for a message that is on screen');
  check(/function messageAttachmentsOnScreen\(/.test(messages), 'the "is this row painted" question is a helper of its own');
  check(/setAttPreviewFor\(data, URL\.createObjectURL\(u\.file\), true, u\.file\.size\)/.test(messages),
    'the upload path registers the picked bytes against the attachment id, with its byte size for the cap');
  check(/LOCAL_PREVIEW_CAP_BYTES/.test(messages) && /if \(attPreviewStaged\.has\(k\)\) continue;/.test(messages),
    'the preview store is bounded, and never evicts a file still sitting in a composer');
  check(/function noteAttPreviewRendered\(a\)/.test(messages) && /for \(const a of m\.attachments\) noteAttPreviewRendered\(a\);/.test(messages),
    'the list reports which attachments it painted, so a preview dropped before posting is not kept forever');
  check(/if \(!seen\.done\) continue;/.test(messages) && /a\.scan === 'clean' \|\| a\.scan === 'infected'/.test(messages),
    'and a file still waiting on the slot keeps its picked bytes (never a spinner back where the picture is)');

  const chromePath = findChrome();
  if (!chromePath) {
    console.log('\n[4] SKIP the browser half: no Chrome/Edge found (set CHROME_PATH)');
    return finish();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pending-'));
  const png = pngBytes(64, 48, 0x30);
  const pngOther = pngBytes(48, 64, 0x60);   // a different shape: the patch must refuse it
  // The slow preview: the handler parks the response until the test releases it,
  // so "the verdict landed while the bytes were still coming" is a fact. The two
  // `newkey*` previews are the same trick for the republish-under-a-new-key case:
  // on the live box that preview has to be MINTED first, so the gap is real.
  let slowWait = null;
  let newHold = null;
  let newHold2 = null;
  const hits = [];
  const srv = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageHtml());
    }
    hits.push(url);
    const serve = (buf, type) => {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
      res.end(buf);
    };
    if (url === '/uploads/thumbs/files/slow.jpg.webp') {
      slowWait = { resolve: () => serve(png, 'image/png') };
      return;
    }
    if (url === '/uploads/thumbs/files/newkey.webp.webp') {
      newHold = { resolve: () => serve(png, 'image/png') };
      return;
    }
    if (url === '/uploads/thumbs/files/newkey2.webp.webp') {
      newHold2 = { resolve: () => serve(png, 'image/png') };
      return;
    }
    if (url === '/uploads/thumbs/files/pic.jpg.webp') return serve(png, 'image/png');
    if (url === '/uploads/thumbs/files/other.jpg.webp') return serve(pngOther, 'image/png');
    if (url === '/uploads/thumbs/files/tl.jpg.webp') return serve(png, 'image/png');
    if (url === '/uploads/thumbs/files/tl2.jpg.webp') return serve(pngOther, 'image/png');
    if (url.startsWith('/uploads/files/')) return serve(png, 'image/png');
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;

  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=520,640', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(250); }
    }
    if (!info) return skip('Chrome never opened its DevTools port');

    ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
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
    await sleep(400);
    if (!(await evaluate('typeof window.__render === "function"'))) {
      console.error('[test] the extracted messages.js block did not evaluate in the page');
      process.exit(1);
    }

    console.log('\n[4] pending: the picked bytes are on screen, with nothing over them');
    // The attachment as the server first sends it, WITH the local registration the
    // upload path made (id + url + the picked bytes as a real data URL).
    const picked = await evaluate('window.__pickedBytes(120, 120, 0x303030)');
    await evaluate(`window.__localPreview('att-1', '/uploads/files/pic.jpg?v=1', ${JSON.stringify(picked)})`);
    await evaluate(`window.__render({ id: 'att-1', kind: 'image', scan: 'pending', url: '/uploads/files/pic.jpg?v=1', name: 'pic.jpg', size: 20480, w: 2500, h: 2500 })`);
    check(await evaluate('window.__whenPainted()') === true, 'the picked bytes paint');
    const p0 = await evaluate('window.__state()');
    check(p0.slot && p0.attId === 'att-1', 'the attachment renders inside its id-keyed slot', p0);
    check(!p0.card, 'no spinner card — the media itself is what the reader sees', p0);
    check(p0.imgSrc && p0.imgSrc.startsWith('data:'), 'the picture paints the picked bytes while the slot holds the bytes back', p0);
    check(p0.proc === null, 'and no processing chip is painted over the picture', p0);
    check(!p0.dl, 'with nothing to download yet', p0);
    check(p0.boxW > 0 && p0.boxH > 0, 'the box is on screen at a real size (the stored 2500px shape, capped by CSS)', p0);

    console.log('\n[5] the verdict swaps the bytes under the same node');
    await evaluate('window.__pin()');
    const step = await evaluate(`window.__verdictAndSnapshot([{ id: 'att-1', kind: 'image', scan: 'clean', url: '/uploads/files/pic.jpg?v=2', name: 'pic.jpg', size: 15200, w: 2500, h: 2500 }])`);
    // The box is rebuilt from the real markup on the spot — and the picture that
    // was on screen is carried into it in the same tick, so what the reader is
    // looking at never changes and nothing is ever an empty box.
    const snap = step.snap || {};
    check(snap.heldInBox === true, 'the frame that was on screen is carried into the new box in the same tick', snap);
    check(snap.heldVisible === 'visible', 'and it is the visible thing there', snap);
    check(snap.rect && snap.rect.w > 0 && snap.rect.h > 0, 'the box keeps its size across the swap', snap);
    // The carried frame stays until the published bytes are REALLY there (a load
    // that failed leaves it in place rather than showing an empty box), and the
    // published picture takes the box over the moment they are.
    let placed = null;
    for (let i = 0; i < 100; i++) {
      placed = await evaluate(`(function () { const w = host.querySelector('.att-wrap'); const im = w && w.querySelector('img.att-img'); return im ? { src: String(im.getAttribute('src') || ''), w: Math.round(im.getBoundingClientRect().width), natural: im.naturalWidth, held: !!w.querySelector('.att-held') } : null; })()`);
      if (placed && /pic\.jpg\.webp\?v=2/.test(placed.src) && !placed.held && placed.natural > 0) break;
      await sleep(100);
    }
    check(!!placed && /pic\.jpg\.webp\?v=2/.test(placed.src) && placed.natural > 0,
      'the published picture takes the box over once its bytes are really there', placed);
    check(placed && placed.w > 0, 'in a box that never collapsed', placed);
    check(placed && placed.held === false, 'and the carried frame goes with it', placed);
    check(snap.dl === true, 'the download link arrived with the verdict', snap);
    const landing = await evaluate('window.__state()');
    check(landing.proc === null, 'and no chip ever appeared over it, before or after the verdict', landing);
    for (let i = 0; i < 100 && !/pic\.jpg\.webp\?v=2/.test((await evaluate('window.__state()')).imgSrc || ''); i++) await sleep(100);
    const s1 = await evaluate('window.__state()');
    check(await evaluate('window.__whenPainted()') === true, 'the published preview lands and paints', s1);
    check(/pic\.jpg\.webp\?v=2/.test(s1.imgSrc || ''), 'the element now belongs to the final bytes', s1);
    check(s1.imgThumb && s1.imgFbOrig === '/uploads/files/pic.jpg?v=2' && s1.imgFbUrl === '/uploads/files/pic.jpg?v=2',
      'pointing at the derived preview with the published url as the fallback', s1);
    check(s1.dl && s1.dlHref === '/uploads/files/pic.jpg?v=2', 'the link opens the published file', s1);
    check(!s1.held, 'the held frame is dropped once the new bytes are up', s1);
    check(s1.ready, 'the placeholder is lifted', s1);

    console.log('\n[6] a republish in place never re-points the painted picture');
    // The everyday case: the compressor settled the file by rewriting the SAME
    // key, so the verdict carries the same thumbnail behind a fresh ?v=. That is
    // the same picture on disk — re-pointing the <img> at it would throw the
    // painted frame away and decode it again, which is the blink itself.
    const beforeRepublish = (await evaluate('window.__state()')).imgSrc;
    const samePath = await evaluate(`window.__verdict([{ id: 'att-1', kind: 'image', scan: 'clean', url: '/uploads/files/pic.jpg?v=3', name: 'pic.jpg', size: 15200, w: 2500, h: 2500 }])`);
    check(samePath === true, 'the patch reports the change applied', samePath);
    const afterRepublish = await evaluate('window.__state()');
    check(afterRepublish.imgSrc === beforeRepublish,
      'the painted source is untouched (no re-point, no re-decode, no blink)', { before: beforeRepublish, after: afterRepublish.imgSrc });
    check(afterRepublish.imgFbUrl === '/uploads/files/pic.jpg?v=3',
      'while the identity the menus and the lightbox read moved to the published url', afterRepublish);
    check(afterRepublish.dl && afterRepublish.dlHref === '/uploads/files/pic.jpg?v=3', 'and so did the download link', afterRepublish);

    console.log('\n[7] the frame on screen survives a slow preview');
    // The verdict arrives while the final preview is NOT ready: the reader keeps
    // looking at the picture they were looking at, never at an empty box. The
    // request is held open by the server until this test lets it go, so the
    // ordering is a fact rather than a race.
    const picked2 = await evaluate('window.__pickedBytes(120, 120, 0x404040)');
    await evaluate(`window.__localPreview('att-2', '/uploads/files/slow.jpg?v=1', ${JSON.stringify(picked2)})`);
    await evaluate(`window.__render({ id: 'att-2', kind: 'image', scan: 'pending', url: '/uploads/files/slow.jpg?v=1', name: 'slow.jpg', size: 20480, w: 2500, h: 2500 })`);
    check(await evaluate('window.__whenPainted()') === true, 'the picked bytes paint');
    await evaluate('window.__pin()');
    const slowStep = await evaluate(`window.__verdictAndSnapshot([{ id: 'att-2', kind: 'image', scan: 'clean', url: '/uploads/files/slow.jpg?v=2', name: 'slow.jpg', size: 15200, w: 2500, h: 2500 }])`);
    check(slowStep.out === true, 'the patch is applied even though the preview is in flight', slowStep);
    // Read inside the patch's own tick: the frame that was on screen is in the
    // new box, and the box is the reserved one — while the new bytes are still
    // on the wire.
    const slowSnap = slowStep.snap || {};
    check(slowSnap.heldInBox === true, 'the picture the reader was looking at is carried over, not replaced by an empty box', slowSnap);
    check(slowSnap.rect && slowSnap.rect.h > 0, 'and the box keeps the reserved size while the request is open', slowSnap);
    for (let i = 0; i < 50 && !slowWait; i++) await sleep(100);
    check(!!slowWait, 'the published preview really is in flight (the server is holding it)', { hits });
    check((await evaluate('window.__state()')).proc === null, 'while there is still no chip in the corner (there never is one)', {});
    if (slowWait) slowWait.resolve();
    for (let i = 0; i < 100 && !/slow\.jpg\.webp\?v=2/.test((await evaluate('window.__state()')).imgSrc || ''); i++) await sleep(100);
    const done = await evaluate('window.__state()');
    check(/slow\.jpg\.webp\?v=2/.test(done.imgSrc || ''), 'the swap lands when the bytes do', done);
    check(!done.held, 'and the held frame goes with it', done);
    const endBox = await evaluate('window.__box()');
    check(endBox && endBox.h === slowSnap.rect.h, 'with the box still the same one', { endBox, before: slowSnap.rect });

    console.log('\n[8] a change the patch cannot make is refused, not half-applied');
    await evaluate(`window.__localPreview('att-3', '/uploads/files/other.jpg?v=1', 'data:image/png;base64,')`);
    await evaluate(`window.__render({ id: 'att-3', kind: 'image', scan: 'pending', url: '/uploads/files/other.jpg?v=1', name: 'other.jpg', size: 20480, w: 2500, h: 2500 })`);
    const beforeWrong = await evaluate('window.__imgNode() && true');
    check(beforeWrong === true, 'the pending row is rendered', { beforeWrong });
    const refused = await evaluate(`window.__verdict([{ id: 'att-3', kind: 'image', scan: 'clean', url: '/uploads/files/other.jpg?v=2', name: 'other.jpg', size: 15200, w: 2500, h: 800 }])`);
    check(refused === false, 'a published shape that no longer matches the reserved one is refused (the list rebuilds instead)', refused);
    const afterWrong = await evaluate('window.__state()');
    check(afterWrong.imgFbOrig === '/uploads/files/other.jpg?v=1' && afterWrong.proc === null,
      'and the row is left exactly as it was — never half-patched, and chip-free', afterWrong);
    const refusedKind = await evaluate(`(function () {
      window.__render({ id: 'att-4', kind: 'image', scan: 'pending', url: '/uploads/files/other.jpg?v=1', name: 'other.jpg', size: 20480, w: 2500, h: 2500 });
      return window.__verdict([{ id: 'att-4', kind: 'file', scan: 'clean', url: '/uploads/files/other.jpg?v=2', name: 'other.jpg', size: 15200 }]);
    })()`);
    check(refusedKind === false, 'a card that became a picture (a HEIC converted to JPEG) is refused too', refusedKind);
    // A verdict that REMOVED the file cannot be patched in place either: the bytes
    // are gone and the rendering has to become the warning card the renderer builds.
    const removed = await evaluate(`(function () {
      window.__render({ id: 'att-x', kind: 'image', scan: 'clean', url: '/uploads/files/pic.jpg?v=1', name: 'pic.jpg', size: 20480, w: 2500, h: 2500 });
      const ok = window.__verdict([{ id: 'att-x', kind: 'image', scan: 'infected', url: '/uploads/files/pic.jpg?v=1', name: 'pic.jpg', size: 20480, w: 2500, h: 2500 }]);
      return { ok, img: !!host.querySelector('img.att-img') };
    })()`);
    check(removed.ok === false, 'and an infected verdict is refused (the renderer replaces the picture with the warning card)', removed);
    const removedCard = await evaluate(`(function () {
      window.__fullRender({ id: 'att-x', kind: 'image', scan: 'infected', url: '/uploads/files/pic.jpg?v=1', name: 'pic.jpg', size: 20480, w: 2500, h: 2500 });
      return { card: !!host.querySelector('.scan-block.infected'), img: !!host.querySelector('img.att-img') };
    })()`);
    check(removedCard.card === true && removedCard.img === false, 'which is what the rebuilt row shows', removedCard);

    console.log('\n[9] a voice note keeps its player');
    await evaluate(`window.__render({ id: 'att-5', kind: 'audio', scan: 'clean', url: '/uploads/files/note.m4a?v=1', name: 'note.m4a', size: 4096 })`);
    const audioBefore = await evaluate('window.__state()');
    await evaluate('(function () { const a = document.querySelector("audio"); try { a.currentTime = 1.5; } catch (e) {} })()');
    const audioDone = await evaluate(`(function () {
      const ok = window.__verdict([{ id: 'att-5', kind: 'audio', scan: 'clean', url: '/uploads/files/note.m4a?v=2', name: 'note.m4a', size: 4096 }]);
      return { ok, state: window.__state() };
    })()`);
    check(audioDone.ok === true, 'an audio url change patches in place', audioDone);
    check(audioDone.state.audioFbSrc === '/uploads/files/note.m4a?v=2' && /note\.m4a\?v=2$/.test(audioDone.state.audioSrc || ''),
      'the <audio> is re-sourced to the published file', audioDone.state);
    check((audioDone.state.audioTime || 0) > 0.5, 'and the playhead was NOT reset (the player was not rebuilt)', audioDone.state);

    console.log('\n[10] a clip settled in place keeps its player');
    // The everyday republish: same file, fresh ?v=. A replaced <video> would drop
    // whatever the reader had loaded (poster, position) for a file it already has.
    const vidBefore = await evaluate(`(function () {
      window.__render({ id: 'att-6', kind: 'video', scan: 'clean', url: '/uploads/files/clip.mp4?v=1', name: 'clip.mp4', size: 20480, w: 1920, h: 1080 });
      const v = document.querySelector('video.att-vid');
      window.__vidNode = v;
      try { v.currentTime = 0.4; } catch (e) {}
      return { src: v.getAttribute('src'), node: !!v };
    })()`);
    check(vidBefore.node === true, 'the clip renders as a player', vidBefore);
    const vidDone = await evaluate(`(function () {
      const ok = window.__verdict([{ id: 'att-6', kind: 'video', scan: 'clean', url: '/uploads/files/clip.mp4?v=2', name: 'clip.mp4', size: 20000, w: 1920, h: 1080 }]);
      const v = document.querySelector('video.att-vid');
      return { ok, sameNode: v === window.__vidNode, src: v && v.getAttribute('src'), time: v ? v.currentTime : null };
    })()`);
    check(vidDone.ok === true, 'the patch reports the change applied', vidDone);
    check(vidDone.sameNode === true, 'the SAME <video> element is still there (a replaced one restarts, and loses its poster)', vidDone);
    check(vidDone.src === vidBefore.src, 'and its source was never re-pointed at the same file', { before: vidBefore.src, after: vidDone.src });
    check((vidDone.time || 0) > 0.2, 'so its position survived too', vidDone);

    console.log('\n[11] the verdict never takes a painted picture off the screen');
    // The whole reported symptom, watched frame by frame: from the message that is
    // on screen with the picked bytes, through the compressor's verdict, to the
    // settled row. A frame that shows the box WITHOUT a painted picture — or with
    // a scan card where the picture was — is the blink.
    const pickedT = await evaluate('window.__pickedBytes(120, 120, 0x515151)');
    await evaluate(`window.__localPreview('att-t', '/uploads/files/tl.jpg?v=1', ${JSON.stringify(pickedT)})`);
    await evaluate(`window.__render({ id: 'att-t', kind: 'image', scan: 'pending', url: '/uploads/files/tl.jpg?v=1', name: 'tl.jpg', size: 20480, w: 2500, h: 2500 })`);
    check(await evaluate('window.__whenPainted()') === true, 'the message on screen paints the picked bytes');
    await evaluate('window.__tlStart()');
    await sleep(150);
    const started = await evaluate('window.__tlStart()');   // re-arm with the current node
    const live = await evaluate(`window.__verdict([{ id: 'att-t', kind: 'image', scan: 'clean', url: '/uploads/files/tl.jpg?v=2', name: 'tl.jpg', size: 15200, w: 2500, h: 2500 }])`);
    const verdictAt = Date.now();
    check(live === true, 'the compressor verdict is applied to the element', live);
    await sleep(600);
    const frames = await evaluate('window.__tlStop()');
    check(Array.isArray(frames) && frames.length > 10, 'the timeline has frames to judge', { n: frames && frames.length });
    // Before the verdict: painted, on the picked bytes.
    const first = frames[0] || {};
    check(first.imgVisible === true && first.w > 0, 'frame one: a painted picture in a sized box', first);
    // Every frame of the hand-over must show a painted picture: either the frame
    // that was there (kept) or the newly painted published one.
    const blankFrames = frames.filter((f) => !f.imgVisible || f.card || f.w === 0);
    const blank = blankFrames.filter((f) => f.t >= verdictAt);
    check(blank.length === 0, 'no frame ever shows an unpainted box (or a scan card) where the picture is', blank.slice(0, 3));
    // The picture that is on screen must be the one the reader already had, or the
    // published one — never an element with no bytes.
    const paintedFrames = frames.filter((f) => f.imgVisible && f.natural > 0).length;
    check(paintedFrames > frames.length - 3, 'and every frame of the hand-over shows a picture with bytes behind it', { painted: paintedFrames, total: frames.length });
    const last = frames[frames.length - 1] || {};
    check(/tl\.jpg\.webp\?v=2/.test(last.src || ''), 'and the row settles on the published bytes', last);
    check(!last.proc && frames.every((f) => !f.proc), 'and not one frame of the hand-over carried a processing chip', last);

    console.log('\n[12] the same, for the renderer fallback (when the patch refuses)');
    // A republish that changes the aspect refuses in the patch, and the app falls
    // back to a full rebuild. That rebuild must not be a blank flash either: the
    // pending row keeps the picked bytes and the box it reserved.
    const pickedF = await evaluate('window.__pickedBytes(120, 120, 0x616161)');
    await evaluate(`window.__localPreview('att-f', '/uploads/files/tl2.jpg?v=1', ${JSON.stringify(pickedF)})`);
    await evaluate(`window.__render({ id: 'att-f', kind: 'image', scan: 'pending', url: '/uploads/files/tl2.jpg?v=1', name: 'tl2.jpg', size: 20480, w: 2500, h: 2500 })`);
    check(await evaluate('window.__whenPainted()') === true, 'the picked bytes paint');
    const refusedT = await evaluate(`window.__verdict([{ id: 'att-f', kind: 'image', scan: 'clean', url: '/uploads/files/tl2.jpg?v=2', name: 'tl2.jpg', size: 15200, w: 2500, h: 800 }])`);
    check(refusedT === false, 'the patch refuses the reshaped republish', refusedT);
    await evaluate(`window.__fullRender({ id: 'att-f', kind: 'image', scan: 'pending', url: '/uploads/files/tl2.jpg?v=1', name: 'tl2.jpg', size: 20480, w: 2500, h: 2500 })`);
    const afterFull = await evaluate('window.__state()');
    check(afterFull.proc === null && !!afterFull.imgSrc && afterFull.imgSrc.startsWith('data:'),
      'the rebuilt row still paints the picked bytes, with nothing over them (the renderer keeps the store too)', afterFull);
    check(afterFull.boxW > 0 && afterFull.boxH > 0, 'and the box it reserved is on screen, not a collapsed line', afterFull);

    console.log('\n[13] the picked bytes survive the SEND (the upload path carries no id)');
    // The reported second half: "when an image is compressed it disappears and
    // comes back". The message is sent from the composer, which clears its list
    // synchronously while the echo that paints the row arrives a socket round trip
    // later — and the entry was keyed by the UPLOAD URL only (the row's id is
    // minted at insert), so the prune in that gap read it as "dropped before it had
    // an id" and revoked the blob. The row then fetched the original file, and the
    // compressor's republish under a fresh key had no frame left to carry.
    const blobUrl = await evaluate('window.__pickedBlob(120, 120, 0x717171)');
    await evaluate(`window.__uploadPreview('/uploads/files/sent.png?v=1', ${JSON.stringify(blobUrl)}, 20480)`);
    await evaluate(`window.__render({ id: 'att-s', kind: 'image', scan: 'pending', url: '/uploads/files/sent.png?v=1', name: 'sent.png', size: 20480, w: 2500, h: 2500 })`);
    check(await evaluate('window.__whenPainted()') === true, 'the picked bytes paint while the slot holds the file back');
    const afterSend = await evaluate(`(function () { window.__send(); return window.__previewHas('/uploads/files/sent.png?v=1'); })()`);
    check(afterSend === true, 'sending the message does NOT release the picked bytes (the echo is still in flight)', { afterSend });
    await evaluate(`window.__noteRendered({ id: 'att-s', kind: 'image', scan: 'clean', url: '/uploads/files/sent.png?v=1', name: 'sent.png', size: 20480 })`);
    await evaluate(`window.__render({ id: 'att-s', kind: 'image', scan: 'clean', url: '/uploads/files/sent.png?v=1', name: 'sent.png', size: 20480, w: 2500, h: 2500 })`);
    const echoed = await evaluate('window.__state()');
    check(String(echoed.imgSrc || '').startsWith('blob:'), 'and the row that arrives paints those very bytes — no fetch of the original at all', echoed);
    check((await evaluate('window.__renderedKeys()')).includes('/uploads/files/sent.png?v=1'),
      'the painted row is recorded under the url the picked bytes were registered with');
    // The republish: a NEW key, whose preview the server has to mint — held open
    // here, so the gap is as real as it is on the box.
    await evaluate('window.__pin()');
    await evaluate('window.__tlStart()');
    await sleep(120);
    const newKeyStep = await evaluate(`window.__verdictAndSnapshot([{ id: 'att-s', kind: 'image', scan: 'clean', url: '/uploads/files/newkey.webp?v=2', name: 'sent.webp', size: 15200, w: 2500, h: 2500 }])`);
    check(newKeyStep.out === true, 'the republish under a new key is applied to the element', newKeyStep);
    check(newKeyStep.snap && newKeyStep.snap.heldInBox === true,
      'with the frame the reader was looking at carried into the new box', newKeyStep.snap);
    for (let i = 0; i < 50 && !newHold; i++) await sleep(100);
    check(!!newHold, 'the new file\'s preview really is in flight (the server is holding it)', { hits });
    await sleep(250);
    const heldFrames = await evaluate('window.__tlStop()');
    check(Array.isArray(heldFrames) && heldFrames.length > 5, 'the timeline has frames to judge', { n: heldFrames && heldFrames.length });
    const blankHeld = heldFrames.filter((f) => !f.imgVisible || f.card || f.w === 0);
    check(blankHeld.length === 0, 'no frame shows an empty box while the new bytes are minted', blankHeld.slice(0, 3));
    if (newHold) newHold.resolve();
    for (let i = 0; i < 100 && !/newkey\.webp\.webp\?v=2/.test((await evaluate('window.__state()')).imgSrc || ''); i++) await sleep(100);
    const settled = await evaluate('window.__state()');
    check(/newkey\.webp\.webp\?v=2/.test(settled.imgSrc || ''), 'the row settles on the published preview once those bytes land', settled);
    check(!settled.held, 'and the carried frame goes with it', settled);

    console.log('\n[14] a reader with NO picked copy keeps the frame on screen too');
    // The same republish, on a device that never held the file: the element is
    // showing the original's own derived preview, and that is what has to be
    // carried — the store has no entry for it at all.
    await evaluate(`window.__render({ id: 'att-r', kind: 'image', scan: 'clean', url: '/uploads/files/pic.jpg?v=1', name: 'pic.jpg', size: 20480, w: 2500, h: 2500 })`);
    check(await evaluate('window.__whenPainted()') === true, 'the original\'s preview paints');
    await evaluate('window.__pin()');
    await evaluate('window.__tlStart()');
    await sleep(120);
    const readerStep = await evaluate(`window.__verdictAndSnapshot([{ id: 'att-r', kind: 'image', scan: 'clean', url: '/uploads/files/newkey2.webp?v=2', name: 'pic.webp', size: 15200, w: 2500, h: 2500 }])`);
    check(readerStep.out === true && readerStep.snap && readerStep.snap.heldInBox === true,
      'the file that is on screen is carried into the republished box', readerStep.snap);
    for (let i = 0; i < 50 && !newHold2; i++) await sleep(100);
    check(!!newHold2, 'the republished preview is in flight (the server is holding it)');
    await sleep(250);
    const readerFrames = await evaluate('window.__tlStop()');
    const readerBlank = readerFrames.filter((f) => !f.imgVisible || f.card || f.w === 0);
    check(readerBlank.length === 0, 'and no frame of that swap is an empty box either', readerBlank.slice(0, 3));
    if (newHold2) newHold2.resolve();

    console.log('\n[15] a pending clip is the processing card, and its frame becomes the poster');
    // Reported: "a video uploaded just fails to render — it doesn't say processing
    // with the loading until you refresh the page." The store's entry for a clip is
    // a still FRAME, not the clip's bytes, so the pending render used to hand that
    // frame to <video src>: the browser refuses an image as a media source, and the
    // failed load ALSO lifted the loading shell — a dead player where a reload
    // showed the honest "Processing file" card. Now the clip waits on that card and
    // the frame is the poster of the player the verdict lands.
    const shotData = await evaluate('window.__pickedBytes(64, 36, 0x919191)');
    // Exactly what the upload path registers for a clip: the captured frame under
    // the attachment's url (the upload response carries no id), and the same frame
    // in the poster cache so the player never refetches one it already has.
    await evaluate(`window.__uploadVideoPreview('/uploads/files/clip.webm?v=1', ${JSON.stringify(shotData)})`);
    await evaluate(`window.__videoPoster('/uploads/files/clip.webm?v=1', ${JSON.stringify(shotData)})`);
    const clipPending = await evaluate(`(function () {
      window.__render({ id: 'att-v', kind: 'video', scan: 'pending', url: '/uploads/files/clip.webm?v=1', name: 'clip.webm', size: 40960, w: 1280, h: 720 });
      const card = document.querySelector('#atts .scan-block');
      return {
        card: !!card,
        scanning: card ? card.classList.contains('scanning') : false,
        text: card ? card.textContent.trim() : '',
        player: !!document.querySelector('video.att-vid'),
        slot: !!document.querySelector('#atts .att-slot'),
      };
    })()`);
    check(clipPending.card && clipPending.scanning, 'a pending clip waits on the scanning card', clipPending);
    check(/Processing file/.test(clipPending.text) && /clip\.webm/.test(clipPending.text),
      'which names the file and says what is happening (the state a refresh already showed)', clipPending);
    check(clipPending.player === false, 'and no <video> is ever built from a frame that is not its bytes', clipPending);
    check(clipPending.slot === false, 'the card is the whole rendering (the verdict re-renders the row, as for every other reader)');
    // The verdict lands: the card is not a patch target, so the list renders the
    // final attachment — and the frame the sender still holds is its poster, in the
    // same tick, with the loading shell already off.
    const clipNow = await evaluate(`(function () {
      window.__fullRender({ id: 'att-v', kind: 'video', scan: 'clean', url: '/uploads/files/clip.webm?v=2', name: 'clip.webm', size: 40960, w: 1280, h: 720 });
      const v = document.querySelector('video.att-vid');
      const wrap = document.querySelector('.att-wrap');
      return {
        src: v ? String(v.getAttribute('src')) : '',
        fbSrc: v ? String(v.dataset.fbSrc || '') : '',
        poster: v ? String(v.poster || '').slice(0, 22) : '',
        loading: wrap ? wrap.classList.contains('loading') : null,
        vis: v ? getComputedStyle(v).visibility : '',
      };
    })()`);
    check(/^\/uploads\/files\/clip\.webm/.test(clipNow.src) && clipNow.fbSrc === clipNow.src,
      'the published clip points the player at its own bytes', clipNow);
    check(!/^data:/.test(clipNow.src), 'never at the frame', clipNow);
    check(/^data:/.test(clipNow.poster), 'and that frame is the poster it paints', clipNow);
    check(clipNow.loading === false && clipNow.vis === 'visible',
      'so the clip is on screen at once, with no capture fetch parked behind a spinner', clipNow);
    // A clip nothing has a frame for keeps the old path: the shell, then the
    // capture (that half is test-video-placeholder.js).
    const clipCold = await evaluate(`(function () {
      window.__fullRender({ id: 'att-c', kind: 'video', scan: 'clean', url: '/uploads/files/other.webm?v=3', name: 'other.webm', size: 40960, w: 1280, h: 720 });
      const v = document.querySelector('video.att-vid');
      const wrap = document.querySelector('.att-wrap');
      return { poster: String(v.poster || ''), loading: wrap.classList.contains('loading') };
    })()`);
    check(clipCold.poster === '' && clipCold.loading === true,
      'a clip with no frame in hand still waits behind the spinner for its capture', clipCold);

    console.log('\n[16] a clip republished under a new key keeps the frame it was showing');
    // A clip that is ALREADY on screen and comes back under a new key (the
    // compressor settling a clean upload it rewrote) is replaced — the player's own
    // controls and poster state belong to the element — and the frame the page
    // already captured for the source on screen goes with it, or the swap is a
    // black panel with a spinner in it.
    const clipStep = await evaluate(`(function () {
      window.__render({ id: 'att-r', kind: 'video', scan: 'clean', url: '/uploads/files/re.mp4?v=1', name: 're.mp4', size: 40960, w: 1280, h: 720 });
      const v0 = document.querySelector('video.att-vid');
      // …and the poster capture for the frame on screen has already completed.
      window.__videoPoster(v0.getAttribute('src'), ${JSON.stringify(shotData)});
      v0.dataset.posterOk = '1';
      v0.closest('.att-wrap').classList.remove('loading');
      const before = v0;
      const ok = window.__verdict([{ id: 'att-r', kind: 'video', scan: 'clean', url: '/uploads/files/re2.mp4?v=2', name: 're2.mp4', size: 30000, w: 1280, h: 720 }]);
      const v = document.querySelector('video.att-vid');
      const wrap = document.querySelector('.att-wrap');
      return {
        ok, replaced: v !== before,
        src: v ? String(v.getAttribute('src')) : '',
        poster: v ? String(v.poster || '').slice(0, 22) : '',
        loading: wrap ? wrap.classList.contains('loading') : null,
        visibility: v ? getComputedStyle(v).visibility : null,
      };
    })()`);
    check(clipStep.ok === true && clipStep.replaced === true, 'a new key replaces the player (its own controls and poster belong to the element)', clipStep);
    check(/^\/uploads\/files\/re2\.mp4/.test(clipStep.src), 'which is pointed at the newly published bytes', clipStep);
    check(/^data:/.test(clipStep.poster || ''), 'and it is handed the frame this page already captured', clipStep);
    check(clipStep.loading === false && clipStep.visibility === 'visible',
      'with the loading shell lifted, so the frame is what the reader sees', clipStep);

    console.log('\n[17] the stylesheet carries the new pieces');
    check(/\.att-slot\{display:block;width:100%/.test(css.replace(/\s+/g, '')) || /\.att-slot\s*\{[^}]*display:\s*block[^}]*width:\s*100%/.test(css),
      '.att-slot takes the row width, so the media inside resolves its reserved box against it (a shrink-to-fit slot collapses it)');
    check(/\.att-wrap\.att-swap img\.att-img:not\(\.att-held\)\{opacity:0\}/.test(css.replace(/\s+/g, ' ')),
    'the swap keeps the carried frame visible (the darkening rule names everything BUT it)');
  check(/img\.att-img\.att-held\{position:absolute/.test(css.replace(/\s+/g, '')), 'and the carried frame is taken out of flow (no layout jump)');
    check(/\.att-wrap\.loading:not\(\.ar\)\s*\.att-ph\{[^}]*position:static/.test(css),
      'and a clip with no measured shape still shows its placeholder box (the wrap cannot collapse)');
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
