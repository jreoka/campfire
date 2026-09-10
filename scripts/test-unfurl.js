/* Campfire link-unfurl tests (unfurl.js).
 *
 * Offline by default — metadata parsing, the SSRF guard and image sniffing are
 * pure functions, so `node scripts/test-unfurl.js` is safe to run anywhere.
 * Add --live to also fetch a few real pages (HuggingFace, GitHub, Wikipedia)
 * and assert the card comes back sane. --live also proves the redirect guard:
 * httpbin.org hands back a 302 to 169.254.169.254 and we must refuse it.
 *
 *   node scripts/test-unfurl.js
 *   node scripts/test-unfurl.js --live
 */
'use strict';

const path = require('path');
const dns = require('dns');
const unfurl = require(path.join(__dirname, '..', 'unfurl.js'));
const { ipIsBlocked, parseHtml, parseTarget, sniffImage, unfurlUrl, safeRequest, tidy } = unfurl._internals;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.error('FAIL: ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
}
function eq(actual, expected, label) {
  ok(actual === expected, label, { actual, expected });
}

// ---------- SSRF guard ----------
const blocked = ['127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '198.18.0.1', '203.0.113.9', '224.0.0.1', '255.255.255.255',
  '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:0001',
  '::ffff:10.0.0.1', '2001:db8::1', '64:ff9b::7f00:1'];
const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80e::200e'];
for (const ip of blocked) ok(ipIsBlocked(ip === '::ffff:7f00:0001' ? ip : ip) === true, 'blocks ' + ip);
for (const ip of allowed) ok(ipIsBlocked(ip) === false, 'allows ' + ip);

// URL shape: only http(s), no credentials, length-capped, no junk schemes.
ok(parseTarget('https://huggingface.co/openai/gpt-oss-20b') !== null, 'accepts https url');
ok(parseTarget('http://example.com/a?b=c#d') !== null, 'accepts http url with query/hash');
eq(parseTarget('ftp://example.com/'), null, 'rejects ftp');
eq(parseTarget('file:///etc/passwd'), null, 'rejects file://');
eq(parseTarget('javascript:alert(1)'), null, 'rejects javascript:');
eq(parseTarget('data:text/html,hi'), null, 'rejects data:');
eq(parseTarget('http://user:pw@example.com/'), null, 'rejects credentials in url');
eq(parseTarget('https://example.com/' + 'a'.repeat(2000)), null, 'rejects over-long url');
eq(parseTarget(''), null, 'rejects empty url');

// ---------- metadata parsing ----------
const HF = `<html><head><title>openai/gpt-oss-20b</title>
<meta name="twitter:card" content="summary_large_image" />
<meta property="og:title" content="openai/gpt-oss-20b &middot; Hugging Face" />
<meta property="og:description" content="We&rsquo;re on a journey &amp; so on" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://huggingface.co/openai/gpt-oss-20b" />
<meta property="og:image" content="/social-thumbnails/models/openai/gpt-oss-20b.png" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<link rel="icon" sizes="32x32" href="favicon-32.png" />
<link rel="alternate" type="application/json+oembed" href="/api/oembed?url=x" />
</head><body></body></html>`;
{
  const p = parseHtml(HF, 'https://huggingface.co/openai/gpt-oss-20b');
  eq(p.title, 'openai/gpt-oss-20b \u00b7 Hugging Face', 'og:title decoded');
  eq(p.description, 'We\u2019re on a journey & so on', 'og:description entities decoded');
  eq(p.image, 'https://huggingface.co/social-thumbnails/models/openai/gpt-oss-20b.png', 'relative og:image resolved');
  eq(p.imageW, 1200, 'og:image:width');
  eq(p.imageH, 630, 'og:image:height');
  eq(p.icon, 'https://huggingface.co/openai/favicon-32.png', 'relative favicon resolved against the page url');
  eq(p.oembed, 'https://huggingface.co/api/oembed?url=x', 'oEmbed discovery link resolved');
}
{
  // twitter card + <title> fallback + entities in title, plus a <base href>
  const html = '<html><head><base href="https://cdn.example.com/x/"><title>Plain &amp; Simple</title>'
    + '<meta name="twitter:title" content="From Twitter">'
    + '<meta name="description" content="  spaced   description  ">'
    + '<meta name="twitter:image" content="pic.jpg"></head></html>';
  const p = parseHtml(html, 'https://example.com/page');
  eq(p.title, 'From Twitter', 'twitter:title wins over <title>');
  eq(p.description, 'spaced description', 'name=description collapsed');
  eq(p.image, 'https://cdn.example.com/x/pic.jpg', 'image resolved against <base>');
}
{
  const html = '<html><head><title>Just a moment...</title></head></html>';
  const p = parseHtml(html, 'https://example.com/');
  ok(/Just a moment/.test(p.title), 'cloudflare wall is parsed as a title (filtered later)');
}
{
  // property/name variants and single-quoted attributes
  const html = "<meta name='og:title' content='single quoted'><meta itemprop='description' content='itemprop desc'>";
  const p = parseHtml(html, 'https://example.com/');
  eq(p.title, 'single quoted', 'single-quoted meta attributes');
  eq(p.description, 'itemprop desc', 'itemprop description');
}
eq(tidy('<b>hi</b>   there', 100), 'hi there', 'tidy strips tags + collapses space');
eq(tidy('x'.repeat(20), 10), 'xxxxxxxxx\u2026', 'tidy truncates with ellipsis');

