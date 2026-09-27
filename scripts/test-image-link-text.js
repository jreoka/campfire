// A link that EMBEDS AS A PICTURE must not print its own URL above the picture.
//
// The ask (owner): pasting a direct image link showed the raw URL as the message
// text AND the picture right below it — a wall of characters sitting on top of
// the image the reader actually came for. Discord shows the picture alone.
//
// Three pieces have to agree, and that is the whole reason this is not a regex
// in either place:
//
//   [A] the RULE — `isDirectImageUrl` in public/embeds.js. One predicate, the
//       embed's own: the embed pass renders such a URL as `.embed-img` and the
//       TEXT pass (renderRich in core.js) leaves it unlinked. Two rules drift,
//       and a URL that embeds in one place and anchors in the other is the bug
//       itself. "Direct" is narrow on purpose, because a false positive
//       swallows a clickable link: a query string means a GENERATED image
//       rather than the file, and nothing else is excluded (a page that merely
//       LOOKS like one is harmless — see the recovery below).
//   [B] the TEXT — run with the REAL renderRich sliced out of core.js and the
//       REAL predicate out of embeds.js (index.html loads them in that order),
//       and a fresh `vm` realm for the case where embeds.js never loaded at
//       all. A message that is nothing but one direct image link reads as that
//       URL with no anchor; a picture link next to a word, a second link in the
//       same message, a trailing full stop, `` `code` `` or a fence all keep
//       their links; `**bold**` and `||spoiler||` are not words and stay
//       picture-only; the composer's backdrop still lays out and anchors every
//       character (the caret lives on it); the story surfaces, which are
//       deliberately separate, keep their own behaviour.
//   [C] the PAIR — the two passes mark their answer (`data-fb-img-text` on the
//       text, `data-fb-img` on the <img>), messages.js builds that one card from
//       the same predicate, and a failed <img> hands the link back where the
//       marker was. In headless Chrome, against a server that really 404s the
//       picture: a picture-only message is the picture (no anchor in the text),
//       tapping it still opens the lightbox — the thing the text used to be the
//       backup for — and a picture that will not load becomes that URL again as
//       a real link, with the dead image gone rather than left as a black
//       rectangle. A sentence around the same link keeps its own anchor
//       throughout.
//
// The page is the REAL source with the app's own script order (embeds.js,
// core.js, pickers.js's click router, messages.js) and only the things that are
// not about these checks stubbed. Skips (exit 0) without Chrome.
// Usage: node scripts/test-image-link-text.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9371', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, 1000 * (ms / 1000)));

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
// …and the cleanup runs whatever happens, so a test that dies mid-way (a
// leftover browser would sit there holding its profile lock) still tidies up.
let cleanup = () => {};
function onExit(fn) { const prev = cleanup; cleanup = () => { try { fn(); } catch {} try { prev(); } catch {} }; }
process.on('exit', () => cleanup());
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
// Headless Chrome needs no sandbox where the tests run (a container without
// unprivileged user namespaces, where asking for the real one just means the
// browser never opens its DevTools port at all). CHROME_NO_SANDBOX=0 opts out.
function chromeFlags() {
  return process.env.CHROME_NO_SANDBOX === '0' ? [] : ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
}

// embeds.js calls the app's global esc() at call time (it is a classic script).
global.esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const embeds = require(path.join(ROOT, 'public/embeds.js'));
const { isDirectImageUrl, embedForUrl, linkEmbedsHTML, linkifyHTML, storyTextHTML, cleanEmbedUrl } = embeds;

