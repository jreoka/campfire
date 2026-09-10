/* Campfire link unfurling — server-side previews for arbitrary links.
 *
 * The client (public/embeds.js) renders the sites it knows how to embed
 * (YouTube, Spotify, X, ...). Everything else — HuggingFace model pages,
 * news articles, docs, blog posts — lands here: fetch the page, read its
 * OpenGraph / Twitter-card / oEmbed metadata and return a small card
 * (site, title, description, thumbnail) the client paints under the link.
 *
 * Security notes (this is a URL fetcher driven by user input, so treat it
 * like one):
 * - Only http/https, no credentials in the URL, length-capped.
 * - The host is resolved first and every resolved address is checked against
 *   private / loopback / link-local / CGNAT / multicast ranges. The request
 *   then connects to that validated address (pinned `lookup`), so a DNS
 *   rebinding answer can't swap in an internal IP after the check.
 * - Redirects are followed manually (max 4) and re-validated at every hop.
 * - Responses are size- and time-capped and streamed into memory only.
 * - Thumbnails are re-served from /api/unfurl/img behind an HMAC signature
 *   (never trust the remote Content-Type) — only real image bytes, sniffed
 *   from magic numbers, are ever served from our origin. SVG is refused.
 *
 * Everything is cached in Postgres (`link_embeds`) so a link is fetched once
 * per deploy generation, not once per viewer.
 */
'use strict';

const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const db = require('./db');

// ---------- configuration ----------
const ENABLED = String(process.env.UNFURL === undefined ? '1' : process.env.UNFURL) !== '0';
const TIMEOUT_MS = intEnv('UNFURL_TIMEOUT_MS', 8000);
const MAX_HTML = intEnv('UNFURL_MAX_HTML', 512 * 1024);
const MAX_JSON = 128 * 1024;
const MAX_IMAGE = intEnv('UNFURL_MAX_IMAGE', 8 * 1024 * 1024);
const MAX_URL = 1500;
const MAX_REDIRECTS = 4;
const OK_TTL = 7 * 864e5;      // a good preview lives a week
const FAIL_TTL = 30 * 60e3;    // a dead link isn't retried for half an hour
const KEEP_MS = 60 * 864e5;    // cache rows older than this are pruned
const CONCURRENCY = intEnv('UNFURL_CONCURRENCY', 4);

const UA = process.env.UNFURL_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function intEnv(name, def) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Signatures are keyed off the app secret; rotating JWT_SECRET just invalidates
// previously handed-out thumbnail URLs (they're re-minted from the cache).
const SIGN_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ---------- SSRF guard ----------
// Names that never mean "the public internet".
const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|.*\.onion|metadata\.google\.internal)$/i;

function ipIsBlocked(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;              // this-net, private, loopback
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;              // CGNAT
    if (p[0] === 169 && p[1] === 254) return true;                          // link-local (cloud metadata)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;              // private
    if (p[0] === 192 && p[1] === 168) return true;                          // private
    if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true;
    if (p[0] === 192 && p[1] === 88 && p[2] === 99) return true;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;          // benchmarking
    if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true;
    if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;
    if (p[0] >= 224) return true;                                          // multicast + reserved/broadcast
    return false;
  }
  const v = String(ip).toLowerCase().split('%')[0];
  if (v === '::' || v === '::1') return true;
  if (/^f[cd]/.test(v)) return true;        // fc00::/7 unique-local
  if (/^fe[89ab]/.test(v)) return true;     // fe80::/10 link-local
  if (/^ff/.test(v)) return true;           // multicast
  if (v.startsWith('2001:db8') || v.startsWith('2001:0:') || v.startsWith('64:ff9b:') || v.startsWith('100::')) return true;
  const mapped = v.match(/^::ffff:(.+)$/);
  if (mapped) {
    const t = mapped[1];
    if (t.includes('.')) return ipIsBlocked(t);
    const g = t.split(':');
    if (g.length === 2) {
      const n = parseInt(g[0], 16) * 65536 + parseInt(g[1], 16);
      return ipIsBlocked([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return true; // malformed v4-mapped form: refuse
  }
  return false;
}

// Resolve once, vet every answer, hand back the vetted addresses. The caller
// pins these into the socket so the request can't be re-pointed afterwards.
async function resolvePublic(hostname) {
  if (BLOCKED_HOSTS.test(hostname)) throw new Error('blocked_host');
  let addrs;
  try {
    addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('dns_failed');
  }
  if (!addrs || !addrs.length) throw new Error('dns_failed');
  for (const a of addrs) if (ipIsBlocked(a.address)) throw new Error('blocked_ip');
  // IPv4 first: some hosts advertise broken IPv6, and we're connecting to one IP.
  return addrs.slice().sort((a, b) => a.family - b.family);
}

function pinnedLookup(addrs) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    const opts = options || {};
    const want = Number(opts.family) || 0;
    const pool = want ? addrs.filter((a) => a.family === want) : addrs;
    const list = pool.length ? pool : addrs;
    if (opts.all) return cb(null, list.map((a) => ({ address: a.address, family: a.family })));
    const pick = list[0];
    return cb(null, pick.address, pick.family);
  };
}

