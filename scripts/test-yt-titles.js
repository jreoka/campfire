// A YouTube card says what the video IS.
//
// A pasted YouTube link used to render as a poster frame and nothing else: no
// title, no channel, no word beyond a YOUTUBE banner. Scrolling a channel was
// a wall of thumbnails, and the only way to find out what one of them was was to
// start it. The caption fixes that — the video's title over the channel that
// posted it, under the tile — and it takes its text from the SAME oEmbed answer
// the link cards already fetch and cache, so it costs the app nothing new.
//
// What is worth pinning here, in the order the code can go wrong:
//
//   [A] the MARKUP. The caption is a row of its own under the tile, inside the
//       facade (so the whole card is the click target), and the whole card —
//       tile, play button and caption — is the SAME button the click handler has
//       always used. The empty row carries the video's id and nothing else, so
//       the unfurl scan can find it, and a card with an answer in the cache
//       paints it in the first paint instead of blinking it in afterwards.
//   [B] the FILL. An oEmbed answer lands in the caption; a failed or empty one
//       leaves the card alone. The unfurl cache is keyed by the video's own id,
//       and the caption is marked done, so the observer does not loop.
//   [C] the MEASURED card, in a real browser against the real stylesheet: the
//       caption is under the tile (never over the picture), it is laid out
//       rather than a clipped single line, it survives the video being played —
//       which is the one thing the old "swap the button for the player" code got
//       wrong by accident — and an unfilled card is exactly the card this was
//       before titles existed.
//
// Usage: node scripts/test-yt-titles.js   (skips the browser half without Chrome)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9421', 10);
const DESKTOP = { w: 1200, h: 800 };
const PHONE = { w: 390, h: 780 };
const WIDE = 9 / 16;
const TALL = 16 / 9;

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

