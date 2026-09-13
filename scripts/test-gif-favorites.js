// GIFs shared in chat → the GIF picker's favorites.
//
// The request: "allow starring gifs shared in chats as favorite gifs to add to
// your favorites in the gif picker". The picker already had a favorites list,
// but only its own tiles could write to it — a GIF somebody posted in chat was
// just a picture with a Klipy CDN url, and nothing in that url identifies the
// Klipy item behind it (the CDN paths are opaque hashes; there is no way back
// from them to the slug, the thumb or the mp4). So the identity travels WITH the
// post instead: the picker stamps gifSlug/gifThumb/gifMp4 (and the measured
// shape) on the attachment it sends (`sendGif`), the server validates and stores
// it (`cleanGifMeta`), hydrates it back to every reader (`attWire`), and the chat
// renders a star in the corner of that GIF (`attFavHTML`). The star writes the
// same row a picker tile writes, keyed on the same Klipy slug — one list, two
// ways in, and both surfaces show the same starred state.
//
// Four parts:
//   [A] the wiring, statically: the guarded migration, the cleaner, the ingest
//       and hydration of the three fields, the menu row, the star's markup and
//       the stylesheet that reveals it;
//   [B] the two writers RUN for real (sliced out of pickers.js against fakes):
//       a star on a chat GIF and a picker tile must POST byte-identical bodies
//       for the same GIF, or "one list" quietly becomes two;
//   [C] headless Chrome against the REAL attachmentHTML + styles.css: the star
//       is on a picker GIF and nowhere else, it carries the whole favorite, it
//       sits inside the picture and clear of the download button, and its "on"
//       state is the account's list. Skips without Chrome.
//   [D] a real server against a throwaway database (skips without Postgres): the
//       identity survives post → history for a channel and a DM, a local upload
//       or a bogus slug never gets one, and the favorite built from what the
//       SERVER handed a reader lands in that account's list and nowhere else.
//
// Usage: node scripts/test-gif-favorites.js
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_gif_favorites';
const PORT = parseInt(process.env.TEST_PORT || '3441', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); }
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
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

const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');

// The real server-side cleaner, run as code (not grepped): this is the function
// that decides what is allowed to become a favorite.
const cleanerSrc = slice(server, '// Klipy slugs can contain uppercase', 'function attWire(');
const cleaner = new Function(cleanerSrc + '\nreturn { cleanGifMeta, GIF_FAV_SLUG_RE };')();

// The real client-side writers (a picker tile's and a chat star's), with just
// enough of the module around them to run.
function loadWriters() {
  const src = slice(pickers, 'async function toggleGifFav(g) {', '// Repaint every chat star');
  return new Function('S', 'api', 'toast', 'prettyError', 'refreshFavViews',
    src + '\nreturn { toggleGifFav, chatGifFavFromBtn };');
}
// The real identity helpers out of messages.js (the markup's own key function).
const favKey = new Function(
  slice(messages, 'function gifUrlFavKey(url) {', 'function attFavHTML(') +
  '\nreturn { gifUrlFavKey, gifFavKeyFor, gifFavMatch };')();