// core.js: esc() through the end of renderRich, the same slice the other
// renderRich tests take. isDirectImageUrl and cleanEmbedUrl are the globals
// embeds.js installs before core.js runs (index.html's script order).
const src = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const escStart = src.indexOf('function esc(');
const richStart = src.indexOf('function renderRich(');
const richEnd = src.indexOf('function isBigEmoji');
if (escStart < 0 || richStart < 0 || richEnd < 0) {
  console.error('[test] could not find esc()/renderRich() in public/js/core.js');
  process.exit(1);
}
global.S = { emojiAll: {}, stdEmoji: {}, me: { id: 'u1' }, view: 'server', serverDetail: null };
global.memberByUsername = () => null;
global.isDirectImageUrl = isDirectImageUrl;
global.cleanEmbedUrl = cleanEmbedUrl;
// isBigEmoji (which messageEl asks first) sits after renderRich, so the slice
// runs to the end of that function rather than to its start.
const code = src.slice(escStart, richStart) + src.slice(richStart, src.indexOf('function fmtTime(', richEnd));
const { renderRich } = eval(code + '\n;({ renderRich })');
// messages.js slices the picture-link pair (keepEmbedFor + the failed-picture
// handler) AND the real messageEl, so the page builds a whole real message row
// and the handler has real markup to act on. Everything in between is exactly
// what the app itself evaluates in between, so there are no new stubs to lie.
const msgs = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const pairFrom = msgs.indexOf('function keepEmbedFor(');
const elFrom = msgs.indexOf('function messageEl(m, opts = {}) {', pairFrom);
const elTo = msgs.indexOf('// Discord-style grouping', elFrom);
if (pairFrom < 0 || elFrom < 0 || elTo < 0 || elFrom <= pairFrom) {
  console.error('[test] could not find keepEmbedFor() / messageEl() in public/js/messages.js');
  process.exit(1);
}
const pairSrc = msgs.slice(pairFrom, elTo);
const embedsSource = fs.readFileSync(path.join(ROOT, 'public/embeds.js'), 'utf8');
// The delegated click router, sliced out of pickers.js the way the slice above is
// out of messages.js. It belongs here because it is the router that opens a
// pasted picture in the lightbox — the same picture this change stopped printing
// — and a page that has the router is a page whose lightbox must still open.
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const crFrom = pickers.indexOf('// global delegation for message interactions');
const crTo = pickers.indexOf('\n});\n', pickers.indexOf("if (cardUid) { openUserCard", crFrom));
if (crFrom < 0 || crTo < 0) {
  console.error('[test] could not find the delegated click router in public/js/pickers.js');
  process.exit(1);
}
const clickRouterSource = `
// …and it does need the whole handler body: this is the router that opens a
// pasted picture in the lightbox, and a check below taps one. Everything it
// names that lives in messages.js is there, and the rest is stubbed.
const S = { emojiAll: {}, stdEmoji: {}, me: { id: 'u1' }, view: 'server', serverDetail: null,
  messages: new Map(), dmMessages: new Map(), thread: null, editing: null, pendingAtts: [], gifFavs: { items: [] } };
function memberByUsername() { return null; }
function fmtFull(ts) { return new Date(ts).toString(); }
function fmtTime(ts) { return new Date(ts).toTimeString().slice(0, 5); }
function fmtAgo(ts) { return 'now'; }
function nameStyleFor() { return ''; }
function nameClassFor() { return ''; }
function tagHTML() { return ''; }
function liveUserFor(id) { return { id, display_name: 'Cross', username: 'cross' }; }
function noteAttPreviewRendered() {}
function voCardHTML() { return ''; }
function pollHTML() { return ''; }
function reactionsHTML() { return ''; }
function quickReactsHTML() { return '<button class="qr">+</button>'; }
function threadCardHTML() { return ''; }
function atsBlockHTML() { return ''; }
function paintThreadCardAvatar() {}
function wireServerPoster() {}
function requestVideoPoster() {}
function wireVideoPlayState() {}
function observeStick() {}
function wireAttImage() {}
function paintAvatar(el, au) { if (el) el.textContent = (au && au.display_name || '?').charAt(0); }
function toast(m) { window.__toasts.push(m); }
function uidClickTarget(e) { return (e.target && e.target.closest('[data-uid]')) || null; }
// Every media action the router names, recorded rather than done: the checks
// below ask which one a tap reached, which is the only thing a paste of a
// picture URL can still be asked about once the text is gone.
const __acts = [];
function act(name) { return function () { __acts.push(name); }; }
function toggleReaction() { __acts.push('reaction'); }
function openLightbox(url) { __acts.push('lightbox:' + url); }
function lbGalleryAt() { return null; }
function setGifOpen() {}
function playInlineGif() {}
function stopInlineGif() {}
function toggleEmbedAudio() {}
function toggleSpoiler() {}
function togglePinned() {}
function scrollToMessage() {}
function openThread() {}
function startReply() {}
function openUserCard() { __acts.push('usercard'); }
function openMemberCard() { __acts.push('membercard'); }
function msgAuthor(m) { return m && m.user ? { id: m.user, display_name: 'Cross', username: 'cross' } : null; }
${embedsSource}
${code}
${pickers.slice(crFrom, crTo + 4)}`;


