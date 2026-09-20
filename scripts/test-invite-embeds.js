// Server invite cards: the Discord-style invitation a Campfire invite link
// becomes inside a chat or DM.
//
// What this pins, and why each one is easy to get wrong:
//
//   - DETECTION. The link has to be recognised as an INVITE (the /invite/CODE
//     landing page this app serves) and nothing else — a lookalike path, a
//     credentialed URL or a junk code must not be turned into an invitation.
//   - the ONE behaviour that matters: the card never joins anybody. Someone
//     already in the server gets an "Open server" button (a click switches to
//     it); someone who is not gets "Join server" pointing at the landing page,
//     where the join is still accepted by hand. A paste in chat must not put a
//     reader into a server.
//   - the STATES. A revoked or expired link says so instead of pretending to be
//     an invitation, and a fetch that merely failed says nothing rather than
//     calling a live invite dead.
//   - the SURFACES. Chat and DMs call linkEmbedsHTML and get the card; a story
//     deliberately does not (the story surfaces are pinned separately). The
//     invite goes FIRST in a message, and it does not eat the card budget.
//
// It loads the REAL public/embeds.js in node with a tiny DOM/fetch stub, so the
// card's markup, states and fetch contract are the shipped ones. Usage:
//   node scripts/test-invite-embeds.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EMBEDS = fs.readFileSync(path.join(ROOT, 'public', 'embeds.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ui.js'), 'utf8');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function section(t) { console.log('\n' + t); }

// ---------- the module's runtime environment ----------
// embeds.js is a browser classic script: it wants a document and a location at
// load time. Only what it actually touches is stubbed (it bails out of
// installLinkCards when there is no body).
const HOST = 'chat.example.com';
const OTHER = 'other.example.net';
const DOC = { body: null, addEventListener() {} };
const LOC = { host: HOST, hostname: HOST, origin: 'https://' + HOST, assign() {} };
let fetchCalls = [];
let fetchImpl = async () => { throw new Error('no fetch stub installed'); };
global.document = DOC;
global.location = LOC;
global.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
global.fetch = (u, o) => { fetchCalls.push({ url: String(u), opts: o || {} }); return fetchImpl(u, o); };

const E = require(path.join(ROOT, 'public', 'embeds.js'));
const cache = E.__inviteCache;

const OWN = 'https://' + HOST + '/invite/aB3xK9qZ';
const SELF = E.inviteFromUrl(OWN);

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
// Fill one card end to end through the real fillInvite path.
async function render(url) {
  const html = E.inviteCardHTML(url);
  // inviteCardHTML put the url in data-invite; mimic the DOM the message builds
  // (the element arrives holding the stub, which is what fillInvite repaints).
  const m = /data-invite="([^"]*)"/.exec(html);
  const el = {
    dataset: { invite: m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&') : '' },
    innerHTML: html, classList: { toggle() {} }, isConnected: true,
  };
  await E.fillInvite(el);
  return el.innerHTML;
}
function reset() {
  cache.clear();
  fetchCalls = [];
}