// ---------- HTTP (manual redirects, capped body, pinned IP) ----------
function once(target, addrs, { headers, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...headers,
      },
      lookup: pinnedLookup(addrs),
    }, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) {
          truncated = true;
          chunks.push(c.slice(0, Math.max(0, maxBytes - (size - c.length))));
          res.destroy();
          finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated });
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated }));
      res.on('error', (e) => finish(reject, e));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

async function safeRequest(rawUrl, { headers = {}, maxBytes = MAX_HTML } = {}) {
  let current = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('blocked_scheme');
    const addrs = await resolvePublic(current.hostname);
    const res = await once(current, addrs, { headers, maxBytes });
    const loc = res.headers.location;
    if (loc && res.status >= 300 && res.status < 400) {
      const next = new URL(loc, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('blocked_scheme');
      current = next;
      continue;
    }
    return { ...res, finalUrl: current };
  }
  throw new Error('too_many_redirects');
}

// ---------- URL helpers ----------
function parseTarget(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > MAX_URL) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u;
}

function resolveUrl(value, base) {
  const v = String(value || '').trim();
  if (!v || /^data:/i.test(v) || /^blob:/i.test(v) || /^javascript:/i.test(v)) return '';
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.href.length > MAX_URL) return '';
    return u.href;
  } catch { return ''; }
}

// ---------- HTML metadata ----------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7', bull: '\u2022', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', times: '\u00d7', laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5' };