const pagePrelude = `${clickRouterSource}
${pairSrc}
window.S = S;
window.__keep = keepEmbedFor;
window.__messageEl = (m) => messageEl(m).outerHTML;
window.__acts = __acts;
window.__toasts = [];
`;

const PIC = 'https://cdn.example.com/pics/holiday.JPEG';
const PAGE = 'https://example.com/article';
const textOf = (html) => String(html)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

console.log('\n[1] what counts as a link that IS a picture');
{
  for (const u of [
    'https://cdn.example.com/a.png', 'https://cdn.example.com/a.JPG', 'https://a.example/b.jpeg',
    'https://a.example/c.gif', 'https://a.example/d.webp', 'https://a.example/e.avif',
    'https://a.example/f.bmp', 'https://a.example/g.svg', 'http://a.example/h.png',
  ]) check(isDirectImageUrl(u), 'a picture file: ' + u, null);
  // The near misses, each a real way this gets over-eager. The rule is
  // deliberately narrow: a false positive swallows a clickable URL.
  check(!isDirectImageUrl('https://a.example/i.png?size=large'),
    'an image extension behind a query is a GENERATED image, not the file', null);
  check(isDirectImageUrl('https://a.example/i.png#frag'),
    'a fragment is harmless — the request is the same file', null);
  check(!isDirectImageUrl(PAGE), 'an ordinary page is not a picture', null);
  check(!isDirectImageUrl('ftp://a.example/a.png'), 'only http(s)', null);
  check(!isDirectImageUrl('not a url'), 'garbage is not a picture', null);
  // …and the rule is the EMBED's: every URL the predicate claims has to be the
  // one the embed pass renders as a picture, or text and embed have drifted.
  for (const u of ['https://cdn.example.com/a.png', 'https://a.example/b.jpeg', 'http://a.example/c.gif']) {
    const card = embedForUrl(u) || '';
    check(card.includes('embed-img') && card.includes('data-fb-img="' + u + '"') && isDirectImageUrl(u),
      'the embed pass renders this one as a picture, tagged with its URL: ' + u, card);
  }
}

