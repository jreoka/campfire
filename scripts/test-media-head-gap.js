// The gap between a message's head row and the media under it.
//
// Reported (with a screenshot and the server tag circled): a pasted picture sat
// flush against the name/tag/time row, the tag's descender visually touching the
// top of the image. A link card in the same place was not, which is the whole
// clue — and the cause is structural, not a matter of taste:
//
//   A picture-only message is the ONE media shape with no `.embeds` wrapper.
//   `keepEmbedFor` returns the bare `.embed` card (it is deliberately NOT a
//   list, and the test right above this file pins that), so it never met
//   `.embeds{margin-top:.45rem}` and got no top margin at all. Link cards,
//   players and attachment strips are all inside `.embeds` or `.msg-atts` and
//   were fine.
//
//   So the air is bought on `.embed-plain` itself, with a sibling exception for
//   the case where the card FOLLOWS text: the head's margin is then air for a
//   head it has nothing to do with, and the text's line box has already closed
//   the gap. The exception is `.msg .text + .embed-plain`, which can only match
//   when there really is text above (the card is a sibling of `.text`, never a
//   descendant), and it is set to .35rem — the number an UPLOADED picture
//   already gets from `.msg-atts` — so a pasted link and an uploaded file come
//   to rest at ONE gap instead of two.
//
// This measures it rather than asserting the CSS text, because the bug is a
// rendered distance: `.msg{padding:.45rem .6rem}` is also the hover pill, so
// "add padding to the row" would have passed a static check and broken every
// message's highlight.
//
// Halves:
//   [A] headless Chrome — builds the REAL message rows from the real
//       messages.js/core.js/embeds.js and the real styles.css, and MEASURES
//       head→media for: a pasted picture with a server tag, one without, a link
//       card, a sentence followed by a picture, and an uploaded picture.
//   [B] static — the rule exists, the exception is scoped to a sibling (so it
//       cannot reach a card nested inside something else), and the picture-only
//       card is still the bare one with no wrapper.
//
// Skips (exit 0) without Chrome. Usage: node scripts/test-media-head-gap.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9371', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(1); }

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/ms-playwright/chromium-1148/chrome-linux/chrome',
    '/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/home/agent/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const chromePath = findChrome();
if (!chromePath) skip('no Chrome/Chromium found (set CHROME_PATH)');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const css = read('public/styles.css');