async function main() {
  section('[1] only an invite landing page is an invite');
  {
    check(!!E.inviteFromUrl(OWN) && E.inviteFromUrl(OWN).code === 'aB3xK9qZ', 'our own /invite/CODE', E.inviteFromUrl(OWN));
    const other = E.inviteFromUrl('https://' + OTHER + '/invite/xyz');
    check(!!other && other.self === false, 'another host\'s /invite/CODE is recognised, but not as ours', other);
    check(!!E.inviteFromUrl(OWN + '/') && !!E.inviteFromUrl(OWN + '?utm=1'), 'a trailing slash or a query still resolves', null);
    check(E.inviteFromUrl('https://evil.example.net/totally/not/invite') === null, 'an unrelated link is not an invite', null);
    check(E.inviteFromUrl('https://evil.example.net/invite/') === null, 'a bare /invite/ with no code is not one', null);
    check(E.inviteFromUrl('https://evil.example.net/invite/a/b/../c') === null, 'a deeper path is not the landing page', null);
    check(E.inviteFromUrl('https://user:pw@' + HOST + '/invite/xyz') === null, 'a credentialed URL is refused outright', null);
    check(E.inviteFromUrl('ftp://' + HOST + '/invite/xyz') === null, 'and a non-http scheme with it', null);
    check(E.inviteFromUrl('not a url at all') === null, 'garbage returns nothing rather than throwing', null);
  }

  section('[2] a card is an invitation, and it never joins anybody');
  {
    reset();
    fetchImpl = async () => jsonRes(200, { serverId: 'srv1', joined: false, name: 'Game Night', description: 'Friday crew', icon_url: 'https://cdn.example/i.png', memberCount: 42 });
    const html = await render(OWN);
    check(!/Join server/.test(html) === false && /Join server/.test(html), 'someone who is NOT in the server is offered Join server', null);
    check(/href="https:\/\/chat\.example\.com\/invite\/aB3xK9qZ"/.test(html), 'and the button points at the invite landing page — not at the join API', null);
    check(!/data-invite-join/.test(html), 'a non-member gets no in-place join hook at all', null);
    check(!/\/api\/servers\/join/.test(html), 'nothing in the card can join silently', null);
    check(/Game Night/.test(html) && /42 members/.test(html) && /Friday crew/.test(html), 'the server\u2019s name, live member count and description are on it', null);
    check(/class="iv-icon"/.test(html) && /cdn\.example\/i\.png/.test(html), 'with its icon', null);
    check(fetchCalls.length === 1 && fetchCalls[0].url === '/api/invite/aB3xK9qZ', 'resolved from this app\u2019s own invite API (no unfurl)', fetchCalls);
  }
  {
    reset();
    fetchImpl = async () => jsonRes(200, { serverId: 'srv1', joined: true, name: 'Game Night', memberCount: 42 });
    const html = await render(OWN);
    check(/Open server/.test(html) && !/Join server/.test(html), 'someone already in the server is offered Open server', null);
    check(/data-invite-join="srv1"/.test(html), 'and that button carries the server id the click handler switches to', null);
    check(/href="https:\/\/chat\.example\.com\/invite\/aB3xK9qZ"/.test(html), 'while still keeping the landing URL as its fallback', null);
  }
  {
    reset();
    fetchImpl = async () => jsonRes(200, { serverId: 'srv9', joined: true, name: 'Elsewhere' });
    const html = await render('https://' + OTHER + '/invite/xyz');
    check(!/data-invite-join/.test(html), 'a foreign instance\u2019s invite never claims to be a server we are in', null);
    check(/target="_blank"/.test(html) && /noopener/.test(html), 'and it opens out of app, safely', null);
    const opts = fetchCalls[0].opts;
    check(opts.credentials === 'omit' && (!opts.headers || !opts.headers.Authorization), 'the foreign request carries no token', opts);
  }
  {
    reset();
    global.store = { token: 'tok123' };
    fetchImpl = async () => jsonRes(200, { serverId: 'srv1', joined: true, name: 'Game Night' });
    await render(OWN);
    check(fetchCalls[0].opts.headers && fetchCalls[0].opts.headers.Authorization === 'Bearer tok123',
      'our own invite asks with the session token, which is what answers "already in?"', fetchCalls[0].opts.headers);
    delete global.store;
  }

  section('[3] dead links say so; a failed fetch does not');
  {
    reset();
    fetchImpl = async () => jsonRes(404, { error: 'bad_invite' });
    const html = await render(OWN);
    check(/Invite unavailable/.test(html) && /no longer valid/.test(html), 'a revoked link reads as unavailable', null);
    check(!/Join server|Open server/.test(html), 'and offers no button', null);

    reset();
    fetchImpl = async () => jsonRes(410, { error: 'invite_expired' });
    check(/expired/.test(await render(OWN)), 'an expired link says the invite expired', null);

    reset();
    fetchImpl = async () => jsonRes(410, { error: 'invite_exhausted' });
    check(/use limit/.test(await render(OWN)), 'an exhausted link says its uses are gone', null);

    // A card rendered before any answer arrives, then a 500: the stub must stay
    // a stub — "unavailable" would be a lie about a link nobody judged.
    reset();
    const fresh = E.inviteCardHTML(OWN);
    check(/Campfire invite/.test(fresh) && /Checking link/.test(fresh), 'the first paint is a neutral "checking" stub', null);
    fetchImpl = async () => jsonRes(500, {});
    const after = await render(OWN);
    check(/Checking link/.test(after) && !/unavailable/.test(after), 'a 500 leaves the stub alone rather than calling the invite dead', after);

    reset();
    fetchImpl = async () => { throw new Error('offline'); };
    const dead = await render(OWN);
    check(/Checking link/.test(dead) && !/unavailable/.test(dead), 'and so does a request that never landed', dead);
  }

  section('[4] untrusted text is escaped, never markup');
  {
    reset();
    fetchImpl = async () => jsonRes(200, {
      serverId: 'srv1', joined: false, memberCount: 3,
      name: '<img src=x onerror=alert(1)>', description: '</span><script>alert(2)</script>',
      icon_url: 'https://cdn.example/i.png" onload="alert(3)',
    });
    const html = await render(OWN);
    check(!/<img src=x/.test(html) && !/<script>/.test(html), 'a server name and description cannot inject markup', html.slice(0, 400));
    check(!/" onload="/.test(html), 'nor can the icon URL break out of its attribute', null);
  }

  section('[5] where the card goes');
  {
    reset();
    fetchImpl = async () => jsonRes(200, { serverId: 'srv1', joined: true, name: 'Game Night', memberCount: 5 });
    const msg = 'join us ' + OWN + ' then watch https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg and https://example.com/article';
    const html = E.linkEmbedsHTML(msg);
    const inviteAt = html.indexOf('embed-invite');
    const cardAt = html.indexOf('embed-link');
    check(inviteAt > -1, 'a message carrying an invite renders the invite card', null);
    check(cardAt === -1 || inviteAt < cardAt, 'the invitation comes before the link cards', { inviteAt, cardAt });
    check((html.match(/embed-invite/g) || []).length === 1, 'exactly one card for one link', null);
    check(!/embed-link[^>]*data-unfurl="[^"]*invite/.test(html), 'the invite is NOT also given a generic unfurl card', null);

    const twice = E.linkEmbedsHTML(OWN + ' and ' + OWN);
    check((twice.match(/embed-invite/g) || []).length === 1, 'the same link twice still paints one card', null);

    const withPlayers = 'https://youtu.be/dQw4w9WgXcQ https://youtu.be/aB3xK9qZx https://youtu.be/zzzzzzzzzz https://youtu.be/qqqqqqqqqq ' + OWN;
    const capped = E.linkEmbedsHTML(withPlayers);
    check((capped.match(/embed-invite/g) || []).length === 1, 'the invite survives a message already full of players', null);
  }
  {
    const story = E.storyLinkEmbedsHTML('come hang ' + OWN);
    check(!/embed-invite/.test(story), 'a story keeps an invite as a plain link (no join CTA over the picture)', story);
    check(E.storyTextHTML(OWN).indexOf('embed-invite') === -1, 'and a story sticker never becomes an invite card', null);
  }
  {
    // The URL leaves the sentence when the card replaces it — that is the whole
    // point of an embed — and the words around it keep their place.
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'messages.js'), 'utf8');
    check(/linkEmbedsHTML\(m\.content\)/.test(src), 'chat and DMs both render embeds off the message content', null);
  }

  section('[6] the wiring that makes it work');
  {
    check(/app\.get\('\/invite\/:code'/.test(SERVER), 'the server serves an /invite/:code landing route', null);
    const shellAt = SERVER.indexOf("app.get(['/', '/index.html']");
    const invAt = SERVER.indexOf("app.get('/invite/:code'");
    const staticAt = SERVER.indexOf('express.static');
    check(shellAt > -1 && invAt > shellAt && invAt < staticAt,
      'the invite route sits before the static handler (so it is never served as a bare file)', { shellAt, invAt, staticAt });
    check(/function shellMetaTags/.test(SERVER) && /og:image/.test(SERVER) && /twitter:card/.test(SERVER),
      'the shell injects OpenGraph/Twitter tags per request', null);
    check(/resolveInvite\(code\)/.test(SERVER.slice(invAt, invAt + 1400)), 'and they describe the invite\u2019s actual server', null);
    check(/app\.get\('\/api\/invite\/:code', optionalAuth/.test(SERVER), 'the invite API takes an optional session (it answers "already in?")', null);
    check(/let joined = false;/.test(SERVER) && /joined = await isMember\(/.test(SERVER), 'and reports membership without requiring a login', null);
    check(/serverId: s\.id, joined,/.test(SERVER), 'the payload carries the server id and the membership answer', null);
    check(/document\.title = nm \+ ' · Campfire'/.test(UI), 'the landing names the server in the tab (and repaints og:image)', null);
    check(/\.embed-invite\{/.test(CSS) && /\.embed-invite \.iv-icon\{/.test(CSS) && /\.embed-invite \.emb-go\{/.test(CSS),
      'the stylesheet carries the card, its icon and its button', null);
    check(/data-invite-join/.test(EMBEDS) && /inviteCardClick/.test(EMBEDS), 'the card\u2019s Open-server click is delegated', null);
    check(!/\.server-icon/.test(CSS), 'no leftover span class from an earlier cut', null);
    // The shell has its own generic hand-written description; a page carrying a
    // preview of its own must not end up with two of them.
    const sendAt = SERVER.indexOf('function sendShell(');
    check(/replace\(\/<meta name="description"\[\^>\]\*>\\s\*\/, ''\)/.test(SERVER.slice(sendAt, sendAt + 900)),
      'the generic description is dropped when a page brings its own preview', null);
  }

  section('[7] the tags another app reads when the link is pasted elsewhere');
  {
    // shellMetaTags is sliced out of server.js and run on its own: it is the one
    // piece of the preview a browser cannot show us (Discord/iMessage read it
    // off the wire), and it builds HTML out of user content, so escaping is the
    // thing to prove.
    const a = SERVER.indexOf('function shellMetaTags(og)');
    const b = SERVER.indexOf('// Shared shell send:');
    check(a > -1 && b > a, 'the tag builder is present and sliceable', { a, b });
    const src = SERVER.slice(a, b)
      .replace(/^function shellMetaTags/, 'var shellMetaTags = function shellMetaTags');
    // eslint-disable-next-line no-new-func
    const shellMetaTags = new Function(src + '; return shellMetaTags;')();

    const tags = shellMetaTags({
      title: 'Game Night on Campfire', description: 'Friday crew — 42 members',
      image: '/icons/icon-512.png', imageAlt: 'Game Night',
      url: 'https://chat.example.com/invite/aB3xK9qZ', base: 'https://chat.example.com', site: 'Campfire',
    });
    check(/property="og:title" content="Game Night on Campfire"/.test(tags), 'og:title carries the server', tags);
    check(/property="og:description" content="Friday crew — 42 members"/.test(tags), 'og:description carries the description and count', null);
    check(/property="og:image" content="https:\/\/chat\.example\.com\/icons\/icon-512\.png"/.test(tags),
      'a relative icon is made absolute (no app is going to resolve it for us)', tags);
    check(/property="og:url" content="https:\/\/chat\.example\.com\/invite\/aB3xK9qZ"/.test(tags), 'og:url is the invite itself', null);
    check(/name="twitter:card" content="summary_large_image"/.test(tags), 'with a card kind that matches having an image', null);
    check(/og:image:alt/.test(tags), 'and alt text for the image', null);
    check(shellMetaTags({ title: 'x' }).indexOf('og:image') === -1
      && /twitter:card" content="summary"/.test(shellMetaTags({ title: 'x' })),
      'no image means a plain summary card and no og:image at all', shellMetaTags({ title: 'x' }));
    check(shellMetaTags(null) === '', 'no metadata at all is nothing, not an empty tag set', null);

    const evil = shellMetaTags({ title: '"><script>alert(1)</script>', description: "it's <b>bold</b>", base: '', image: '' });
    check(!/<script>/.test(evil) && !/content=""><script>/.test(evil), 'a server name cannot break out of its attribute', evil);
    check(/&lt;b&gt;/.test(evil) && /&quot;&gt;/.test(evil), 'tags and quotes in the description are escaped', evil);
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