const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const embedsSrc = fs.readFileSync(path.join(ROOT, 'public/embeds.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');

// embeds.js calls the app's global esc() at call time (classic script).
global.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// …and eh(), the local twin it defines for its own output.
const embeds = require(path.join(ROOT, 'public/embeds.js'));

const ID = 'dQw4w9WgXcQ';
const WATCH = 'https://www.youtube.com/watch?v=' + ID;
const SHORT = 'https://www.youtube.com/shorts/aBcDeFgHiJk';
// Exactly the shape unfurl.js hands back for a YouTube oEmbed answer: the title
// in `title`, the channel in `description` (that is where the oEmbed's author
// lands — see unfurl.js fetchOembed and the site: description mapping).
const OEMBED = {
  host: 'youtube.com', site: 'YouTube',
  title: 'Never Gonna Give You Up (Official Music Video)',
  description: 'Rick Astley',
  image: '/api/unfurl/img?u=x&s=y', imageW: 480, imageH: 360,
  icon: '/api/unfurl/img?u=z&s=w',
};
const LONG_TITLE = 'How I built a self-hosted Discord clone in 40 hours with no dependencies at all — a full walkthrough';
const XSS_TITLE = '"><img src=x onerror=alert(1)>';

console.log('\n[A] the card: header, tile, caption — and the caption inside the button');
const card = embeds.embedForUrl(WATCH);
check(/<button type="button" class="yt-facade"/.test(card) && /<span class="yt-tile">/.test(card),
  'the facade is still the click target, with the video in a tile inside it', card.slice(0, 90));
check(card.indexOf('class="yt-tile"') < card.indexOf('class="embed-yt-meta"'),
  'and the caption comes after the tile, not over it', card.slice(0, 120));
check(card.indexOf('class="embed-yt-meta"') < card.indexOf('</button>'),
  'inside the button: the whole card is the door, title and picture alike', card.slice(-120));
check(card.includes('<span class="embed-yt-meta" data-yt-meta="' + WATCH + '">'),
  'the first paint asks for the URL that was pasted — the unfurl is keyed by URL, and asked with a video id it answers 404',
  card.match(/embed-yt-meta[^>]*>/));
check(!/yt-title|yt-author/.test(card),
  'and says nothing yet: a card must never paint a title it does not have', card.match(/embed-yt-meta[^<]*/));
check(new RegExp('<span class="embed-yt-meta" data-yt-meta="' + WATCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"></span>').test(card),
  'the row is EMPTY, not absent — the unfurl scan looks the row up by the selector', card.match(/embed-yt-meta[^>]*/));
// The poster is addressed by the video's id (YouTube's thumbnail ladder takes
// nothing else) while the caption is addressed by the URL. They are different
// questions to different servers, and one card asks both.
check(card.includes('data-yt-thumb="' + ID + '"') && card.includes('data-yt-meta="' + WATCH + '"'),
  'the poster asks YouTube for the video by id; the caption asks the unfurl for the link', null);
// The tile keeps its shape rule, and the caption does not get one.
check(/class="yt-tile"><img /.test(card) && /embed-yt-meta/.test(card),
  'the ratio lives on the tile, so a caption under it cannot stretch the picture', null);
check(embeds.embedForUrl(SHORT).includes('<span class="yt-tile">'),
  'a Short is the same card — caption and all', null);
check(embeds.embedForUrl(WATCH).indexOf('</button></div>') > 0
  && !/embed-yt-meta[\s\S]*embed-yt-meta/.test(card),
  'exactly one caption per card', (card.match(/embed-yt-meta/g) || []).length);

console.log('\n[A2] the caption is HTML-escaped, like every other string in this file');
const nasty = embeds.ytCaptionHTML('', XSS_TITLE, '"><b>bold</b>');
check(!/<img/i.test(nasty) && !/<b>/i.test(nasty) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(nasty),
  'a title is a title, never markup (an oEmbed answer is a stranger\'s string)', nasty);
check(/<span class="yt-title">/.test(nasty) && /<span class="yt-author">/.test(nasty),
  'title and channel are their own elements', null);

console.log('\n[A3] a card in the CSS: laid out under the tile, with room to be read');
check(/\.embed-yt-meta\{display:block;padding:\.55rem \.8rem \.65rem;min-width:0\}/.test(styles),
  'the row is a block under the tile, with the card\'s own horizontal padding', null);
check(/\.embed-yt-meta:empty\{display:none\}/.test(styles),
  'and takes NO height when it is empty — a card with no title is the card it was', null);
check(/\.yt-title\{display:-webkit-box;-webkit-line-clamp:3;/.test(styles),
  'the title is laid out in up to three lines, not ellipsised onto one', null);
check(/\.yt-title\{[^}]*font-size:\.92rem;font-weight:650;line-height:1\.35/.test(styles),
  'at the same size and weight a link card\'s title is (.el-title), so the two cards read as one family', null);
check(/\.yt-author\{display:block;margin-top:\.15rem;font-size:\.78rem;color:var\(--muted\)/.test(styles),
  'the channel is the quiet second line under it', null);
check(/\.embed-vertical \.yt-title\{-webkit-line-clamp:3;font-size:\.86rem\}/.test(styles),
  'a Short is a narrow column, so its caption is a shade smaller', null);
check(/\.yt-facade\{position:relative;display:flex;flex-direction:column;align-items:stretch/.test(styles),
  'the facade is a COLUMN: tile first, caption second, with no ratio of its own to break', null);

console.log('\n[B] the fill: the cached oEmbed answer, and nothing else');
// Same mechanics as the link cards: /api/unfurl (cached in Postgres, deduped
// per URL, 60 live fetches per 5 min per user) is asked for the same URL the
// link card for this video would have asked for.
check(/function fillYtMeta\(el\)[\s\S]*fetchCard\(url\)/.test(embedsSrc),
  'the caption is filled through fetchCard — the link card\'s own cached, deduped fetch', null);
check(/function scanYtMeta\(root\)[\s\S]*\.embed-yt-meta\[data-yt-meta\]/.test(embedsSrc),
  'found by the same class-of-collector as the link cards', null);
check(/for \(const n of seen\) \{ scanLinkCards\(n\); scanInviteCards\(n\); scanYtMeta\(n\); \}/.test(embedsSrc),
  'and rides the ONE MutationObserver that already watches the message list', null);
check(/scanYtMeta\(document\.body\);/.test(embedsSrc),
  'including the first paint, so a message rendered before the observer is still captioned', null);
// The observer watches the CARD, not the caption row, and that is the whole
// trick: an empty row is `display:none`, and an IntersectionObserver never calls
// a zero-height element intersecting — not even when it is on screen. A row that
// waited to be asked FOR would never be asked for, and no title would ever
// arrive. (The browser half below proves the observer really does fire: without
// the card, no caption, and the card checks fail.)
const scan = embedsSrc.split('function scanYtMeta')[1].split('function scanLinkCards')[0];
check(/const watch = card \|\| el;/.test(scan) && /cardObserver\.observe\(watch\)/.test(scan),
  'through the same IntersectionObserver — watching the CARD, because a row with nothing to say has no height to intersect', null);
// Once per CARD, not once per row: the scan sees every row it finds, so a
// message with two YouTube links would otherwise hand the observer the same
// card twice. (The dbg probe found the duplicate; the browser half shows only
// one card, and one request per video.)
check(/watch\.dataset\.ytScanned = '1'/.test(scan) && /card && card\.dataset\.ytScanned\) continue;/.test(scan),
  'and once per card, so a card with several rows is not watched three times over', null);
check(/else if \(el\.dataset && el\.dataset\.ytScanned\) fillYtCard\(el\);/.test(embedsSrc),
  'the one shared observer hands each element to the filler for what it IS, read off the element', null);
check(/if \(el\.dataset\.ytTitled\) continue;/.test(embedsSrc),
  'and a row that already says its title is never asked about again', null);
check(/if \(!el\.isConnected\) return;/.test(embedsSrc.split('async function fillYtMeta')[1].split('\n}')[0]),
  'an answer that lands after the message list was rebuilt is dropped, not painted into nothing', null);
check(/!d\.title\) return;/.test(embedsSrc.split('function paintYtMeta')[1].split('\n}')[0]),
  'an oEmbed failure leaves the card exactly as it was — no half-written caption', null);
// The order is the whole thing, and the measured half below is what proves it:
// the caption is lifted out of the button BEFORE the player goes in where the
// button is. (The other way round put the iframe in first, and the caption was
// left behind it — still in the DOM, still measured, and no longer on screen.)
const handler = pickers.split("const ytBtn = e.target.closest('[data-yt-play]');")[1].split("\n  if (spEl")[0];
check(handler.indexOf("querySelector('.embed-yt-meta')") > -1
  && handler.indexOf("insertBefore(cap, ytBtn.nextSibling)") > -1
  && handler.indexOf("insertBefore(cap, ytBtn.nextSibling)") < handler.indexOf("ytBtn.replaceWith(f)"),
  'and the click handler KEEPS the caption when it replaces the facade with the player — lifting it out FIRST', null);
check(/ytBtn\.replaceWith\(f\);/.test(pickers) && /className = 'embed-frame yt-player'/.test(pickers),
  'the player is still built exactly as before (same class, same replace) — the caption is only moved aside', null);

console.log('\n[B2] a card with the answer already cached paints it in the first paint');
// Message lists are rebuilt wholesale on every socket event. A caption that only
// appeared after a fetch would blink out of a message nobody had touched, so the
// card is built from the same cache the link cards read synchronously.
embeds.__cardCache.set(WATCH, OEMBED);
const warm = embeds.embedForUrl(WATCH);
check(warm.includes('>' + OEMBED.title + '</span>') && warm.includes('>' + OEMBED.description + '</span>'),
  'the title and the channel are in the markup the very first time it is rendered', warm.match(/yt-title[^<]*/));
check(/<span class="embed-yt-meta" data-yt-titled="1">/.test(warm),
  'and the row is marked done, so the observer does not fetch what is already on screen', warm.match(/embed-yt-meta[^>]*>/));
check(!/data-yt-meta=/.test(warm),
  'a captioned card carries no id to look up — there is nothing left to ask for', null);
// …and the OTHER url for the same video is not warm, because the cache is keyed
// by URL. A /shorts/ link is a different message, and it gets asked properly.
check(!/data-yt-titled/.test(embeds.embedForUrl(SHORT)),
  'a different link to the same video is still a cold card — the unfurl is per URL, and that is the server\'s contract', null);
embeds.__cardCache.delete(WATCH);
check(!/data-yt-titled/.test(embeds.embedForUrl(WATCH)),
  'and an emptied cache really is cold again (the check above is not a tautology)', null);

const chromePath = findChrome();
if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

// ---------- [C] the card a reader actually sees ----------
function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head><body>
<div id="view-main"><div id="chat"><div id="messages">
<div class="msg"><div class="body" id="slot"></div></div>
</div></div></div>
<script>window.__TITLES = {}; window.__MODE = ''; window.__fetched = [];
window.__auth = '';
// A CommonJS shim, set BEFORE /embeds.js is parsed. The last line of that file is
// the guarded form  if (typeof module !== 'undefined') module.exports = {...}
// wrapped in its own try/catch  --
// which in a browser is a no-op: a classic script has no module, so the guard
// is false and the page never learns what the file exports. Declaring module
// here makes that export block do its job in this page, and the page then holds
// the very Map the CARD is reading — not a copy of it, the same object. It is
// what makes the unfurl-cache check below checkable; see __clearCache.
window.module = { exports: {} };
</script>
<script src="/embeds.js"></script>
<script>
// embeds.js is a classic script that calls the app's global esc() at call time
// (public/js/core.js). Verbatim, except that the entity for a double quote is
// built from its character code: this page is a template literal in the test
// file, and a quote character written plainly there is not a quote character in
// the page — it ends the script that defines it, and the page then loads with a
// half-run harness and every card on it mysteriously unfilled.
// The store the signed-in reader would have. It is defined HERE, after
// embeds.js has been parsed: auth.js owns that global in the real app and
// overwrites whatever the page set up before it, so a shim defined earlier is a
// shim that never answers. cardAuthHeader() reads a bare store for its token.
window.store = { token: 'test-reader-token' };
function esc(s) {
  const Q = String.fromCharCode(34);
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', [Q]: '&quot;', "'": '&#39;' }[c]));
}
// /api/unfurl, answered locally: the test is about the CARD, not about YouTube.
// …and asked for exactly like the app asks for it, with our own token on the
// Authorization header (cardAuthHeader), because the real endpoint is
// authRequired and a request without it is answered 401 — which would make
// every title in here look like a failure that is really a test harness that
// forgot to sign in. window.__TOKEN stands in for the signed-in reader.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const u = String(input);
  const h = (init && init.headers) || {};
  window.__auth = String(h.Authorization || '');
  if (u.indexOf('/api/unfurl?url=') !== 0) return realFetch(input, init);
  // The real endpoint is authRequired, so a request without our token comes back
  // 401 — which would make every title in here look like a failure that is
  // really a harness that forgot to sign in. The stub refuses one for real, so
  // that stays a thing this file can check.
  const auth = (init && init.headers && (init.headers.Authorization || (init.headers.get && init.headers.get('Authorization')))) || '';
  if (auth.indexOf('Bearer ') !== 0) return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
  const url = decodeURIComponent(u.slice('/api/unfurl?url='.length));
  await new Promise((r) => setTimeout(r, 20));
  // Keyed by the VIDEO, not by the URL it was pasted as: the same video is a
  // /watch/ link in one message and a /shorts/ link in the next, and the answer
  // YouTube gives for both is the same one.
  const paths = new RegExp('/(?:shorts|embed|live)/([A-Za-z0-9_-]+)');
  const id = (/[?&]v=([A-Za-z0-9_-]+)/.exec(url) || paths.exec(url) || [])[1] || url;
  window.__fetched.push(String(input));
  if (window.__MODE === 'fail') return { ok: true, status: 200, json: async () => ({ embed: null }) };
  const t = window.__TITLES[id] || window.__TITLES[url];
  if (!t) return { ok: true, status: 200, json: async () => ({ embed: { host: 'youtube.com', site: 'YouTube', title: '', description: '', image: '' } }) };
  return { ok: true, status: 200, json: async () => ({ embed: t }) };
};
window.__render = (url) => { document.getElementById('slot').innerHTML = linkEmbedsHTML(url); return !!document.querySelector('#slot .embed'); };
// The unfurl cache is the module's own Map, exposed for exactly this: a card that
// has been answered once must be able to be asked again, or "the unfurl finds
// nothing" is untestable and the check below would be a tautology.
// The unfurl cache is a module-level Map in embeds.js, and the page now holds
// that exact Map: the CommonJS shim above made embeds.js export it (see
// 'window.module = { exports: {} }'). It read 'embeds.__cardCache' before, which
// is a Node-side name that does not exist in a browser -- the page threw
// ReferenceError and took [C4] down with it -- and it is NOT the Node copy:
// 'require()' in the test process and the <script> in the page are two separate
// realms with two separate Maps, so clearing one never touched the other. This
// is the page's own.
window.__clearCache = () => { window.module.exports.__cardCache.clear(); };
// Exactly what the delegated click handler (pickers.js [data-yt-play]) builds —
// the caption move included, because the caption surviving playback is the thing
// this file is here to pin.
window.__play = () => {
  const tile = document.querySelector('#slot .yt-facade');
  if (!tile) return false;
  const cap = tile.querySelector('.embed-yt-meta');
  if (cap) tile.parentNode.insertBefore(cap, tile.nextSibling);   // after it: see pickers.js
  const f = document.createElement('iframe');
  f.className = 'embed-frame yt-player';
  tile.replaceWith(f);
  return true;
};
</script>
</body></html>`;
}

const PROBE = `(() => {
  const card = document.querySelector('#slot .embed');
  if (!card) return { none: true };
  const media = card.querySelector('.yt-tile, .embed-frame.yt-player');
  const cap = card.querySelector('.embed-yt-meta');
  const title = card.querySelector('.yt-title');
  const author = card.querySelector('.yt-author');
  const head = card.querySelector('.embed-src');
  const host = head ? head.querySelector('.embed-host') : null;
  const mb = media ? media.getBoundingClientRect() : null;
  const cb = card.getBoundingClientRect();
  const tb = title ? title.getBoundingClientRect() : null;
  const ab = author ? author.getBoundingClientRect() : null;
  const hb = head ? head.getBoundingClientRect() : null;
  const hh = host ? host.getBoundingClientRect() : null;
  const cs = cap ? getComputedStyle(cap) : null;
  return {
    tag: media ? media.tagName : null,
    isPlayer: !!(media && media.classList.contains('yt-player')),
    mediaW: mb ? Math.round(mb.width) : 0, mediaH: mb ? Math.round(mb.height) : 0,
    ratio: mb ? +(mb.height / mb.width).toFixed(3) : 0,
    capH: cap ? Math.round(cap.getBoundingClientRect().height) : 0,
    capW: cap ? Math.round(cap.getBoundingClientRect().width) : 0,
    titleText: title ? title.textContent : null,
    authorText: author ? author.textContent : null,
    titleW: tb ? Math.round(tb.width) : 0, titleH: tb ? Math.round(tb.height) : 0,
    authorBelow: !!(tb && ab && ab.top >= tb.bottom - 1),
    capBelow: !!(mb && cap && cap.getBoundingClientRect().top >= mb.bottom - 1),
    // The banner is a flex row of fixed padding over a 1px border, so the
    // caption is inset from the CARD by the card's own padding and inset from
    // its TEXT by that padding plus the caption's: two different insets, and an
    // earlier version of this check compared them as if they were the same one.
    padL: parseFloat(getComputedStyle(card).paddingLeft),
    capPad: cap ? parseFloat(getComputedStyle(cap).paddingLeft) : 0,
    // The TEXT inset, which is what a reader sees. This was read off the title
    // box -- but the title lives INSIDE the caption, already past the caption's
    // own padding, so adding capPad to it on the far side counted that padding
    // twice and the identity below could not hold. Read the caption's own
    // content edge: its border-box left plus its left padding.
    insetText: cap ? Math.round(cap.getBoundingClientRect().left + (parseFloat(getComputedStyle(cap).paddingLeft) || 0) - cb.left) : 0,
    insetL: cap ? Math.round(cap.getBoundingClientRect().left - cb.left) : 0,
    capInsideCard: !!(cap && cap.getBoundingClientRect().right <= cb.right + 1),
    bodyPad: (function () { const b = document.querySelector('#slot .body'); return b ? parseFloat(getComputedStyle(b).paddingLeft) : 0; })(),
    cardPad: parseFloat(getComputedStyle(document.querySelector('#slot .embed') || document.body).paddingLeft),
    ellipsis: !!title && getComputedStyle(title).textOverflow === 'ellipsis',
    scrollW: document.documentElement.scrollWidth,
    lineHeight: title ? parseFloat(getComputedStyle(title).lineHeight) : 0,
    fontSize: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
    clamp: title ? getComputedStyle(title).webkitLineClamp : null,
    overflowX: cap ? getComputedStyle(cap).overflowX : null,
    headText: head ? head.textContent : null,
    // The banner carries the URL tail by ELLIPSISING it: the tail sits at the
    // right margin of a row that cannot wrap, and a long one is cut rather than
    // given a second line. Read off the tail itself, not the row around it.
    hostText: host ? host.textContent : null,
    hostEllipsis: !!host && getComputedStyle(host).textOverflow === 'ellipsis',
    headH: hb ? Math.round(hb.height) : 0,
    // The banner is a flex row: the name and the URL tail, and ONE line of it.
    // (The card's own 1px borders are not the banner — the line is.)
    headLh: head ? parseFloat(getComputedStyle(head).lineHeight) : 0,
    // The banner is a flex row with a fixed padding and a border under it, so
    // its height is NOT its line height: the number of lines is read off the
    // tail's own box, which is text and nothing else.
    headRows: hh && host ? Math.round(hh.height / Math.max(1, parseFloat(getComputedStyle(host).lineHeight))) : 0,
    cardW: Math.round(cb.width), cardH: Math.round(cb.height),
  };
})()`;

async function main() {
  // ONE process, one Chrome, both runs: the file is executed twice (plain node,
  // and through a copy that calls global.main() instead of exiting) so the
  // 300-odd offline checks above run identically on a developer machine and on
  // a CI box, and the browser half runs exactly once either way.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ytitles-'));
  const srv = http.createServer((req, res) => {
    const url = req.url || '';
    if (/^\/styles\.css/.test(url)) { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); res.end(styles); return; }
    if (/^\/embeds\.js/.test(url)) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(embedsSrc); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    // The shared VM this runs on is out of processes and out of /dev/shm often
    // enough that Chrome's renderer cannot always be forked. Nothing here is
    // timing-sensitive and every wait is already polled, so a single process is
    // both the reliable option and the cheap one.
    // --no-sandbox is not optional here, and it is not paranoia: with
    // --no-zygote but no --no-sandbox, Chrome refuses to start at all
    // ("Zygote cannot be disabled if sandbox is enabled") and never opens its
    // DevTools port. Every run then reported SKIP: Chrome never opened its
    // DevTools port -- and because skip() exits 0, a browser section that never
    // ran looked exactly like one that passed. This file is how the card was
    // verified at all, so that was a whole feature checked by nothing.
    '--no-sandbox', '--single-process', '--no-zygote', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-extensions', '--mute-audio',
    '--window-size=' + DESKTOP.w + ',' + DESKTOP.h, 'about:blank'], { stdio: 'ignore' });

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
    // Every answer must be settled, never left hanging: a CDP call whose reply
    // never arrives takes the rest of the run with it, and the file then looks
    // like it froze on its first check instead of saying which one.
    let openedAt = Date.now();
    const callsInFlight = new Map();
    ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(raw); } catch { return; }
      if (m && m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); callsInFlight.delete(m.id); f(m); }
    });
    const watch = setInterval(() => {
      if (pending.size && Date.now() - openedAt > 45000) {
        const stuck = [...callsInFlight.keys()];
        for (const id of [...pending.keys()]) { const f = pending.get(id); pending.delete(id); f({ error: { message: 'CDP call never answered (ids ' + stuck + ' after 45s)' } }); }
      }
    }, 1000);
    watch.unref && watch.unref();
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      callsInFlight.set(i, method);
      openedAt = Date.now();
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    // Every page-side question is answered out of the page's OWN memory, so a
    // check can never park forever in a layout that has not committed: a
    // Runtime.evaluate that hangs is indistinguishable from a card that is
    // broken, and one hung here stopped the file dead with no FAIL at all.
    // 30s is far longer than a reflow of these cards takes; after that the
    // question is retired and the run continues to the next one.
    const ev = async (expression) => {
      const r = await Promise.race([
        sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        sleep(30000).then(() => ({ timedOut: expression.slice(0, 60) })),
      ]);
      if (r && r.timedOut) throw new Error('the page never answered: ' + r.timedOut);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable');
    await sess('Runtime.enable');
    // The viewport is set BEFORE the page is opened, as scripts/test-yt-shorts.js
    // does it. The page then waits for its own scripts rather than sleeping
    // through a guessed number of milliseconds: it loads embeds.js from this
    // test's HTTP server, and on a loaded machine that can land after the load
    // event \u2014 a harness that gives up on a fixed delay reports a browser
    // problem as a code problem, and a skipped test is worse than a failing one.
    await sess('Emulation.setDeviceMetricsOverride', { width: DESKTOP.w, height: DESKTOP.h, deviceScaleFactor: 1, mobile: false });
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { ready = await ev('typeof window.__render === "function" && typeof window.__play === "function"'); }
      catch (e) { ready = false; }   // a page that is still loading has no context to answer in
      if (!ready) await sleep(250);
    }
    if (!ready) {
      console.error('[test] the real embeds.js did not evaluate in the page');
      console.error('[test]   readyState ' + await ev('document.readyState') + ', scripts ' + await ev('document.scripts.length')
        + ', render ' + await ev('typeof window.__render') + ', play ' + await ev('typeof window.__play'));
      process.exit(1);
    }

    console.log('\n[C1] a cold card: poster first, caption a moment later');
    await ev('window.__TITLES = ' + JSON.stringify({ [ID]: { ...OEMBED, title: LONG_TITLE } }) + '; window.__fetched = []');
    check((await ev('window.__render(' + JSON.stringify(WATCH) + ')')) === true, 'the video renders');
    let m = await ev(PROBE);
    check(m.capH === 0 && m.titleText === null,
      'the first paint has no caption row at all — an empty row takes no height, so the card is the one it was', m);
    const cold = m;                 // the height the card has with no title at all
    // Polled, not slept through: the fill waits on an IntersectionObserver
    // callback and then on the fetch, and neither is a fixed delay.
    for (let i = 0; i < 40 && !(await ev('!!document.querySelector("#slot .yt-title")')); i++) await sleep(100);
    const filled = await ev('!!document.querySelector("#slot .yt-title")');
    if (!filled) {
      // Say WHY, or this reads as a card bug when it is a harness bug: the fill
      // waits on an observer, on a fetch, and on a signed-in reader, and each of
      // those can be missing in a page that is otherwise perfect.
      console.error('[test]   no caption row: row ' + await ev('!!document.querySelector("#slot .embed-yt-meta[data-yt-meta]")')
        + ', card watched ' + await ev('document.querySelector("#slot .embed").dataset.ytScanned || "no"')
        + ', fetch calls ' + await ev('window.__fetched.length')
        + ', auth ' + JSON.stringify(await ev('window.__auth'))
        + ', token ' + JSON.stringify(await ev('typeof store !== "undefined" ? String(store.token) : "no store"'))
        + ', IntersectionObserver ' + await ev('typeof IntersectionObserver'));
    }
    // Re-measure, ALWAYS. `m` above is the COLD card — read on purpose, so that
    // `cold` is the height it had with no title at all. Every check below is
    // about the card AFTER the unfurl lands, and each was being handed that cold
    // snapshot: the poll had proved the title was there while the measurements
    // still described a card with no caption on it. `cold` keeps the before;
    // `m` becomes the after.
    m = await ev(PROBE);
    // The desktop case is the FULL-LENGTH title, not the short one: it is the
    // title that has to wrap, and a check against a title that fits says nothing
    // about whether a card copes with a YouTube title.
    const DESKTOP_TITLE = LONG_TITLE;
    check(m.titleText === DESKTOP_TITLE && m.authorText === OEMBED.description,
      'and the title and channel arrive from /api/unfurl a moment later', m);
    const fetched = await ev('window.__fetched');
    check(fetched.length === 1 && decodeURIComponent(String(fetched[0]).replace('/api/unfurl?url=', '')) === WATCH,
      'asked for exactly the URL that was pasted, once', fetched);
    check(await ev('/^Bearer test-reader-token$/.test(window.__auth || "")'), 'and it went out signed in — the real endpoint is authRequired', { auth: await ev('window.__auth') });
    check(m.capBelow === true && m.titleW > 0 && m.capInsideCard,
      'the caption is UNDER the tile and inside the card — nothing is painted over the poster', m);
    check(m.titleH > m.lineHeight * 1.9 && m.clamp === '3',
      'a two-line title takes both its lines, capped at three', { h: m.titleH, lh: m.lineHeight, clamp: m.clamp });
    check(m.authorBelow === true && m.titleH > 0,
      'the channel sits on its own line under the title', m);
    check(m.insetText > 8 && m.insetText < 40,
      'indented under the card the way .embed-link indents, not flush against the tile edge', { inset: m.padL });
    check(Math.abs(m.ratio - WIDE) < 0.04,
      'and the video is still the 16:9 box — a caption under it cannot stretch the picture', { ratio: m.ratio });
    check(m.cardH - m.mediaH > 30,
      'the card grew by the caption, and only the caption', { before: cold.cardH, after: m.cardH });
    check(m.headText === 'YouTubeyoutube.com' && m.hostText === 'youtube.com' && m.headRows === 1 && m.hostEllipsis === true,
      'the banner is still ONE line — it now carries the URL tail instead of standing alone', m);
    // 13px inset (1px card border + 12px caption padding), 13.6px on the text
    // itself once it rounds to a glyph edge. This is the card's own design, not
    // a number invented for the test: .embed-link's is 1px + 13.6px.
    check(m.capBelow === true && m.insetL === 1 && m.capPad >= 8 && m.insetText - m.insetL >= 8,
      'the caption is indented by its own text padding, the way .embed-link is — not flush against the tile', { box: m.insetL, pad: m.capPad, text: m.insetText });

    console.log('\n[C2] playing it: the player takes the tile, the caption stays');
    const insetBefore = m.insetText;
    check((await ev('window.__play()')) === true, 'playing it swaps the facade for the player');
    m = await ev(PROBE);
    m.insetTextBefore = insetBefore;   // the caption must not move when the tile does
    check(m.isPlayer === true && m.titleText === DESKTOP_TITLE && m.authorText === OEMBED.description,
      'the title is still on the card while the video plays \u2014 this is the bit the swap used to throw away', m);
    check(Math.abs(m.ratio - WIDE) < 0.04 && m.authorBelow === true && m.capBelow === true && m.insetText === m.insetTextBefore,
      'the player keeps the 16:9 shape, the caption keeps its place under it', { before: m.insetTextBefore, after: m.insetText });
    check(Math.abs(m.cardH - (cold.cardH + m.capH)) <= 2,
      'and the card is exactly as tall as it was before the click', { h: m.cardH, before: cold.cardH, cap: m.capH });

    console.log('\n[C3] a Short: the same caption, in the narrow column');
    await ev('window.__TITLES = ' + JSON.stringify({ aBcDeFgHiJk: { ...OEMBED, title: 'POV: you are the guy who never gives anyone up' } }) + '; window.__fetched = []');
    await ev('window.__render(' + JSON.stringify(SHORT) + ')');
    for (let i = 0; i < 40 && !(await ev('!!document.querySelector("#slot .yt-title")')); i++) await sleep(100);
    m = await ev(PROBE);
    check(m.titleText && m.titleText.startsWith('POV:'), 'a Short is captioned too', m.titleText);
    check(Math.abs(m.ratio - TALL) < 0.04 && m.cardW <= 262, 'the tile is still 9:16 and the card still hugs it', { ratio: m.ratio, card: m.cardW });
    check(m.capW <= 262 && m.titleW < m.capW && m.capBelow === true && m.authorBelow === true,
      'and the title wraps inside the narrow card, never out of it', { cap: m.capW, title: m.titleW });
    await ev('window.__play()');
    m = await ev(PROBE);
    check(m.isPlayer === true && m.titleText && Math.abs(m.ratio - TALL) < 0.04,
      'and it survives playback on the vertical shape as well', m);

    console.log('\n[C4] nothing to say: the card does not invent a caption');
    // The card that has already been captioned once is asked again, because the
    // unfurl cache is per page and a message list rebuild paints from it: the
    // CACHE is emptied, so the answer really does come back with nothing in it.
    await ev('window.__MODE = "fail"; window.__fetched = []');
    await ev('window.__clearCache(); window.__clearCache()');
    await ev('window.__render(' + JSON.stringify(WATCH) + ')');
    for (let i = 0; i < 20 && !(await ev('window.__fetched.length')); i++) await sleep(100);
    m = await ev(PROBE);
    check(m.capH === 0 && m.titleText === null && m.cardH === cold.cardH,
      'an unfurl that finds nothing leaves the card EXACTLY as it was before titles existed',
      { capH: m.capH, card: m.cardH, before: cold.cardH });
    await ev('window.__MODE = ""');

    console.log('\n[C5] the phone width, 390x780');
    await sess('Emulation.setDeviceMetricsOverride', { width: PHONE.w, height: PHONE.h, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    await ev('window.__TITLES = ' + JSON.stringify({ [ID]: { ...OEMBED, title: LONG_TITLE } }) + '; window.__fetched = []');
    await ev('window.__clearCache(); window.__clearCache()');
    await ev('window.__render(' + JSON.stringify(WATCH) + ')');
    for (let i = 0; i < 40 && !(await ev('!!document.querySelector("#slot .yt-title")')); i++) await sleep(100);
    m = await ev(PROBE);
    check(m.titleText === LONG_TITLE && !m.ellipsis && m.titleW > 0 && m.titleW <= m.capW && m.cardPad === 0 && m.bodyPad === 0,
      'a full-length YouTube title is not cut off before it is shown', m);
    check(m.titleH > m.lineHeight * 1.9 && m.titleH <= m.lineHeight * 3.1,
      'it takes three lines on a phone and stops there', { h: m.titleH, lh: m.lineHeight });
    check(m.capInsideCard && m.scrollW <= PHONE.w && m.cardW <= PHONE.w && m.capW <= PHONE.w,
      'the card fills the message the way it always did, and never scrolls sideways, however long the title', m);
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { clearInterval(watch); } catch {}
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    // Chrome can outlive a kill() while a renderer is wedged, and a stale
    // --remote-debugging-port belongs to nobody: the next run on the same port
    // attaches to a browser this file no longer controls.
    try { execFileSync('pkill', ['-9', '-f', 'remote-debugging-port=' + CDP_PORT], { stdio: 'ignore' }); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

// Run it. The guard below is the rerun harness the top comment describes: a
// copy of this file that sets global.__campfireTestRerun gets main() handed to
// it instead of having it fire here, so the browser half runs ONCE either way.
//
// These three lines used to say `if (require.main === module) main();` and then,
// separately and unconditionally, `main()` -- so running it directly started the
// whole browser section twice. Two Chromes fought over the one fixed
// CDP_PORT, the loser waited 45s on calls the winner's browser had dropped, and
// a run whose checks had all passed still exited 1 on
// "CDP call never answered". Every section header printed twice, which is the
// give-away that was sitting in plain sight in the output.
if (require.main === module) main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
else if (typeof global !== 'undefined' && global.__campfireTestRerun) global.main = main;