// ---------- [A] the wiring, offline ----------
function wiringChecks() {
  console.log('\n[A1] the identity has a home in the database');
  for (const col of ['gif_slug', 'gif_thumb', 'gif_mp4']) {
    check(db.includes(`addColumn('attachments', '${col}'`), `attachments.${col} is a guarded migration`);
    check(db.includes(`addColumn('dm_attachments', '${col}'`), `dm_attachments.${col} too`);
  }
  check(/gif_favorites/.test(db) && /PRIMARY KEY \(user_id, slug\)/.test(db),
    'the favorites table still keys on (user, Klipy slug) — that IS the shared list');

  console.log('\n[A2] the cleaner is a whitelist, and it is the server that decides');
  const good = cleaner.cleanGifMeta({
    url: 'https://static.klipy.com/ii/aaa/5e/90/UPvW7RGb.gif',
    gifSlug: 'sunday-al', gifThumb: 'https://static.klipy.com/ii/aaa/5e/90/xs.gif',
    gifMp4: 'https://static.klipy.com/ii/aaa/5e/90/md.mp4',
  });
  check(good.gif_slug === 'sunday-al' && good.gif_thumb.endsWith('xs.gif') && good.gif_mp4.endsWith('md.mp4'),
    'a picker GIF keeps its slug, thumb and mp4', good);
  check(cleaner.cleanGifMeta({ url: 'https://static.klipy.com/x.gif', gifSlug: 'goatplaybanjo-chat-4--ksp3BOGTL' }).gif_slug === 'goatplaybanjo-chat-4--ksp3BOGTL',
    'a slug with uppercase letters (Klipy really ships those) is accepted');
  check(cleaner.cleanGifMeta({ url: 'https://static.klipy.com/x.gif', gifSlug: 'no spaces or/slashes' }).gif_slug === null,
    'a slug that is not a slug is dropped');
  check(cleaner.cleanGifMeta({ url: 'https://static.klipy.com/x.gif' }).gif_slug === null,
    'so is a missing one');
  check(cleaner.cleanGifMeta({ url: '/uploads/files/aaaa.gif', kind: 'image', gifSlug: 'sunday-al' }).gif_slug === null,
    'an UPLOADED gif never carries a Klipy identity (there is no item behind it)');
  const badThumb = cleaner.cleanGifMeta({ url: 'https://static.klipy.com/x.gif', gifSlug: 'sunday-al', gifThumb: 'javascript:alert(1)', gifMp4: '/etc/passwd' });
  check(badThumb.gif_slug === 'sunday-al' && badThumb.gif_thumb === null && badThumb.gif_mp4 === null,
    'a non-http thumb/mp4 is dropped while the slug stands', badThumb);

  console.log('\n[A3] post → store → hydrate → render');
  check((server.match(/,gif_slug,gif_thumb,gif_mp4,created_at\)/g) || []).length === 3,
    'every insert (a channel post, a DM post, a webhook post) stores all three columns',
    (server.match(/,gif_slug,gif_thumb,gif_mp4,created_at\)/g) || []).length);
  check(/function attWire\(a, scan\)/.test(server) && (server.match(/attWire\(a, \(sk && scanMap\.get\(sk\)\) \|\| 'clean'\)/g) || []).length === 2,
    'both hydration paths (channel history and DMs) send them to the client',
    (server.match(/attWire\(a, \(sk && scanMap\.get\(sk\)\) \|\| 'clean'\)/g) || []).length);
  check(!/scan: \(sk && scanMap\.get\(sk\)\) \|\| 'clean' \}\);/.test(server),
    'and no hydration site still builds the old attachment shape by hand');
  check(/gifSlug: g\.slug \|\| '', gifThumb: g\.thumb \|\| '', gifMp4: g\.mp4 \|\| ''/.test(pickers),
    'the picker stamps its GIF identity on the attachment it sends');
  check(/gifSlug: a\.gif_slug \|\| ''/.test(actions),
    'a forwarded GIF keeps it (it must stay starrable in its new home)');

  console.log('\n[A4] the star is on the picture, and the menu carries the same action');
  check(/function attFavHTML\(a\)/.test(messages) && /\$\{attFavHTML\(a\)\}/.test(messages),
    'the image branch renders it');
  check(/function gifFavKeyFor\(a\)/.test(messages) && /if \(a\.gif_slug\) return a\.gif_slug;/.test(messages),
    'a picker post is keyed on its Klipy slug');
  check(/a\.kind !== 'image' \|\| a\.mime !== 'image\/gif' \|\| !\/\^https:\\\/\\\/\/\.test\(String\(a\.url \|\| ''\)\)/.test(messages)
    && /return gifUrlFavKey\(a\.url\);/.test(messages),
    'and a GIF posted before the picker stamped one is keyed on its md.gif url — but an UPLOADED .gif (no https url) never is',
    (messages.match(/return gifUrlFavKey\(a\.url\);/g) || []).length);
  check(/function gifUrlFavKey\(url\)/.test(messages) && /Math\.imul\(x, 16777619\)/.test(messages),
    'the url key is a plain deterministic hash, so two sessions derive the same one');
  check(/const hit = \(S\.gifFavs \|\| \[\]\)\.find\(\(f\) => f && \(\(!!g\.slug && f\.slug === g\.slug\) \|\| \(!!g\.gif && f\.gif === g\.gif\)\)\);/.test(pickers),
    'and every lookup matches a favorite by key OR by the gif it points at, so the two names for one GIF resolve to one row');
  check(/data-act="gif-fav"/.test(messages) && /data-gif-key="\$\{esc\(key\)\}"/.test(messages) &&
    /data-gif-url="\$\{esc\(a\.url\)\}"/.test(messages) && /data-gif-thumb=/.test(messages) && /data-gif-mp4=/.test(messages),
    'the button carries the whole favorite (key, gif, thumb, mp4) — no lookup needed');
  check(/aria-pressed="\$\{on \? 'true' : 'false'\}"/.test(messages),
    'and its pressed state, so the star is legible to a screen reader');
  check(/else if \(act === 'gif-fav'\) toggleGifFav\(chatGifFavFromBtn\(actEl\)\);/.test(pickers),
    'the shared click delegate routes it to the ONE favorites writer');
  check(/const a = \(m\.attachments \|\| \[\]\)\.find\(\(x\) => gifFavKeyFor\(x\)\);/.test(actions)
    && /Add GIF to favorites/.test(actions) && /Remove GIF from favorites/.test(actions),
    'the message menu offers the same action for a touch/keyboard path');
  const imageBranch = slice(messages, "if (a.kind === 'image') {", "if (a.kind === 'video')");
  check(imageBranch.includes('${attFavHTML(a)}') && (messages.match(/attFavHTML\(a\)/g) || []).length === 2,
    'and it rides the image branch only (never a video or a file card)',
    (messages.match(/attFavHTML\(a\)/g) || []).length);
  check(/else for \(const g of gifResults\) box\.appendChild\(gifButton\(g, gifFavMatch\(S\.gifFavs, g\.slug, g\.gif\),/.test(pickers),
    'a picker tile reads starred from either key too (starred in chat, lit in All GIFs)');

  console.log('\n[A5] the stylesheet and the boot load');
  check(/\.att-star\{[^}]*position:absolute[^}]*top:\.45rem;right:calc\(\.45rem \+ 32px \+ \.8rem\)/.test(css),
    'the star sits beside the download button in the top-right corner (a .8rem gap keeps their hit boxes apart)');
  check(/\.att-wrap:hover \.att-star,\.att-star:focus-visible\{opacity:1\}/.test(css) && /@media \(hover:none\)\{\.att-star\{opacity:\.9\}\}/.test(css),
    'revealed on hover, always visible where there is no hover');
  check(/\.att-star\.on svg\{fill:var\(--accent\);stroke:var\(--accent\)\}/.test(css) && /\.pk-star\.on svg\{fill:var\(--accent\);stroke:var\(--accent\)\}/.test(css),
    'a starred GIF reads like a starred picker tile (same accent fill)');
  check(/\.att-dl\{[^}]*border-radius:10px[^}]*background:rgba\(9,12,24,\.55\)/.test(css)
    && /\.att-dl:active\{transform:scale\(\.92\)\}/.test(css),
    'the download button is the star\'s twin — same 32px square, rounding, scrim and press');
  check(/\.vplayer \.att-dl,\.txt-head \.att-dl\{position:static;opacity:1/.test(css),
    'and the inline reuse in the audio player / text card is un-anchored from the overlay geometry (see C3)');
  check(/\.att-wrap \.att-dl::after\{[^}]*width:var\(--tap\)/.test(css),
    'only the overlay copy grows a thumb hit box (an inline one would anchor to the page)');
  check(/\.att-star::after\{[^}]*width:var\(--tap\);height:var\(--tap\)\}/.test(css),
    'its 32px face grows a 44px thumb target (a pinned control already owns the box)');
  check(/\.att-star:active\{transform:scale\(\.92\)\}/.test(css) && /\.att-star:active[^{}]*\{transform:none\}/.test(css),
    'it presses like the rest of the app, and stands still under reduced motion');
  check(/try \{ ensureGifFavs\(\); \} catch \{\}/.test(auth),
    'boot pulls the account\'s favorites, so the first paint of a chat GIF is already honest');
  check(/function ensureGifFavs\(\)/.test(pickers) && /gifFavsTried = true/.test(pickers),
    'and a failed load is not retried on every render (that would be an invisible request loop)');
  check(/let gifFavsFor = null;/.test(pickers) && /if \(S\.gifFavs !== null && gifFavsFor !== me\) \{ S\.gifFavs = null; gifFavsTried = false; \}/.test(pickers),
    'and a different account (a login on a page that never reloaded) cannot inherit the last one\'s list');
  check(/function paintChatGifStars\(\)/.test(pickers) && /paintChatGifStars\(\);\s*if \(!S\.picker\) return;/.test(pickers),
    'every favorites change repaints the chat stars in place, not by rebuilding the chat');
  check(/const CACHE = 'campfire-v\d+'/.test(sw), 'the shell cache is versioned (bumped with these frontend edits)');
}