// ---------- image sniffing (never spoofable by Content-Type) ----------
const bytes = (...b) => Buffer.from(b);
ok(sniffImage(Buffer.concat([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(8)])) === 'image/png', 'sniffs png');
ok(sniffImage(Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(12)])) === 'image/jpeg', 'sniffs jpeg');
ok(sniffImage(Buffer.from('GIF89a' + '\u0000'.repeat(10))) === 'image/gif', 'sniffs gif');
ok(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')) === 'image/webp', 'sniffs webp');
ok(sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(4)])) === 'image/avif', 'sniffs avif');
ok(sniffImage(Buffer.from('<!doctype html><html>')) === '', 'refuses html');
ok(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')) === '', 'refuses svg');

// ---------- signature gate ----------
{
  const url = 'https://cdn.example.com/a.png';
  const sig = unfurl.sign(url);
  ok(unfurl.verifySig(url, sig), 'accepts its own signature');
  ok(!unfurl.verifySig(url, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')), 'rejects a tampered signature');
  ok(!unfurl.verifySig('https://evil.example.com/a.png', sig), 'rejects a signature for another url');
  ok(!unfurl.verifySig(url, ''), 'rejects a missing signature');
  eq(unfurl.proxyPath(url), '/api/unfurl/img?u=' + encodeURIComponent(url) + '&s=' + sig, 'proxyPath is signed');
  eq(unfurl.proxyPath('ftp://x/y.png'), '', 'proxyPath ignores non-http urls');
}
{
  const pub = unfurl.publicEmbed({ url: 'https://x.example/a', host: 'x.example', site: 'X', title: 'T', description: 'D', image: 'https://x.example/i.png', imageW: 10, imageH: 5, icon: '', type: 'website' });
  ok(pub.image.startsWith('/api/unfurl/img?u=https%3A%2F%2Fx.example%2Fi.png&s='), 'publicEmbed signs the image');
  eq(pub.icon, '', 'publicEmbed leaves a missing icon alone');
  eq(unfurl.publicEmbed(null), null, 'publicEmbed(null) is null');
}

// ---------- live (network) ----------
async function live() {
  console.log('\n-- live fetches');
  for (const url of ['https://huggingface.co/openai/gpt-oss-20b', 'https://github.com/jreoka/campfire', 'https://en.wikipedia.org/wiki/Open_graph']) {
    const t0 = Date.now();
    const r = await unfurlUrl(url);
    ok(!!r && !!r.title, 'unfurled ' + url + ' (' + (Date.now() - t0) + 'ms)', r);
    if (r) console.log('   ', r.site, '|', r.title, '|', r.image ? 'image' : 'no image');
  }
  // A 302 to a link-local address must be refused *after* the first hop.
  try {
    await safeRequest('https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2F', { maxBytes: 2048 });
    ok(false, 'redirect to 169.254.169.254 was refused');
  } catch (e) {
    ok(/blocked_ip|blocked_host|dns_failed|timeout|ECONN|socket/.test(e.message), 'redirect to 169.254.169.254 refused (' + e.message + ')');
  }
  // DNS answering with a private address is refused even for a public name.
  const real = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  try {
    await safeRequest('https://example.com/', { maxBytes: 2048 });
    ok(false, 'private DNS answer refused');
  } catch (e) {
    ok(e.message === 'blocked_ip', 'private DNS answer refused (' + e.message + ')');
  }
  dns.promises.lookup = real;
}

(async () => {
  if (process.argv.includes('--live')) {
    try { await live(); } catch (e) { fail++; console.error('FAIL: live run threw:', e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