function decodeEntities(s) {
  return String(s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; } catch { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp('[\\s"\'/]' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s"\'>=]+))', 'i'));
  if (!m) return null;
  const raw = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  return raw === undefined ? null : decodeEntities(raw);
}

function tidy(s, max) {
  const t = String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return max && t.length > max ? t.slice(0, max - 1).trimEnd() + '\u2026' : t;
}

// Pages that answered but have nothing to say (bot walls, error pages).
const USELESS_TITLE = /^(just a moment|attention required|access denied|forbidden|404 not found|not found|are you a robot|error|cloudflare|verifying you are human)/i;

function parseHtml(html, base) {
  const baseTag = html.match(/<base\b[^>]*>/i);
  const baseHref = baseTag && attr(baseTag[0], 'href');
  const resolveBase = (baseHref && resolveUrl(baseHref, base)) || base;

  const meta = new Map();
  const links = [];
  let m;
  const metaRe = /<meta\b[^>]*>/gi;
  let n = 0;
  while ((m = metaRe.exec(html)) && n < 600) {
    n++;
    const tag = m[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop') || '').trim().toLowerCase();
    if (!key) continue;
    const content = attr(tag, 'content');
    if (content == null || !content.trim()) continue;
    if (!meta.has(key)) meta.set(key, content.trim());
  }
  const linkRe = /<link\b[^>]*>/gi;
  let ln = 0;
  while ((m = linkRe.exec(html)) && ln < 200) {
    ln++;
    const tag = m[0];
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!rel) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    links.push({ rel, type: (attr(tag, 'type') || '').toLowerCase(), href, sizes: attr(tag, 'sizes') || '', title: attr(tag, 'title') || '' });
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let oembed = '';
  for (const l of links) {
    if (l.rel.split(/\s+/).includes('alternate') && l.type.includes('json+oembed')) { oembed = resolveUrl(l.href, resolveBase); break; }
  }
  if (!oembed) {
    for (const l of links) {
      if (l.rel.split(/\s+/).includes('alternate') && l.type.includes('xml+oembed')) { oembed = resolveUrl(l.href, resolveBase); break; }
    }
  }
  // Largest declared icon first; apple-touch-icon is the usual decent fallback.
  let icon = '';
  const icons = links.filter((l) => l.rel.split(/\s+/).some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed' || r === 'shortcut'));
  if (icons.length) {
    const score = (l) => {
      const s = (l.sizes.match(/(\d+)x(\d+)/) || [])[1];
      return (l.rel.includes('apple-touch-icon') ? 32 : 0) + (s ? Math.min(parseInt(s, 10), 512) : 16);
    };
    icons.sort((a, b) => score(b) - score(a));
    icon = resolveUrl(icons[0].href, resolveBase);
  }

  const get = (...keys) => {
    for (const k of keys) {
      const v = meta.get(k);
      if (v) return v;
    }
    return '';
  };

  const title = tidy(get('og:title', 'twitter:title', 'application-name') || (titleTag ? decodeEntities(titleTag[1]) : ''), 200);
  const description = tidy(get('og:description', 'twitter:description', 'description'), 400);
  const image = resolveUrl(get('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src', 'image', 'thumbnailUrl'), resolveBase);
  const imageW = parseInt(get('og:image:width', 'twitter:image:width'), 10) || 0;
  const imageH = parseInt(get('og:image:height', 'twitter:image:height'), 10) || 0;
  const site = tidy(get('og:site_name', 'application-name', 'twitter:site'), 80).replace(/^@/, '');
  return { title, description, image, imageW, imageH, site, icon, oembed };
}

// JSON-LD is the last-resort source for sites with no OG tags at all
// (plenty of docs sites, shops and blogs).
function parseJsonLd(html, base) {
  const out = { title: '', description: '', image: '', site: '' };
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html)) && n < 4 && !out.title) {
    n++;
    if (m[1].length > 64 * 1024) continue;
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data && Array.isArray(data['@graph']) ? data['@graph'] : [data]);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const name = tidy(node.name || node.headline || '', 200);
      const desc = tidy(node.description || '', 400);
      let img = '';
      const raw = node.image || node.thumbnailUrl || '';
      if (typeof raw === 'string') img = resolveUrl(raw, base);
      else if (Array.isArray(raw) && raw.length) img = resolveUrl(typeof raw[0] === 'string' ? raw[0] : (raw[0] && raw[0].url) || '', base);
      else if (raw && typeof raw === 'object') img = resolveUrl(raw.url || '', base);
      if (name && !out.title) {
        out.title = name;
        out.description = out.description || desc;
        out.image = out.image || img;
        const pub = node.publisher || node.author;
        const pname = pub && (typeof pub === 'string' ? pub : pub.name);
        if (pname) out.site = tidy(pname, 80);
      }
    }
  }
  return out;
}