// ---------- [B] the two writers, run for real ----------
async function writerChecks() {
  console.log('\n[B1] a chat star and a picker tile write the SAME favorite');
  const gif = {
    slug: 'sunday-al', title: 'Al Roker Shouts Sunday',
    gif: 'https://static.klipy.com/ii/d7ae/5e/90/UPvW7RGb.gif',
    thumb: 'https://static.klipy.com/ii/d7ae/5e/90/wDpY3Hvl.gif',
    mp4: 'https://static.klipy.com/ii/d7ae/5e/90/foquSkvAvV5CbRDkLsdl.mp4',
    w: 640, h: 398,
  };
  // The dataset attFavHTML puts on the button, built here from the same values
  // (section [C] proves the real markup carries exactly these).
  const btn = { dataset: {
    gifKey: gif.slug, gifUrl: gif.gif, gifThumb: gif.thumb, gifMp4: gif.mp4,
    gifTitle: gif.title,
  } };
  const calls = [];
  const api = async (p, opts = {}) => {
    calls.push({ p, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST') return JSON.parse(opts.body);
    return { ok: true };
  };
  const make = loadWriters();
  // One account each (the same account, but each surface keeps its own loaded
  // list — which is the point: neither write depends on the other's memory).
  const Sp = { gifFavs: [] }, Sc = { gifFavs: [] };
  const pickerWrite = make(Sp, api, () => {}, (m) => m, () => {});
  const chatWrite = make(Sc, api, () => {}, (m) => m, () => {});

  check(JSON.stringify(chatWrite.chatGifFavFromBtn(btn)) === JSON.stringify({
    slug: gif.slug, title: gif.title, gif: gif.gif, thumb: gif.thumb, mp4: gif.mp4,
  }), 'the star reconstructs the picker\'s own favorite object', chatWrite.chatGifFavFromBtn(btn));

  await pickerWrite.toggleGifFav(gif);
  await chatWrite.toggleGifFav(chatWrite.chatGifFavFromBtn(btn));
  const posts = calls.filter((c) => c.method === 'POST');
  check(posts.length === 2 && posts[0].p === '/api/me/gif-favorites' && posts[1].p === posts[0].p,
    'both write the one endpoint', posts.map((p) => p.p));
  check(posts.length === 2 && JSON.stringify(posts[0].body) === JSON.stringify(posts[1].body),
    'with byte-identical bodies — the same row, so the picker shows it starred',
    posts.map((p) => p.body));
  check(Sc.gifFavs.length === 1 && Sc.gifFavs[0].slug === gif.slug && Sp.gifFavs.length === 1,
    'and each surface ends up holding it once (the second write is an upsert)', { Sc: Sc.gifFavs, Sp: Sp.gifFavs });

  console.log('\n[B2] un-starring works from either surface, by slug');
  calls.length = 0;
  await chatWrite.toggleGifFav(chatWrite.chatGifFavFromBtn(btn));
  check(calls.length === 1 && calls[0].method === 'DELETE' && calls[0].p === '/api/me/gif-favorites/' + gif.slug,
    'a second tap removes it', calls);
  check(Sc.gifFavs.length === 0, 'and the list is empty again', Sc.gifFavs);

  console.log('\n[B3] the server guard is the same rule the cleaner uses');
  check(/GIF_FAV_SLUG_RE\.test\(slug\)/.test(server) && cleaner.GIF_FAV_SLUG_RE.source === /^[a-z0-9_-]{1,80}$/i.source,
    'the favorites route validates the slug with the very regex the cleaner does');
  check(/isHttpUrl\(gif\)/.test(server), 'and the gif itself must be an http(s) url (so an uploaded path can never be favorited)');

  console.log('\n[B4] a GIF posted before the picker stamped its slug still has a name');
  const old = { kind: 'image', mime: 'image/gif', url: 'https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/1a/2b/oldOne.gif', name: 'Old GIF.gif' };
  const key = favKey.gifFavKeyFor(old);
  check(/^u[a-z0-9]+$/.test(key) && key.length >= 12 && key === favKey.gifFavKeyFor({ ...old }),
    'a remote GIF with no slug is keyed on a deterministic hash of its url', key);
  check(key !== favKey.gifFavKeyFor({ ...old, url: old.url.replace('oldOne', 'other') }),
    'a different GIF gets a different key');
  check(cleaner.GIF_FAV_SLUG_RE.test(key),
    'and the key is a slug the favorites route accepts — the server never has to know how it was made', key);
  check(favKey.gifFavKeyFor({ kind: 'image', mime: 'image/gif', url: '/uploads/files/cat.gif' }) === '',
    'an UPLOADED .gif gets no key at all (the favorites route would refuse its url)');
  check(favKey.gifFavKeyFor({ kind: 'image', mime: 'image/png', url: 'https://example.com/a.png' }) === '',
    'nor does a remote picture that is not a GIF');
  check(favKey.gifFavKeyFor({ kind: 'image', mime: 'image/gif', url: old.url, gif_slug: 'sunday-al' }) === 'sunday-al',
    'a post that DOES carry the Klipy slug is keyed on that, not on its url');
  check(favKey.gifFavMatch([{ slug: key, gif: old.url }], 'sunday-al', old.url) === true &&
    favKey.gifFavMatch([{ slug: 'sunday-al', gif: old.url }], key, old.url) === true &&
    favKey.gifFavMatch([{ slug: 'sunday-al', gif: 'https://static.klipy.com/other.gif' }], key, old.url) === false,
    'and a lookup matches by key OR by the gif, so the two names for one GIF are one row');

  console.log('\n[B5] the same GIF starred from chat and then from a picker tile is ONE row');
  {
    const calls2 = [];
    const S2 = { gifFavs: [] };
    const api2 = async (p, opts = {}) => {
      calls2.push({ p, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (opts.method === 'POST') return JSON.parse(opts.body);
      return { ok: true };
    };
    const W = loadWriters()(S2, api2, () => {}, (m) => m, () => {});
    // Starred from chat before the picker knew the slug: a url-keyed row.
    await W.toggleGifFav({ slug: key, title: 'Old GIF', gif: old.url, thumb: old.url, mp4: null });
    calls2.length = 0;
    // Now the picker tile for that SAME GIF — its Klipy slug, and the same md.gif
    // url the chat post carried, which is what ties the two names together.
    await W.toggleGifFav({ ...gif, gif: old.url });
    check(calls2.length === 1 && calls2[0].method === 'DELETE' && calls2[0].p === '/api/me/gif-favorites/' + key,
      'the tile REMOVES the url-keyed row instead of adding a second one', calls2);
    check(S2.gifFavs.length === 0, 'and the account is left with neither (one GIF, one star state)', S2.gifFavs);
  }
}

// ---------- [C] the star, in a real browser ----------
const MARK_START = messages.indexOf('const DL_ICON =');
const MARK_END = messages.indexOf('// ---------- video posters:');
const markSource = messages.slice(MARK_START, MARK_END);

function pageHtml(gifAtt, favs) {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;background:#0e1420}
#host{width:420px;padding:10px}
#host *{transition:none!important}</style>
</head><body><div id="host"><div class="msg"><div class="body"><div class="text" id="text"></div></div></div></div><script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize() { return '1 KB'; }
function toast() {}
function audioPlayerHTML() { return ''; }
function textPreviewable() { return false; }
function textFileHTML() { return ''; }
const S = { gifFavs: ${JSON.stringify(favs)} };
${markSource}
const box = document.getElementById('text');
box.innerHTML = attachmentHTML(${JSON.stringify(gifAtt)});
const wrap = box.querySelector('.att-wrap');
const star = wrap.querySelector('.att-star');
const dl = wrap.querySelector('.att-dl');
const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
const cs = (el) => { if (!el) return null; const c = getComputedStyle(el); return { radius: c.borderRadius, bg: c.backgroundColor, w: c.width, h: c.height, opacity: c.opacity, position: c.position }; };
const ds = star ? Object.assign({}, star.dataset) : null;
if (ds) delete ds.act;
document.title = JSON.stringify({
  star: ds,
  on: !!(star && star.classList.contains('on')),
  pressed: star ? star.getAttribute('aria-pressed') : null,
  title: star ? star.getAttribute('title') : null,
  wrap: r(wrap), starBox: r(star), dlBox: r(dl),
  starCss: cs(star), dlCss: cs(dl),
  opacity: star ? getComputedStyle(star).opacity : null,
  imgSrc: (wrap.querySelector('img.att-img') || {}).getAttribute ? wrap.querySelector('img.att-img').getAttribute('src') : null,
});
</script></body></html>`;
}

// The audio player and the text/code card reuse the same download button INLINE
// (see the note on `.vplayer .att-dl` in styles.css), so they need the two real
// builders, which sit further down messages.js than the markup slice above.
const INLINE_END = messages.indexOf('function vpAudio(root)');
const inlineSource = messages.slice(MARK_START, INLINE_END);

function inlinePageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;background:#0e1420}
#host{width:420px;padding:10px}
#host *{transition:none!important}</style>
</head><body><div id="host"><div class="msg"><div class="body"><div class="text" id="text"></div></div></div></div><script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize() { return '1 KB'; }
function toast() {}
const S = { gifFavs: [] };
${inlineSource}
const box = document.getElementById('text');
const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
function probe(kind) {
  const att = kind === 'audio'
    ? { kind: 'audio', url: '/uploads/files/a.mp3', name: 'a.mp3', size: 1000, mime: 'audio/mpeg' }
    : { kind: 'file', url: '/uploads/files/a.md', name: 'a.md', size: 40, mime: 'text/markdown', id: 'f1' };
  const d = document.createElement('div');
  d.className = 'msg-atts';
  d.innerHTML = attachmentHTML(att);
  box.appendChild(d);
  const card = d.querySelector(kind === 'audio' ? '.vplayer' : '.txtfile');
  const dl = d.querySelector('.att-dl');
  if (!card || !dl) return { missing: true };
  const c = getComputedStyle(dl);
  return {
    opacity: c.opacity, position: c.position,
    card: r(card), dl: r(dl),
    // Inside its own card means it is in the flow of that row — not the overlay
    // box it wears over a picture, which resolved against the viewport.
    inside: r(dl).x >= r(card).x && r(dl).right <= r(card).right && r(dl).y >= r(card).y && r(dl).bottom <= r(card).bottom,
  };
}
document.title = JSON.stringify({ audio: probe('audio'), text: probe('text') });
</script></body></html>`;
}

function runChrome(chrome, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-giffav-'));
  return new Promise((resolve) => {
    const finish = (val) => { try { srv.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} resolve(val); };
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=460,900',
        '--virtual-time-budget=8000', '--dump-dom', 'http://127.0.0.1:' + port + '/'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60000);
      child.on('error', (e) => { clearTimeout(timer); finish({ err: 'chrome: ' + e.message }); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = /<title>([\s\S]*?)<\/title>/.exec(out);
        if (!m) return finish({ err: 'no title' });
        try { finish(JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))); }
        catch { finish({ err: 'bad title: ' + String(m[1]).slice(0, 200) }); }
      });
    });
  });
}