console.log('\n[2] the message text: the picture link is the picture, not a line of URL');
{
  const bare = renderRich(PIC);
  check(textOf(bare) === PIC, 'a message that is just a picture link reads as that URL', textOf(bare));
  check(!/<a /.test(bare), 'with no anchor in it', bare);
  check(bare.includes('data-fb-img-text="' + PIC + '"'),
    'and it is marked, so a failed picture can hand the link back', bare);
  check(linkEmbedsHTML(PIC).includes('embed-img'), 'the picture is still embedded below', linkEmbedsHTML(PIC));

  check(/<a href="https:\/\/example\.com\/article"/.test(renderRich(PAGE)),
    'an ordinary link is still an anchor', renderRich(PAGE));

  const withWords = renderRich('look ' + PIC);
  check(/<a href="https:\/\/cdn\.example\.com\/pics\/holiday\.JPEG"/.test(withWords),
    'a picture link inside a sentence keeps its anchor (prose is prose)', withWords);
  check(!withWords.includes('data-fb-img-text'), 'and is not marked as a picture-only message', withWords);

  // Trailing punctuation is part of the SENTENCE, not the link — a paste ending
  // in a full stop must not turn a bare picture link back into an anchor.
  const dot = renderRich(PIC + '.');
  check(!/<a /.test(dot) && textOf(dot) === PIC + '.', 'a full stop after the link changes nothing', textOf(dot));

  const padded = renderRich('   ' + PIC + '\n  ');
  check(!/<a /.test(padded) && textOf(padded).trim() === PIC,
    'whitespace around it (a paste keeps its newline) is not a reason to keep the link', textOf(padded));

  // Two links in one message: every one of them has the other's words around it,
  // so every one of them stays a link. The rule is "the whole of the message",
  // not "the first link" — a second picture never swallows the first.
  const two = renderRich(PIC + '\n' + PIC);
  check((two.match(/<a /g) || []).length === 2 && !two.includes('data-fb-img-text'),
    'two links in one message both stay links', two);
  const twoWords = renderRich(PIC + '\nsee also ' + PIC);
  check((twoWords.match(/<a /g) || []).length === 2 && !twoWords.includes('data-fb-img-text'),
    'and words around either one keep them both', twoWords);

  // Markdown around the link still renders; only the LINK is suppressed, and a
  // message that is nothing but `**link**` is still nothing but the link.
  const bolded = renderRich('**' + PIC + '**');
  check(/<strong>https:\/\/cdn\.example\.com\/pics\/holiday\.JPEG<\/strong>/.test(bolded),
    'the message still formats around it', bolded);
  const boldOnly = renderRich('**' + PIC + '**');
  check(!/<a /.test(boldOnly) && boldOnly.includes('data-fb-img-text'),
    'and markdown delimiters are not words — a bolded link is still picture-only', boldOnly);
  const spoilOnly = renderRich('||' + PIC + '||');
  check(!/<a /.test(spoilOnly) && spoilOnly.includes('data-fb-img-text'),
    'and a spoilered one is still picture-only', spoilOnly);
  check(renderRich('look ||' + PIC + '||').includes('<a href='), 'but a spoilered link in a sentence stays a link', null);

  // Code is never embedded, so a link inside code keeps its link.
  const quoted = renderRich('`' + PIC + '`');
  check(/<code>https:\/\/cdn\.example\.com\/pics\/holiday\.JPEG<\/code>/.test(quoted) && !/<a /.test(quoted),
    'a code-quoted picture link is code, not an anchor (it never embeds either)', quoted);
  const fenced = renderRich('```\n' + PIC + '\n```');
  check(/<pre class="codeblock">/.test(fenced) && !/<a /.test(fenced) && !fenced.includes('data-fb-img-text'),
    'and a fenced one is a code block that keeps its link', fenced);
}