// The five rows, built from the real sources. The server tag is what the report
// circled, so the tagged case is the one that has to be measured first.
//
// SLICED, not concatenated: messages.js ends in top-level init code that reaches
// for DOM the harness does not have (`Cannot set properties of null`), and
// inlining whole files drags in every other module's globals with it. The slice
// takes keepEmbedFor + the real messageEl — the same two the image-link test
// takes — so the row painted here is the row the app paints, with no new stubs
// to lie. What the row needs that is not in the slice is stubbed ONCE, above.
const msgs = read('public/js/messages.js');
const pairFrom = msgs.indexOf('function keepEmbedFor(');
const elFrom = msgs.indexOf('function messageEl(m, opts = {}) {', pairFrom);
const elTo = msgs.indexOf('// Discord-style grouping', elFrom);
if (pairFrom < 0 || elFrom < 0 || elTo < 0 || elFrom <= pairFrom) {
  console.error('[test] could not find keepEmbedFor() / messageEl() in public/js/messages.js');
  process.exit(1);
}
// Take whole top-level functions by name, brace-matched, out of the real
// sources. Boundaries by NAME (not by a comment that happens to follow) and
// brace-matched rather than sliced to the next blank line: both of those were
// wrong first time and produced `SyntaxError: Unexpected end of input` from a
// half-copied function, which is the worst possible shape of test harness bug —
// it looks like the app is broken.
// Take whole top-level functions by name out of the real sources.
//
// The brace matching is a real scanner, not a counter: braces inside string
// literals, template literals, comments and REGEX literals are not code, and a
// counter ends the function early on the first one it meets — which produces
// `SyntaxError: Unexpected token 'function'` from a half-copied function and
// looks exactly like the app being broken.
function takeFns(src, names) {
  const out = [];
  for (const name of names) {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) { console.error('[test] could not find function ' + name); process.exit(1); }
    let depth = 0, paren = 0, bracket = 0, j = i, opened = false;
    while (j < src.length) {
      const ch = src[j], nx = src[j + 1];
      if (ch === '/' && nx === '/') { j = src.indexOf('\n', j); if (j < 0) break; continue; }
      if (ch === '/' && nx === '*') { j = src.indexOf('*/', j); if (j < 0) break; j += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch; j++;
        while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
        j++; continue;
      }
      if (ch === '/' && isRegexStart(src, j)) { j = skipRegex(src, j); continue; }
      // Braces are only the function BODY at paren depth 0. Inside the
      // parameter list they are a default value or a destructuring pattern —
      // `function renderRich(text, opts = {}) {` has a `{}` that closes before
      // the body ever opens, and counting it ends the function at 40 characters
      // and yields "Unexpected token 'function'". Same for a call argument.
      if (ch === '(') { paren++; j++; continue; }
      if (ch === ')') { paren--; j++; continue; }
      if (ch === '[') { bracket++; j++; continue; }
      if (ch === ']') { bracket--; j++; continue; }
      if (!paren && !bracket) {
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') { depth--; if (opened && depth === 0) { j++; break; } }
      }
      j++;
    }
    const fn = src.slice(i, j);
    try { new Function(fn); } catch (e) {
      console.error('[test] slice of ' + name + ' does not parse: ' + e.message);
      console.error('  ends with: ' + JSON.stringify(fn.slice(-90)));
      process.exit(1);
    }
    out.push(fn);
  }
  return out.join('\n');
}
// A '/' starts a regex (not a division) when the previous meaningful char cannot
// end an expression. Good enough for this file's sources, and a misread here
// only ever makes the slice longer, never shorter.
function isRegexStart(src, j) {
  for (let k = j - 1; k >= 0; k--) {
    const c = src[k];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    return !/[)\]}\w$]/.test(c);
  }
  return true;
}
function skipRegex(src, j) {
  j++; let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j++; while (j < src.length && /[a-z]/.test(src[j])) j++; return j; }
    j++;
  }
  return j;
}
const coreSrc = read('public/js/core.js');
// memberById is how the row resolves the author out of S.serverDetail, which is
// what puts the server tag on the head at all — the thing the report circled.
const rowBits = takeFns(coreSrc, ['esc', 'activeTagFor', 'tagHTML', 'avatarColorFor', 'avatar', 'paintAvatar', 'msgAuthor', 'fmtFull', 'fmtTime', 'renderRich', 'emojifyHTML', 'mentionMatcher', 'reEsc', 'memberIsAdmin', 'memberById', 'isBigEmoji']);
// msgAuthor calls liveUserFor (servers.js) to decide whether a message is live or
// deleted; the real one is taken, not stubbed, so the head row this measures is
// the head row the app draws.
const srvSrc = read('public/js/servers.js');
// nameClassFor paints the author's name colour, and canMod decides whether the
// hover bar is drawn — both are on the path messageEl walks for every row.
const liveBits = takeFns(srvSrc, ['liveUserFor', 'nameClassFor', 'nameStyleFor', 'topRoleOf']);
// …and the one module-level const nameClassFor needs, taken by its own line so
// the test keeps failing loudly if that name ever changes.
function letLine(src, name) {
  const m = src.match(new RegExp('^let ' + name + ' = [^\n]*', 'm'));
  if (!m) { console.error('[test] could not find `let ' + name + ' = ...`'); process.exit(1); }
  return m[0];
}
function constLine(src, name) {
  const m = src.match(new RegExp('^const ' + name + ' = [^\n]*', 'm'));
  if (!m) { console.error('[test] could not find `const ' + name + ' = ...`'); process.exit(1); }
  return m[0];
}
// embeds.js is where the link card and the pasted-picture card are BUILT, and
// this report is about the gap those two sit under — so the real builders are
// here, not a hand-made approximation of them.
const embSrc = read('public/embeds.js');
// embedForUrl is NOT taken: it dispatches to every provider (ytFromUrl,
// spotifyFromUrl, tweetIdFromUrl, …), so pulling it in drags the whole file's
// dependency graph behind it. directMediaEmbedHTML is the branch that matters —
// it is what a pasted picture is — and linkCardHTML is what a link is. The
// link-card row below is built with the real linkCardHTML, which is the same
// builder linkEmbedsHTML reaches, so the measured card is the app's card.
// linkEmbedsHTML has to be HERE, not just linkCardHTML: messageEl gates the
// whole card on `typeof linkEmbedsHTML === 'function'` and silently paints bare
// text without it. That guard is why the first run of this test found no card
// at all on a pasted picture and reported MISSING rather than a number.
const embedBits = takeFns(embSrc, ['linkEmbedsHTML', 'directMediaEmbedHTML', 'isDirectImageUrl', 'cleanEmbedUrl', 'eh', 'linkCardHTML', 'cardBodyHTML', 'cardTextHTML', 'seedMeta', 'ytIdFromUrl', 'ytFromUrl', 'embedHost', 'stripEmbedIgnored', 'inviteFromUrl']);
const attBits = takeFns(msgs, ['attsBlockHTML', 'attachmentHTML', 'attachmentBodyHTML', 'attsCollage', 'attIsAnimated', 'attCleanUrl', 'imageSrcFor', 'thumbSrcFor', 'attDimsFor', 'attMeta', 'attDl', 'attFavHTML', 'gifFavKeyFor', 'gifFavMatch', 'gifUrlFavKey']);
// attsBlockHTML calls attachmentHTML and attsCollage, and the uploaded-picture row
// is the other half of this report ("the image uploads and embeds"), so the
// upload case is painted by the app's own code rather than by a hand-made div.
const pagePrelude = `const AV_COLORS = ['#5b8cff'];
const AV_DECO_IDS = new Set();
${rowBits}
${constLine(msgs, 'attDimsSeen')}
${constLine(msgs, 'DL_ICON')}
${constLine(msgs, 'ATT_STAR_SVG')}
${letLine(coreSrc, 'mentionCache')}
${constLine(embSrc, 'IMG_EXT_RE')}
${constLine(embSrc, 'INVITE_MAX')}
${constLine(embSrc, 'EMBED_MAX')}
${constLine(embSrc, 'CARD_MAX')}
${constLine(embSrc, 'INVITE_PATH')}
${constLine(embSrc, 'cardCache')}
${constLine(embSrc, 'YT_ID')}
${letLine(embSrc, 'previewsOn')}
${constLine(msgs, 'ATT_ANIMATED_EXT_RE')}
${constLine(srvSrc, 'HEXC')}
${liveBits}
${embedBits}
${attBits}
${takeFns(msgs, ['noteAttPreviewRendered'])}
${msgs.slice(pairFrom, elTo)}
// S.me is a DIFFERENT person from the author on purpose. liveUserFor short-
// circuits to S.me when the ids match, and S.me carries no active_tag — so a
// fixture that made the author "me" would silently drop the very server tag the
// report circled, and the tagged and untagged rows would measure the same thing.
const S = { view: 'server', me: { id: 'um', display_name: 'Me', username: 'me' },
  serverDetail: { members: [
    { id: 'u9', display_name: 'Cross', username: 'cross', active_tag: 'uwu', active_tag_server_id: 'sid1' },
    { id: 'u2', display_name: 'Plain', username: 'plain' },
  ] }, messages: new Map(), dmMessages: new Map(), thread: null,
  editing: null, pendingAtts: [], gifFavs: { items: [] } };
window.S = S;
// The hover bar (quick reactions + reply + overflow) is appended by messageEl
// into the row and positioned OUTSIDE its flow, so it cannot change the distance
// this test measures. It is stubbed rather than taken, and that is the only
// stub: it is a sibling of the head in a container that clips it, and pulling
// it in would drag the whole reaction picker graph behind it.
// The picked-bytes store that noteAttPreviewRendered writes to: it exists so a
// file the composer is holding can be told apart from one already sent. A row
// painted here was never picked, so it is a no-op — but the REAL function is
// taken rather than stubbed so that stays true if the bookkeeping ever changes.
const attPreviewRendered = new Map();
// attShot is the still FRAME a clip's card shows before its video paints, and the
// blur placeholder behind an image that has not decoded. Both are about a
// picture that is NOT there yet; the rows measured here are images that loaded,
// so the shot is dropped rather than faked — a fabricated one would put a real
// box where the app has none and measure the wrong gap.
function attShot() { return null; }
function quickReactsHTML() { return ''; }
function reactionsHTML() { return ''; }
function threadCardHTML() { return ''; }
function voCardHTML() { return ''; }
function pollHTML() { return ''; }
// keepEmbedFor asks embedForUrl what a picture link becomes. In the app that is
// the full provider dispatch; here only the direct-image branch is reachable for
// the rows below, so the dispatcher is rebuilt as that single branch — and the
// assertion that the card is the BARE one (no .embeds wrapper) is what would
// catch this stub quietly growing a wrapper later.
function embedForUrl(url) { return directMediaEmbedHTML(url); }
window.__messageEl = messageEl;
`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-headgap-'));
  const srv = http.createServer((rq, rs) => {
    if (/^\/pics\//.test(rq.url || '')) {
      rs.writeHead(200, { 'Content-Type': 'image/png' });
      rs.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      return;
    }
    if (/^\/$/.test(rq.url || '')) {
      rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      rs.end('<!doctype html><meta charset="utf-8"><body><div id="messages"></div><link rel="stylesheet" href="/styles.css"><script>'
        + pagePrelude.replace(/<\//g, '<\\/') + '<\/script>');
      return;
    }
    if (/^\/styles\.css/.test(rq.url || '')) {
      rs.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      rs.end(css);
      return;
    }
    rs.writeHead(404); rs.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const c = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(dir, 'p'), '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--force-device-scale-factor=2', 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 120 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch { await sleep(500); } }
  if (!ver) { c.kill(); srv.close(); throw new Error('Chrome never published /json/version'); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64e6 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0; const pend = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const call = (m, p, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, (x) => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result)); ws.send(JSON.stringify({ id: i, sessionId: s, method: m, params: p })); });
  const target = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
  const sess = (await call('Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
  await call('Page.enable', {}, sess); await call('Runtime.enable', {}, sess);
  const ev = async (e) => { const r = await call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sess);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };

  const pageErrs = [];
  ws.on('message', (raw) => { const x = JSON.parse(raw);
    if (x.method === 'Runtime.exceptionThrown') pageErrs.push((x.params.exceptionDetails.exception || {}).description || x.params.exceptionDetails.text); });
  await call('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' }, sess);
  await sleep(2500);
  if (pageErrs.length) { console.log('page errors:', pageErrs.slice(0, 3).join('\n')); }

  // The rows are parked in a VISIBLE host, not in #messages: that list is
  // display:none when nobody is signed in, so a row left in it lays out to
  // zero-height boxes and every rect reads 0 — a measurement of nothing. The
  // styles are all global (.msg, .embeds, .embed-plain) so a host in the body
  // gets the identical cascade.
  const NL = 'String.fromCharCode(10)';
  const m = await ev(`(async () => {
    const IMG = 'http://127.0.0.1:' + ${port} + '/pics/here.png';
    const host = document.createElement('div');
    host.id = 'gapprobe';
    host.style.cssText = 'position:fixed;left:0;top:0;width:640px;z-index:99999;background:#101216;';
    document.body.appendChild(host);
    const settle = (img) => { if (!img || img.complete) return Promise.resolve();
      return new Promise((r) => { const t = setTimeout(r, 3000);
        img.addEventListener('load', () => { clearTimeout(t); r(); }, { once: true });
        img.addEventListener('error', () => { clearTimeout(t); r(); }, { once: true }); }); };
    const measure = async (label, msg) => {
      host.innerHTML = '';
      const row = window.__messageEl(msg);
      host.appendChild(row);
      await settle(row.querySelector('.embed-img') || row.querySelector('img.att-img'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const head = row.querySelector('.head');
      // The gap is measured to the TOP of the MEDIA BLOCK, not to the <img>.
      // For a picture inside '.embeds' the block's own top margin is part of
      // the air, and the img is a grandchild — measuring the img would fold
      // that margin in and hide exactly the double-spacing being checked for.
      const media = row.querySelector('.embed-plain') || row.querySelector('img.att-img')
        || row.querySelector('.att-img') || row.querySelector('.embed') || row.querySelector('.msg-atts');
      if (!head || !media) return { label, missing: 'head=' + !!head + ' media=' + !!media };
      const hb = head.getBoundingClientRect(), mb = media.getBoundingClientRect();
      // The AIR is the space directly above the media, measured from whatever
      // the media actually hangs under. For a picture-only message that is the
      // head; for a picture under a sentence it is the .text div, whose own
      // bottom already sits off the head. Measuring every row from the head
      // would fold the sentence's own line box into the picture's gap and make
      // "a picture under text looks further away" read as a spacing bug when it
      // is just the sentence being there.
      // The box whose TOP MARGIN is the air — the OUTERMOST media container,
      // not the picture itself. Two shapes force that:
      //   a card inside .embeds is the list's only child, so measuring the card
      //     fell back to the head and swallowed the sentence's whole line box;
      //   an uploaded picture is .msg-atts > .att-slot > .att-wrap > img, with
      //     an .att-ph placeholder SIBLING before the img, so measuring the img
      //     read the placeholder's line rather than the strip's margin.
      // So: take every media container in the row, then walk back down to the
      // one that is not itself inside another. Climbing by parent chain was
      // tried first and overshot into .body, whose top is the avatar's.
      const CONTAINERS = '.msg-atts, .embeds, .embed-plain';
      const all = Array.from(row.querySelectorAll(CONTAINERS))
        .filter((el) => !el.parentElement.closest(CONTAINERS));
      const box = all[0] || media;
      const ref = box.previousElementSibling || head;
      return {
        label,
        gap: +(box.getBoundingClientRect().top - ref.getBoundingClientRect().bottom).toFixed(1),
        headGap: +(box.getBoundingClientRect().top - hb.bottom).toFixed(1),
        under: (ref.className || ref.tagName.toLowerCase()).split(' ')[0],
        box: (box.className || '').split(' ')[0],
        // The CSS margin actually in force on the media box, so a failing
        // number below can be read against the rule that produced it.
        margin: getComputedStyle(box).marginTop,
        // The top of the picture the reader actually sees. For a card inside
        // .embeds this can differ from the wrapper's top by the card's own
        // margin, so a fix that cancelled the wrapper but not the card would
        // pass a wrapper-only measurement and still double-space the picture.
        // The top of the PICTURE, not the top of its container. Inside a flex
        // .embeds list a child card's own margin grows the list downward, so
        // the list's top edge never moves and measuring IT reads identical with
        // the margin present and absent — which is how the first version of
        // this check passed while the picture was double-spaced under text. A
        // link card has no <img>, so for that shape the box IS the top the
        // reader sees and the picture edge is the box edge.
        seen: (() => { const im = row.querySelector('.embed-img') || row.querySelector('img.att-img');
          const top = im ? im.getBoundingClientRect().top : box.getBoundingClientRect().top;
          return +(top - ref.getBoundingClientRect().bottom).toFixed(1); })(),
        hasTag: !!row.querySelector('.usertag'),
        // Which shape this row is: the bare card keepEmbedFor returns, a card
        // inside the .embeds list, or an uploaded file's strip.
        wrapper: row.querySelector('.msg-atts') ? '.msg-atts'
          : row.querySelector('.embeds .embed-plain') ? '.embeds > .embed-plain'
          : row.querySelector('.embeds') ? '.embeds'
          : 'bare .embed-plain',
        textAbove: !!row.querySelector('.text'),
        // What the user actually SEES: the top of the picture, not the box.
        imgGap: (() => { const im = row.querySelector('.embed-img') || row.querySelector('img.att-img') || row.querySelector('.att-img');
          return im ? +(im.getBoundingClientRect().top - hb.bottom).toFixed(1) : null; })(),
      };
    };
    const res = [];
    // m.user is a USER OBJECT, not an id: liveUserFor(m.user) is what msgAuthor
    // hands the head, and a bare string there paints "undefined" as the author
    // and drops the server tag — which is the exact thing the report is about,
    // so getting it wrong would have made the whole measurement meaningless.
    const tagged = { id: 'u9', display_name: 'Cross', username: 'cross', active_tag: 'uwu', active_tag_server_id: 'sid1' };
    const untagged = { id: 'u2', display_name: 'Plain', username: 'plain' };
    res.push(await measure('pasted picture + server tag', { id: 'g1', user: tagged, content: IMG, created_at: 1 }));
    res.push(await measure('pasted picture, no tag', { id: 'g2', user: untagged, content: IMG, created_at: 1 }));
    res.push(await measure('sentence then picture', { id: 'g3', user: tagged, content: 'look at this' + ${NL} + IMG, created_at: 1 }));
    res.push(await measure('link card', { id: 'g4', user: tagged, content: 'https://en.wikipedia.org/wiki/Dog', created_at: 1 }));
    res.push(await measure('uploaded picture', { id: 'g5', user: tagged, content: '', created_at: 1,
      attachments: [{ id: 'a1', kind: 'image', name: 'x.png', url: IMG, size: 1, width: 1, height: 1 }] }));
    host.remove();
    return res;
  })()`);

  const by = {};
  for (const r of m) by[r.label] = r;

  console.log('\n[A] the real gap, measured in a real browser');
  console.log('  ' + m.map((r) => r.label + '=' + (r.missing ? 'MISSING' : (r.seen != null ? r.seen : r.gap) + 'px')).join('\n  '));

  const tagged = by['pasted picture + server tag'];
  const plain = by['pasted picture, no tag'];
  const after = by['sentence then picture'];
  const link = by['link card'];
  const upload = by['uploaded picture'];
  const ok = (r) => !!(r && !r.missing);
  const okGaps = [tagged, plain, after, link, upload].filter(ok);

  check(ok(tagged) && tagged.hasTag,
    'the row really does carry the server tag from the report', tagged);
  check(ok(tagged) && tagged.wrapper === 'bare .embed-plain',
    'a picture-ONLY message is the bare card with no .embeds wrapper — the reason it had no margin', tagged);
  check(ok(tagged) && tagged.seen >= 4,
    'and that bare card keeps its air below the head row', tagged);
  check(ok(plain) && plain.seen >= 4,
    'a pasted picture without a tag gets the same air (it is not a tag-shaped fix)', plain);
  check(ok(plain) && ok(tagged) && plain.seen === tagged.seen,
    'and exactly the same, so the gap does not depend on the tag', { tag: tagged.gap, plain: plain.gap });
  check(ok(after) && after.wrapper === '.embeds > .embed-plain',
    'a picture UNDER TEXT is the other shape — wrapped in .embeds', after);
  check(ok(after) && after.seen >= 4 && after.seen === link.seen,
    'that wrapped card sits exactly where a link card does — no double air',
    { picture: after.seen, link: link.seen });
  check(ok(link) && link.seen >= 4,
    'a link card, unchanged, still sits off the head row', link);
  check(ok(upload) && upload.margin === '5.6px' && upload.seen > upload.gap,
    'an uploaded picture still has its own air, and its card box still offsets the picture', upload);
  // The invariant the fix is FOR: every way of hanging a picture off a message
  // comes to rest at ONE gap. Before it, the bare card read 0 (flush against
  // the head — the reported collision) and, had the margin simply been added,
  // the card under a sentence would have read twice the link card's; this is
  // the single assertion that would notice either.
  const airShapes = [tagged, plain, after, link].filter(ok);
  check(airShapes.length === 4 && new Set(airShapes.map((r) => r.seen)).size === 1,
    'pasted picture (tagged or not), picture under text and link card all land at ONE gap',
    { gaps: airShapes.map((r) => r.label + '=' + r.seen) });
  // The upload is deliberately NOT folded into that number: .msg-atts has worn
  // .35rem for far longer than this bug and the report is not about it, so the
  // test pins the existing value rather than quietly restyling every upload.
  // The UPLOAD is the one shape whose air is not a bare margin. Its card wears
  // .att-wrap, which carries a reserved placeholder box and its own inset, so
  // the picture's top edge legitimately sits further down than the strip's
  // margin — 20.6px against 5.6px here. What this test pins is therefore the
  // STRIP's margin (.msg-atts), which is the number this fix must not disturb;
  // the picture's absolute offset is reported but deliberately not asserted,
  // because pinning it would freeze the upload card's internal box too.
  check(ok(upload) && upload.box === 'msg-atts' && upload.margin === '5.6px',
    'an uploaded picture keeps its own .35rem (.msg-atts) — pinned, not restyled',
    { strip: upload.margin, pictureOffset: upload.seen, box: upload.box });

  console.log('\n[B] the rules, statically');
  // Comments are stripped first: the CSS above the rules explains WHY the
  // .text + .embed-plain idea was dropped, and a substring test over the raw
  // file would find that prose and read it as a live rule.
  const rules = css.split('\n').filter((l) => !/^\s*(?:\/\/|\*)/.test(l)).join('\n');
  check(/\.embed-plain\{[^}]*margin-top:\.45rem/.test(rules),
    '.embed-plain carries a top margin of its own');
  check(/\.embeds \.embed-plain\{[^}]*margin-top:0/.test(rules),
    'inside a .embeds list that margin is cancelled — no double air under text');
  check(/\.embeds\{[^}]*margin-top:\.45rem/.test(rules),
    '.embeds really is the .45rem the bare card now matches, so both shapes agree');
  check(/\.msg-atts\{[^}]*margin-top:\.35rem/.test(rules),
    '.msg-atts is .35rem — the gap an UPLOADED picture already had');
  check(!/\.embed-plain\{[^}]*padding/.test(rules),
    'the air is a margin, not padding — .msg padding is also the hover pill');
  check(!/\.text \+ \.embed-plain\{/.test(rules),
    'no .text + .embed-plain RULE: a picture-only message renders no .text, and a picture after text is a grandchild via .embeds, so that selector could never match');
  check(rules.split('\n').filter((l) => /^\.embed-plain\{/.test(l)).length === 1,
    'one .embed-plain rule, so the two declarations cannot be ordered by accident');

  ws.close(); c.kill(); srv.close();
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures.length ? '\nFAILED (' + failures.length + ')\n  - ' + failures.join('\n  - ') : '\nall ' + passed + ' checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(2); });