async function browserChecks(chrome, gifAtt) {
  console.log('\n[C1] the star renders on a picker GIF, and carries the whole favorite');
  const out = await runChrome(chrome, pageHtml(gifAtt, []));
  if (out.err) { check(false, 'headless Chrome rendered the real markup', out); return null; }
  check(out.star && out.star.gifKey === gifAtt.gif_slug && out.star.gifUrl === gifAtt.url &&
    out.star.gifThumb === gifAtt.gif_thumb && out.star.gifMp4 === gifAtt.gif_mp4 && out.star.gifTitle === 'Al Roker Shouts Sunday',
    'the button carries the key, gif, thumb, mp4 and the title (with the .gif suffix stripped)', out.star);
  check(out.on === false && out.pressed === 'false' && out.title === 'Add to favorites',
    'an unstarred GIF reads as unstarred', out);
  check(out.opacity === '0', 'and on a mouse device it waits for the hover (like the download button)', out.opacity);

  console.log('\n[C2] it sits beside the download button, on the picture');
  check(out.starBox && out.wrap && out.starBox.x >= out.wrap.x && out.starBox.y >= out.wrap.y &&
    out.starBox.right <= out.wrap.right && out.starBox.bottom <= out.wrap.bottom,
    'inside the picture\'s own box', { star: out.starBox, wrap: out.wrap });
  check(out.starBox && out.dlBox && out.starBox.right < out.dlBox.x && out.starBox.y === out.dlBox.y,
    'clear of the download button, and level with it', { star: out.starBox, dl: out.dlBox });
  check(out.starBox && out.dlBox && (out.dlBox.x - out.starBox.right) >= 12,
    'with enough gap that their 44px thumb boxes cannot overlap', { star: out.starBox, dl: out.dlBox });
  check(out.starBox && out.starBox.x - out.wrap.x > out.wrap.w / 2 && out.starBox.y - out.wrap.y < 12,
    'top-right, on the picture\'s top edge', { star: out.starBox, wrap: out.wrap });
  check(out.starCss && out.dlCss && out.starCss.radius === out.dlCss.radius && out.starCss.bg === out.dlCss.bg &&
    out.starCss.w === out.dlCss.w && out.starCss.h === out.dlCss.h && out.starCss.opacity === out.dlCss.opacity,
    'and the two are a matched pair — same box, rounding, scrim and reveal',
    { star: out.starCss, dl: out.dlCss });
  check(out.dlCss && out.dlCss.radius === '10px' && out.dlCss.w === '32px',
    'the download button is a rounded square, not the old circle', out.dlCss);

  console.log('\n[C3] the audio player and a text/code card keep that button INLINE');
  const inl = await runChrome(chrome, inlinePageHtml());
  check(!inl.err && inl.audio && !inl.audio.missing && inl.text && !inl.text.missing,
    'both surfaces render one', inl);
  check(!inl.err && inl.audio.position === 'static' && inl.audio.opacity === '1' &&
    inl.text.position === 'static' && inl.text.opacity === '1',
    'in the flow and visible (the overlay geometry had no .att-wrap to hover, so it sat'
    + ' invisible at opacity 0 — and on touch it lit up pinned to the viewport)',
    { audio: inl.audio, text: inl.text });
  check(!inl.err && inl.audio.inside && inl.text.inside,
    'and inside its own card, not at the corner of the page',
    { audio: inl.audio, text: inl.text });

  console.log('\n[C4] the account\'s list is what the star shows');
  const on = await runChrome(chrome, pageHtml(gifAtt, [{ slug: gifAtt.gif_slug, title: 'x', thumb: 't', gif: gifAtt.url, mp4: null }]));
  check(!on.err && on.on === true && on.pressed === 'true' && on.title === 'Remove from favorites',
    'a GIF already in the favorites paints starred', on);

  console.log('\n[C5] a GIF posted BEFORE the picker stamped its slug is still starrable');
  const oldGif = {
    kind: 'image', mime: 'image/gif', name: 'Old GIF.gif', size: 0, scan: 'clean', w: 480, h: 270,
    url: 'https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/1a/2b/oldOne.gif',
  };
  const legacy = await runChrome(chrome, pageHtml(oldGif, []));
  check(!legacy.err && !!legacy.star && /^u[a-z0-9]+$/.test(legacy.star.gifKey || '') && legacy.star.gifThumb === oldGif.url,
    'it gets a star keyed on its md.gif url (and that url is its own thumb)', legacy.star);
  const legacyOn = await runChrome(chrome, pageHtml(oldGif, [{ slug: legacy.star && legacy.star.gifKey, title: 'x', thumb: 't', gif: oldGif.url, mp4: null }]));
  check(!legacyOn.err && legacyOn.on === true, 'and the row written under that key lights it up', legacyOn);
  const legacyByUrl = await runChrome(chrome, pageHtml(oldGif, [{ slug: 'some-klipy-slug', title: 'x', thumb: 't', gif: oldGif.url, mp4: null }]));
  check(!legacyByUrl.err && legacyByUrl.on === true,
    'as does a row the PICKER wrote under the real Klipy slug — the url is what ties them together', legacyByUrl);

  console.log('\n[C6] nothing else gets a star');
  const plain = await runChrome(chrome, pageHtml({ kind: 'image', url: '/uploads/files/photo.png?v=1', name: 'photo.png', w: 800, h: 600 }, []));
  check(!plain.err && !plain.star && !!plain.wrap, 'an uploaded picture has none', plain);
  const uploadedGif = await runChrome(chrome, pageHtml({ kind: 'image', mime: 'image/gif', url: '/uploads/files/cat.gif?v=1', name: 'cat.gif', w: 320, h: 240 }, []));
  check(!uploadedGif.err && !uploadedGif.star, 'neither has an uploaded .gif (its url is not http, so a favorite could not be written)', uploadedGif);
  const remotePng = await runChrome(chrome, pageHtml({ kind: 'image', mime: 'image/png', url: 'https://example.com/a.png', name: 'a.png', w: 300, h: 200 }, []));
  check(!remotePng.err && !remotePng.star, 'and a remote picture that is not a GIF does not either', remotePng);
  return out.star;
}