async function fetchOembed(href) {
  const r = await safeRequest(href, { maxBytes: MAX_JSON, headers: { Accept: 'application/json, text/javascript;q=0.9' } });
  if (r.status < 200 || r.status >= 300 || !r.body) return null;
  let j;
  try { j = JSON.parse(r.body.toString('utf8')); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  return {
    title: typeof j.title === 'string' ? tidy(j.title, 200) : '',
    description: typeof j.description === 'string' ? tidy(j.description, 400) : '',
    author: typeof j.author_name === 'string' ? tidy(j.author_name, 80) : '',
    provider: typeof j.provider_name === 'string' ? tidy(j.provider_name, 80) : '',
    image: typeof j.thumbnail_url === 'string' ? resolveUrl(j.thumbnail_url, href) : '',
    imageW: parseInt(j.thumbnail_width, 10) || 0,
    imageH: parseInt(j.thumbnail_height, 10) || 0,
  };
}

// ---------- the unfurl itself ----------
async function unfurlUrl(rawUrl) {
  const target = parseTarget(rawUrl);
  if (!target) return null;
  const res = await safeRequest(target.href, {
    maxBytes: MAX_HTML,
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
  });
  if (res.status < 200 || res.status >= 300 || !res.body || !res.body.length) return null;
  const ctype = String(res.headers['content-type'] || '').toLowerCase();
  // Direct media / API responses are the client's job (it embeds those inline).
  if (ctype && !/text\/html|application\/xhtml|text\/plain|xml/.test(ctype)) return null;
  const html = res.body.toString('utf8');
  const finalUrl = res.finalUrl.href;
  const parsed = parseHtml(html, finalUrl);
  let meta = parsed;

  if (parsed.oembed) {
    try {
      const oe = await fetchOembed(parsed.oembed);
      if (oe) {
        meta = {
          ...parsed,
          title: parsed.title || oe.title,
          description: parsed.description || oe.description,
          image: parsed.image || oe.image,
          imageW: parsed.imageW || oe.imageW,
          imageH: parsed.imageH || oe.imageH,
          site: parsed.site || oe.provider || oe.author,
        };
      }
    } catch { /* discovery link that doesn't answer: keep the OG data */ }
  }
  if (!meta.title || USELESS_TITLE.test(meta.title)) {
    const ld = parseJsonLd(html, finalUrl);
    meta = {
      ...meta,
      title: (!meta.title || USELESS_TITLE.test(meta.title)) ? ld.title : meta.title,
      description: meta.description || ld.description,
      image: meta.image || ld.image,
      site: meta.site || ld.site,
    };
  }
  if (!meta.title || USELESS_TITLE.test(meta.title)) return null;
  const host = res.finalUrl.hostname.replace(/^www\./, '');
  // "huggingface" as a site name reads worse than "huggingface.co"; when the
  // declared name is just the domain's first label, show the domain instead.
  let site = tidy(meta.site, 80);
  const label = host.split('.')[0];
  if (site && site.toLowerCase().replace(/[^a-z0-9]/g, '') === label.toLowerCase().replace(/[^a-z0-9]/g, '')) site = host;
  return {
    url: finalUrl,
    host,
    site: site || host,
    title: tidy(meta.title, 200),
    description: tidy(meta.description, 400),
    image: meta.image || '',
    imageW: Number.isFinite(meta.imageW) && meta.imageW > 0 && meta.imageW < 20000 ? meta.imageW : 0,
    imageH: Number.isFinite(meta.imageH) && meta.imageH > 0 && meta.imageH < 20000 ? meta.imageH : 0,
    icon: parsed.icon || '',
  };
}

// ---------- concurrency gate ----------
let active = 0;
const waiting = [];
function slot() {
  if (active < CONCURRENCY) { active++; return Promise.resolve(); }
  if (waiting.length >= 64) return Promise.reject(new Error('busy'));
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}

// ---------- cache ----------
const inflight = new Map(); // hash -> Promise

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
}