console.log('\n[3] the composer, the story surfaces, and a missing embeds.js');
{
  // The composer's backdrop must lay out EVERY character — the caret lives on
  // it — so the decision is off in plain mode.
  const bd = renderRich(PIC, { plain: true });
  check(textOf(bd) === PIC, 'the composer backdrop still shows the whole URL', textOf(bd));
  check(/<a href="https:\/\/cdn\.example\.com\/pics\/holiday\.JPEG"/.test(bd) && !bd.includes('data-fb-img-text'),
    'and still anchors it, with no marker, exactly as before', bd);
  check(/<a href="https:\/\/example\.com\/article"/.test(renderRich('see ' + PAGE, { plain: true })),
    'other links in the backdrop are untouched', null);

  // A story's caption is typed prose, not a caption for a picture, and its
  // surfaces are deliberately separate (storyTextHTML / linkifyHTML).
  check(linkifyHTML('see ' + PIC).includes('<a href='), 'a story caption keeps its link', linkifyHTML('see ' + PIC));
  const sticker = storyTextHTML(PIC);
  check(sticker.includes('embed-link compact') && !sticker.includes('embed-img'),
    'and a sticker is still the compact card, never a full-size picture', sticker);

  // renderRich running on a surface where embeds.js never loaded: isDirectImageUrl
  // is genuinely not in scope there (its own scope, not this test's), so every
  // link anchors, exactly as it always did. A URL is never silently swallowed.
  // A fresh realm, so nothing this file defined can answer for the page: the
  // source is evaluated with the handful of globals the app itself provides and
  // no isDirectImageUrl at all.
  const noRule = (() => {
    try {
      const vm = require('vm');
      const ctx = vm.createContext({
        S: { emojiAll: {}, stdEmoji: {}, me: { id: 'u1' }, view: 'server', serverDetail: null },
        memberByUsername: () => null, esc: global.esc,
      });
      vm.runInContext(code + '\n;globalThis.__rr = renderRich;', ctx);
      return ctx.__rr(PIC);
    } catch (e) { return 'THREW: ' + e.message; }
  })();
  check(!!noRule && /<a href="https:\/\/cdn\.example\.com\/pics\/holiday\.JPEG"/.test(noRule) && !noRule.includes('data-fb-img-text'),
    'without embeds.js loaded the link is left alone (never silently swallowed)', noRule);
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Chromium found (set CHROME_PATH)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-imgtext-'));
  const srv = http.createServer((req, res) => {
    if (/^\/$/.test(req.url || '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body><div id="messages"></div><script>'
        + pagePrelude.replace(/<\//g, '<\\/') + '<\/script>');
      return;
    }
    if (/^\/favicon\.ico/.test(req.url || '')) { res.writeHead(204); res.end(); return; }
    if (/^\/pics\/here\.png$/.test(req.url || '')) {
      // One real pixel, so a check about a picture that WORKS (the lightbox tap)
      // has a picture that stays on screen and cannot race the 404.
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      return;
    }
    // Everything else 404s: this half is about what a BROKEN picture leaves
    // behind, and the 404 is the whole point. An <img> that never asks is a
    // different bug, so the request is logged — a picture that is not there
    // should be visible in the output as an image that WAS asked for.
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(String(req.url).split('?')[0])) {
      console.log('    [test] picture requested and refused: ' + req.url);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--window-size=800,600', ...chromeFlags(), 'about:blank'], { stdio: 'ignore' });
  chrome.on('error', (e) => console.log('[test] chrome would not start: ' + e.message));
  onExit(() => { try { chrome.kill(); } catch {} });
  onExit(() => { try { srv.close(); } catch {} });
  onExit(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

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
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const call = (method, params, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, sessionId, method, params }));
    });
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const sess = (m, p) => call(m, p, sessionId);
    const ev = async (expression) => {
      const r = await sess('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
      return r.result.value;
    };
    await sess('Page.enable');
    await sess('Runtime.enable');
    await sess('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await sleep(600);
    if ((await ev('typeof window.__messageEl')) !== 'function') {
      console.error('[test] the real embeds.js / core.js / messages.js pair did not evaluate in the page: '
        + (await ev('window.__preludeError || "(no error recorded)"')));
      process.exit(1);
    }

    console.log('\n[4] the two halves, asked in step (the real messages.js pair)');
    const dead = 'http://127.0.0.1:' + port + '/pics/missing.jpeg';
    const live = 'http://127.0.0.1:' + port + '/pics/here.png';
    const keepPic = await ev('window.__keep(' + JSON.stringify(dead) + ')');
    check(typeof keepPic === 'string' && keepPic.includes('embed-img') && keepPic.includes('data-fb-img="' + dead + '"'),
      'a message that is only a picture link keeps its picture card', keepPic);
    for (const t of ['look ' + PIC, '**' + PIC + '**', '`https://example.com/a.png`', PIC + '\n' + PIC,
      '```\n' + PIC + '\n```', PAGE, 'https://a.example/x.png?size=2', 'plain words', '']) {
      check((await ev('window.__keep(' + JSON.stringify(t) + ')')) === '',
        'and no card is forced for anything else: ' + JSON.stringify(t).slice(0, 40), null);
    }
    // The one shape the text cannot tell: a real system line is a line in the
    // channel, so the ROW is the signal (messageEl asks with `m.sys ? ''`).
    const sysHtml = await ev(`(() => {
      const el = document.createElement('div');
      el.innerHTML = window.__messageEl({ id: 'sx', sys: 'info', content: ${JSON.stringify(dead)}, created_at: Date.now() });
      return el.innerHTML;
    })()`);
    check(/class="msg sys"/.test(sysHtml) && !sysHtml.includes('embed-img') && !sysHtml.includes('data-fb-img-text'),
      'a system line is a line in the channel, whatever its text says', sysHtml.slice(0, 160));

    console.log('\n[5] a pasted picture, painted, tapped, and left broken (real 404)');
    // The real message, with the real picture, against a server that 404s every
    // image. Two things are watched: what the row looks like while the picture
    // is there, and what is left when it is not.
    const paint = (id, content) => ev(`(() => {
      const m = { id: ${JSON.stringify(id)}, user: 'u1', content: ${JSON.stringify(content)}, created_at: Date.now() };
      S.messages.set('c-' + ${JSON.stringify(id)}, [m]);
      const el = document.createElement('div');
      el.innerHTML = window.__messageEl(m);
      document.getElementById('messages').appendChild(el.firstElementChild);
    })()`);
    const read = (id) => ev(`(() => {
      const msg = document.querySelector('.msg[data-mid="${id}"]');
      const text = msg && msg.querySelector('.text');
      const mark = text && text.querySelector('[data-fb-img-text]');
      const a = text && text.querySelector('a');
      return {
        text: text ? text.textContent : '',
        markedUrl: mark ? mark.getAttribute('data-fb-img-text') : '',
        href: (a && a.getAttribute('href')) || '',
        anchors: msg ? msg.querySelectorAll('.text a').length : -1,
        imgs: msg ? msg.querySelectorAll('.embed-img').length : -1,
        cards: msg ? msg.querySelectorAll('.embed-link').length : -1,
      };
    })()`);
    const tap = (id) => ev(`(() => {
      const img = document.querySelector('.msg[data-mid="${id}"] .embed-img');
      if (!img) return 'no picture to tap';
      img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return window.__acts.join(',');
    })()`);

    await paint('m0', live);
    let st = await read('m0');
    check(st.anchors === 0 && st.imgs === 1 && st.cards === 0,
      'painted, a picture-only message is the picture: no anchor in the text, one card', st);
    check(st.markedUrl === live,
      'and the text carries the marker the recovery needs, naming the same URL', st);
    // The picture is the message now, so a TAP ON IT has to keep working — this
    // is what the text used to be the backup for.
    check((await tap('m0')) === 'lightbox:' + live,
      'and tapping the picture still opens the lightbox on it', null);

    // …and when the picture does not load, the URL comes back where the text was.
    await paint('m1', dead);
    await sleep(1200);
    st = await read('m1');
    check(st.anchors === 1 && st.href === dead && !st.markedUrl,
      'a picture that will not load hands its link back where the raw text was',
      { ...st, wired: await ev('typeof document.querySelector("img[data-fb-img]")'), closest: await ev('!!document.querySelector("img[data-fb-img]") && !!document.querySelector("img[data-fb-img]").closest(".msg .text")') });
    check(st.text.trim() === dead, 'and the message is that URL again, nothing else', st);
    check(st.imgs === 0, 'with the dead picture gone, not left as a black rectangle', st);

    // A message with WORDS around the same link is a sentence, not a caption:
    // its anchor was never dropped, and its own dead picture is answered too.
    await paint('m2', 'look ' + dead);
    await sleep(1200);
    st = await read('m2');
    check(st.anchors === 1 && st.href === dead && st.text.indexOf('look ') === 0 && !st.markedUrl,
      'a sentence keeps its own link, the words and all', st);
    check(st.cards === 0, 'and no card is invented for it either', st);
    check(st.imgs === 0, 'while its own dead picture is still cleared away', st);
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { srv.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