// ---------- [D] the round trip, against a real server ----------
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

async function serverChecks() {
  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const api = async (method, p, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: payload });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await fn(); } catch {}
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(100);
    }
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-giffav-srv-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  let child = null, serverLog = '';
  const conns = [];
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    const env = {
      ...process.env,
      PORT: String(PORT),
      PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
      JWT_SECRET: 'test-gif-favorites',
      UPLOAD_DIR: uploads,
      UNFURL: '0',
      VIRUS_SCAN: '0', MEDIA_COMPRESS: '0', // this feature is not the upload pipeline's business
    };
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const waitHttp = async (p, ms) => {
      const t0 = Date.now();
      for (;;) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
        if (Date.now() - t0 > ms) return false;
        await sleep(250);
      }
    };
    if (!(await waitHttp('/api/config', 30000))) throw new Error('server did not come up\n' + serverLog.slice(-3000));

    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const connect = (token) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
      ws.on('error', reject);
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'subscribe' })); resolve({ send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } }); });
    });

    const A = await reg('gifa'), B = await reg('gifb');
    const srv = (await api('POST', '/api/servers', { token: A.token, body: { name: 'GIF Lab' } })).data.server;
    const chan = srv.channels.find((c) => c.type === 'text');
    const invite = (await api('POST', `/api/servers/${srv.id}/invites`, { token: A.token, body: {} })).data.invite;
    await api('POST', '/api/servers/join', { token: B.token, body: { code: invite.code } });
    await api('POST', '/api/friends', { token: A.token, body: { username: 'gifb' } });
    const dm = (await api('POST', '/api/dms', { token: A.token, body: { userId: B.data ? B.data.user.id : B.user.id } })).data.thread;

    const asock = await connect(A.token);
    const bsock = await connect(B.token);
    conns.push(asock, bsock);
    await sleep(300);

    const gifAtt = {
      url: 'https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/5e/90/UPvW7RGb.gif',
      name: 'Al Roker Shouts Sunday.gif', mime: 'image/gif', size: 0, kind: 'image',
      gifSlug: 'sunday-al',
      gifThumb: 'https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/5e/90/wDpY3Hvl.gif',
      gifMp4: 'https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/5e/90/foquSkvAvV5CbRDkLsdl.mp4',
      w: 640, h: 398,
    };
    const history = async () => {
      const r = await api('GET', `/api/servers/${srv.id}/channels/${chan.id}/messages`, { token: B.token });
      return (r.data && r.data.messages) || [];
    };

    console.log('\n[D1] the identity survives the post, for everyone who reads it after');
    asock.send({ t: 'message', serverId: srv.id, channelId: chan.id, content: '', attachments: [gifAtt] });
    const msg = await waitFor(async () => (await history()).find((m) => (m.attachments || []).length), 6000);
    check(!!msg, 'the GIF message landed', serverLog.slice(-500));
    const a0 = (msg && msg.attachments[0]) || {};
    check(a0.gif_slug === 'sunday-al' && a0.gif_thumb === gifAtt.gifThumb && a0.gif_mp4 === gifAtt.gifMp4,
      'a reader gets the Klipy slug, thumb and mp4 back', a0);
    check(a0.w === 640 && a0.h === 398, 'along with the shape the picker measured (the box is reserved before it loads)', a0);

    console.log('\n[D2] a local upload or a bogus slug never becomes favoritable');
    asock.send({
      t: 'message', serverId: srv.id, channelId: chan.id, content: '',
      attachments: [{ url: '/uploads/files/notreally.gif', name: 'cat.gif', mime: 'image/gif', size: 10, kind: 'image', gifSlug: 'sunday-al' }],
    });
    const local = await waitFor(async () => (await history()).find((m) => (m.attachments || []).some((a) => a.name === 'cat.gif')), 6000);
    check(!!local && local.attachments[0].gif_slug === undefined,
      'an UPLOADED gif keeps no identity, even when the client claims one', local && local.attachments[0]);
    asock.send({
      t: 'message', serverId: srv.id, channelId: chan.id, content: '',
      attachments: [{ ...gifAtt, url: 'https://static.klipy.com/ii/x/5e/90/bad.gif', gifSlug: '../etc/passwd' }],
    });
    const bogus = await waitFor(async () => (await history()).find((m) => (m.attachments || []).some((a) => (a.url || '').includes('/bad.gif'))), 6000);
    check(!!bogus && bogus.attachments[0].gif_slug === undefined,
      'a junk slug is dropped, not stored (no star, no favorite)', bogus && bogus.attachments[0]);

    console.log('\n[D3] the same trip through a DM');
    asock.send({ t: 'dm', threadId: dm.id, content: '', attachments: [gifAtt] });
    const dmMsg = await waitFor(async () => {
      const r = await api('GET', `/api/dms/${dm.id}/messages`, { token: B.token });
      return ((r.data && r.data.messages) || []).find((m) => (m.attachments || []).length);
    }, 6000);
    check(!!dmMsg && dmMsg.attachments[0].gif_slug === 'sunday-al',
      'a GIF shared in a DM is starrable too', dmMsg && dmMsg.attachments[0]);

    console.log('\n[D4] a star set from what the reader was handed lands in that account\'s picker');
    const make = loadWriters();
    const seen = [];
    const S = { gifFavs: [] };
    const clientApi = async (p, opts = {}) => {
      seen.push({ p, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      const r = await api(opts.method || 'GET', p, { token: A.token, body: opts.body ? JSON.parse(opts.body) : undefined });
      if (r.status !== 200) throw new Error('http ' + r.status + ' ' + JSON.stringify(r.data));
      return r.data;
    };
    const W = make(S, clientApi, () => {}, (m) => m, () => {});
    // Exactly what the star's data-* attributes carry, straight off the payload
    // the server just handed B (attFavHTML's own mapping).
    const wired = msg.attachments[0];
    await W.toggleGifFav({
      slug: wired.gif_slug,
      title: String(wired.name || '').replace(/\.gif$/i, ''),
      gif: wired.url, thumb: wired.gif_thumb, mp4: wired.gif_mp4,
    });
    const post = seen.find((c) => c.method === 'POST');
    check(!!post && post.body.slug === 'sunday-al' && post.body.gif === gifAtt.url &&
      post.body.thumb === gifAtt.gifThumb && post.body.mp4 === gifAtt.gifMp4,
      'the favorite written from a chat GIF uses the identity the server stored', post && post.body);

    const mine = await api('GET', '/api/me/gif-favorites', { token: A.token });
    const theirs = await api('GET', '/api/me/gif-favorites', { token: B.token });
    check(mine.data.favorites.length === 1 && mine.data.favorites[0].slug === 'sunday-al',
      'and it is in the account\'s favorites — the very list the picker renders', mine.data.favorites);
    check(theirs.data.favorites.length === 0, 'favorites are per account, never shared', theirs.data.favorites);

    // Idempotent upsert: the same GIF from the picker (a full tile payload) must
    // not mint a second row.
    const again = await api('POST', '/api/me/gif-favorites', {
      token: A.token,
      body: { slug: 'sunday-al', title: 'Al Roker Shouts Sunday', thumb: gifAtt.gifThumb, gif: gifAtt.url, mp4: gifAtt.gifMp4 },
    });
    const after = await api('GET', '/api/me/gif-favorites', { token: A.token });
    check(again.status === 200 && after.data.favorites.length === 1,
      'starring the same GIF again (this time from the picker) updates the one row', after.data.favorites.length);

    console.log('\n[D5] the routes are guarded');
    const badSlug = await api('POST', '/api/me/gif-favorites', { token: A.token, body: { slug: 'nope/../x', gif: gifAtt.url } });
    check(badSlug.status === 400, 'a junk slug is refused', badSlug.status);
    const badUrl = await api('POST', '/api/me/gif-favorites', { token: A.token, body: { slug: 'sunday-al', gif: '/uploads/files/notreally.gif' } });
    check(badUrl.status === 400, 'and a non-http gif url is refused (an uploaded path can never be a favorite)', badUrl.status);
    const noAuth = await api('GET', '/api/me/gif-favorites', {});
    check(noAuth.status === 401, 'the list needs auth', noAuth.status);
    const del = await api('DELETE', '/api/me/gif-favorites/sunday-al', { token: A.token });
    const gone = await api('GET', '/api/me/gif-favorites', { token: A.token });
    check(del.status === 200 && gone.data.favorites.length === 0, 'un-starring removes exactly that row', gone.data.favorites);

    console.log('\n[D6] a GIF posted long before this feature is starrable anyway');
    // The owner's own case: two Klipy GIFs sat in the database from before the
    // picker stamped any identity, so there is no slug, thumb or mp4 on the row —
    // only the md.gif url the picker posted. That url is the identity.
    const legacyUrl = 'https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/1a/2b/legacyOne.gif';
    asock.send({
      t: 'message', serverId: srv.id, channelId: chan.id, content: '',
      attachments: [{ url: legacyUrl, name: 'Old GIF.gif', mime: 'image/gif', size: 0, kind: 'image' }],
    });
    const legacyMsg = await waitFor(async () => (await history()).find((m) => (m.attachments || []).some((a) => a.url === legacyUrl)), 6000);
    const legacyAtt = legacyMsg && legacyMsg.attachments[0];
    check(!!legacyAtt && legacyAtt.gif_slug === undefined,
      'the row has no Klipy identity at all (exactly the pre-deploy GIF)', legacyAtt);
    const legacyKey = legacyAtt ? favKey.gifFavKeyFor(legacyAtt) : '';
    check(/^u[a-z0-9]+$/.test(legacyKey), 'the client derives one from the url it was posted with', legacyKey);
    const seen2 = [];
    const S2 = { gifFavs: [] };
    const W2 = loadWriters()(S2, async (p, opts = {}) => {
      const r = await api(opts.method || 'GET', p, { token: A.token, body: opts.body ? JSON.parse(opts.body) : undefined });
      if (r.status !== 200) throw new Error('http ' + r.status + ' ' + JSON.stringify(r.data));
      seen2.push({ p, body: opts.body ? JSON.parse(opts.body) : null });
      return r.data;
    }, () => {}, (m) => m, () => {});
    await W2.toggleGifFav({ slug: legacyKey, title: 'Old GIF', gif: legacyAtt.url, thumb: legacyAtt.url, mp4: null });
    const legacyList = await api('GET', '/api/me/gif-favorites', { token: A.token });
    check(seen2.length === 1 && legacyList.data.favorites.length === 1 && legacyList.data.favorites[0].slug === legacyKey,
      'and the server takes it: the old GIF is in the picker\'s favorites now', { post: seen2[0], list: legacyList.data.favorites });
    const stream = await api('GET', `/api/servers/${srv.id}/channels/${chan.id}/messages`, { token: B.token });
    check(!!(stream.data.messages || []).find((m) => (m.attachments || []).some((a) => a.url === legacyUrl)),
      'nothing about the post itself had to change for that to work');
  } catch (e) {
    check(false, 'the live round trip ran', ((e && e.message) || String(e)).slice(0, 600));
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  wiringChecks();
  await writerChecks();

  const chrome = findChrome();
  let starDataset = null;
  if (!chrome) skip('no Chrome/Edge on PATH — the markup half (C) did not run');
  else {
    const gifAtt = {
      kind: 'image', name: 'Al Roker Shouts Sunday.gif', size: 0, scan: 'clean',
      url: 'https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/5e/90/UPvW7RGb.gif',
      gif_slug: 'sunday-al',
      gif_thumb: 'https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/5e/90/wDpY3Hvl.gif',
      gif_mp4: 'https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/5e/90/foquSkvAvV5CbRDkLsdl.mp4',
      w: 640, h: 398,
    };
    starDataset = await browserChecks(chrome, gifAtt);
  }

  await serverChecks();

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