// -> { embed, cached } ; `cached` means "answered from Postgres" (the caller
// rate-limits live fetches, not cache hits).
async function getEmbed(rawUrl) {
  if (!ENABLED) return { embed: null, cached: true };
  const target = parseTarget(rawUrl);
  if (!target) return { embed: null, cached: true };
  const url = target.href;
  const id = hashUrl(url);
  try {
    const row = await db.prepare('SELECT ok, data, fetched_at FROM link_embeds WHERE id = ?').get(id);
    if (row) {
      const age = Date.now() - Number(row.fetched_at || 0);
      if (Number(row.ok) === 1 && age < OK_TTL) {
        try { return { embed: JSON.parse(row.data), cached: true }; } catch { /* rewrite below */ }
      } else if (Number(row.ok) !== 1 && age < FAIL_TTL) {
        return { embed: null, cached: true };
      }
    }
  } catch (e) {
    console.error('[unfurl] cache read failed:', (e && e.message) || e);
  }

  let p = inflight.get(id);
  if (!p) {
    p = (async () => {
      await slot();
      try {
        return await unfurlUrl(url);
      } catch (e) {
        return null;
      } finally {
        release();
      }
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  const data = await p;
  try {
    await db.prepare(`INSERT INTO link_embeds (id, url, ok, data, fetched_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, data = excluded.data, fetched_at = excluded.fetched_at`)
      .run(id, url.slice(0, MAX_URL), data ? 1 : 0, JSON.stringify(data || null), Date.now());
  } catch (e) {
    console.error('[unfurl] cache write failed:', (e && e.message) || e);
  }
  return { embed: data, cached: false };
}

async function prune() {
  try {
    await db.prepare('DELETE FROM link_embeds WHERE fetched_at < ?').run(Date.now() - KEEP_MS);
  } catch (e) {
    console.error('[unfurl] prune failed:', (e && e.message) || e);
  }
}

// ---------- thumbnails ----------
// Remote images come back through our origin: it fixes hotlink-protected and
// http-on-https images, and keeps the viewer's IP off the linked site.
function sign(url) {
  return crypto.createHmac('sha256', SIGN_SECRET).update(String(url)).digest('base64url').slice(0, 24);
}

function verifySig(url, sig) {
  if (!url || !sig || url.length > MAX_URL) return false;
  const want = sign(url);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function proxyPath(url) {
  if (!url) return '';
  const u = parseTarget(url);
  if (!u) return '';
  return '/api/unfurl/img?u=' + encodeURIComponent(u.href) + '&s=' + sign(u.href);
}

// Attach signed, proxied thumbnail/icon URLs (computed per response so a
// rotated secret can never poison the cached record).
function publicEmbed(data) {
  if (!data) return null;
  return {
    url: data.url,
    host: data.host,
    site: data.site,
    title: data.title,
    description: data.description,
    image: proxyPath(data.image),
    imageW: data.imageW || 0,
    imageH: data.imageH || 0,
    icon: proxyPath(data.icon),
  };
}

const IMG_TTL = 3600e3;
const IMG_CACHE_MAX = intEnv('UNFURL_IMG_CACHE_MB', 24) * 1024 * 1024;
const imgCache = new Map(); // url -> { type, buf, ts }
let imgBytes = 0;

// Only real image bytes leave our origin, typed from magic numbers rather than
// the remote Content-Type header. SVG is refused outright (it can carry script).
function sniffImage(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return '';
}

function cacheImage(url, entry) {
  const prev = imgCache.get(url);
  if (prev) imgBytes -= prev.buf.length;
  imgCache.set(url, entry);
  imgBytes += entry.buf.length;
  while (imgBytes > IMG_CACHE_MAX && imgCache.size > 1) {
    const oldest = imgCache.keys().next().value;
    const old = imgCache.get(oldest);
    imgCache.delete(oldest);
    imgBytes -= old.buf.length;
  }
}

async function fetchImage(rawUrl) {
  const target = parseTarget(rawUrl);
  if (!target) return null;
  const url = target.href;
  const hit = imgCache.get(url);
  if (hit) {
    if (Date.now() - hit.ts < IMG_TTL) {
      imgCache.delete(url); imgCache.set(url, hit); // LRU touch
      return hit;
    }
    imgCache.delete(url);
    imgBytes -= hit.buf.length;
  }
  await slot();
  let out = null;
  try {
    const res = await safeRequest(url, {
      maxBytes: MAX_IMAGE,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        // Half the web's CDNs reject a request with no Referer; the browser
        // that embedded this image would have sent its own origin.
        Referer: target.origin + '/',
      },
    });
    if (res.status < 200 || res.status >= 300 || !res.body || res.truncated) return null;
    const type = sniffImage(res.body);
    if (!type) return null;
    out = { type, buf: res.body, ts: Date.now() };
    cacheImage(url, out);
    return out;
  } catch {
    return null;
  } finally {
    release();
  }
}

module.exports = {
  enabled: () => ENABLED,
  getEmbed,
  publicEmbed,
  verifySig,
  fetchImage,
  prune,
  sign,
  proxyPath,
  // exported for tests
  _internals: { ipIsBlocked, parseHtml, parseTarget, sniffImage, decodeEntities, tidy, unfurlUrl, safeRequest },
};
