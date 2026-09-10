/* Campfire link embeds — client-side rich previews for message links.
 * YouTube / YouTube Music get a click-to-play thumbnail (cheap until played);
 * X, Spotify, SoundCloud, Twitch, TikTok, Instagram, Vimeo and Streamable
 * render their official iframe players; direct image/video/audio links render
 * inline.
 *
 * Anything else gets a **link card**: a placeholder goes out with the message
 * and the server (unfurl.js, GET /api/unfurl) reads the page's OpenGraph /
 * Twitter-card / oEmbed metadata for site, title, description and thumbnail.
 * Cards are fetched lazily as they scroll near the viewport, deduped per URL
 * on both ends, and filled from cache synchronously on re-renders, so pasting
 * a HuggingFace model page looks like Discord's embed.
 *
 * Loaded before the js/ app scripts; its esc() use is call-time only, so the
 * helper just needs to exist globally by the time messages render. No DOM deps (testable in node).
 */
'use strict';

const EMBED_MAX = 3;
const CARD_MAX = 3;     // generic link cards per message (first is full-size, rest compact)
const EMBED_TOTAL = 5;  // players + cards combined
const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

function stripEmbedIgnored(text) {
  // Skip links inside `code` and ||spoilers|| (a spoilered thumb would leak it).
  return String(text || '').replace(/`[^`\n]+`/g, '').replace(/\|\|.+?\|\|/gs, '');
}

function cleanEmbedUrl(raw) {
  // Trim trailing punctuation that is almost never part of a pasted link.
  let u = String(raw || '');
  while (u.length && /[.,;:!?'"’”\]}]/.test(u[u.length - 1])) u = u.slice(0, -1);
  // Drop unbalanced trailing closers: ".../wiki/Foo_(bar))" keeps the balance.
  let changed = true;
  while (changed && u.length) {
    changed = false;
    const last = u[u.length - 1];
    if (last === ')' || last === ']') {
      const open = last === ')' ? '(' : '[';
      let depth = 0;
      for (const c of u) { if (c === open) depth++; else if (c === last) depth--; }
      if (depth < 0) { u = u.slice(0, -1); changed = true; }
    }
  }
  return u;
}

function ytIdFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = p.pathname.slice(1).split('/')[0];
    return YT_ID.test(id) ? id : null;
  }
  const bare = host.replace(/^(www\.|m\.|music\.)/, '');
  if (bare === 'youtube.com' || bare === 'youtube-nocookie.com') {
    if (p.pathname === '/watch') {
      const id = p.searchParams.get('v');
      return id && YT_ID.test(id) ? id : null;
    }
    const m = p.pathname.match(/^\/(shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/);
    if (m) return m[2];
  }
  return null;
}

function spotifyFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  if (p.hostname.toLowerCase() !== 'open.spotify.com') return null;
  const m = p.pathname.match(/^\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,40})/);
  return m ? { type: m[1], id: m[2] } : null;
}

function tweetIdFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  if (host !== 'x.com' && host !== 'www.x.com' && host !== 'twitter.com' && host !== 'mobile.twitter.com') return null;
  const m = p.pathname.match(/\/status(?:es)?\/(\d{1,25})/);
  return m ? m[1] : null;
}

function tiktokIdFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  if (!/(^|\.)tiktok\.com$/.test(p.hostname.toLowerCase())) return null;
  const m = p.pathname.match(/\/video\/(\d{5,30})/);
  return m ? m[1] : null;
}

function instaFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  if (host !== 'instagram.com' && host !== 'www.instagram.com') return null;
  const m = p.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,60})/);
  if (!m) return null;
  return { kind: m[1] === 'p' ? 'p' : 'reel', code: m[2] };
}

function vimeoIdFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  if (host !== 'vimeo.com' && host !== 'www.vimeo.com' && host !== 'player.vimeo.com') return null;
  const m = p.pathname.match(/^\/(?:video\/)?(\d{4,20})/);
  return m ? m[1] : null;
}

const TWITCH_RESERVED = new Set(['directory', 'settings', 'downloads', 'jobs', 'subscriptions',
  'wallet', 'drops', 'store', 'prime', 'turbo', 'search', 'user', 'team', 'collection', 'clip',
  'videos', 'moderator', 'login', 'signup', 'about', 'blog', 'legal', 'p', 'events', 'inventory',
  'following', 'activate']);

function twitchFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  const segs = p.pathname.split('/').filter(Boolean);
  if (host === 'clips.twitch.tv') {
    const slug = segs[segs.length - 1] || '';
    return /^[A-Za-z0-9_-]{4,100}$/.test(slug) ? { kind: 'clip', id: slug } : null;
  }
  if (host !== 'twitch.tv' && host !== 'www.twitch.tv' && host !== 'm.twitch.tv') return null;
  if (segs[0] === 'videos' && /^\d{4,20}$/.test(segs[1] || '')) return { kind: 'vod', id: segs[1] };
  if (segs[1] === 'clip' && /^[A-Za-z0-9_-]{4,100}$/.test(segs[2] || '')) return { kind: 'clip', id: segs[2] };
  if (segs.length === 1 && /^[A-Za-z0-9_]{2,25}$/.test(segs[0]) && !TWITCH_RESERVED.has(segs[0].toLowerCase())) {
    return { kind: 'live', id: segs[0] };
  }
  return null;
}

function streamableIdFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  if (host !== 'streamable.com' && host !== 'www.streamable.com') return null;
  const m = p.pathname.match(/^\/(?:e\/)?([a-z0-9]{3,12})\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

function soundcloudInfo(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  if (host !== 'soundcloud.com' && host !== 'www.soundcloud.com' && host !== 'm.soundcloud.com') return null;
  if (p.pathname.split('/').filter(Boolean).length < 2) return null; // need /artist/track
  return { set: p.pathname.includes('/sets/') };
}

function embedShell(provider, inner) {
  return '<div class="embed"><span class="embed-src">' + esc(provider) + '</span>' + inner + '</div>';
}

function ytEmbedHTML(url, id) {
  let provider = 'YouTube';
  try { if (new URL(url).hostname.toLowerCase().includes('music.')) provider = 'YouTube Music'; } catch {}
  const thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  const play = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
  return '<div class="embed"><span class="embed-src">' + esc(provider) + '</span>'
    + '<button type="button" class="yt-facade" data-yt-play="' + esc(play) + '" aria-label="Play video">'
    + '<img src="' + esc(thumb) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'" />'
    + '<span class="yt-play"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>'
    + '</button></div>';
}

function spotifyEmbedHTML(url, sp) {
  const tall = sp.type === 'album' || sp.type === 'playlist' || sp.type === 'show';
  const src = 'https://open.spotify.com/embed/' + sp.type + '/' + sp.id + '?utm_source=generator&theme=0';
  return embedShell('Spotify', '<iframe class="embed-frame spotify" style="height:' + (tall ? 352 : 152) + 'px" src="'
    + esc(src) + '" title="Spotify player" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>');
}

function tweetEmbedHTML(url, id) {
  const src = 'https://platform.twitter.com/embed/Tweet.html?id=' + id + '&dnt=true&theme=dark';
  return embedShell('X', '<iframe class="embed-frame tweet" src="' + esc(src)
    + '" title="Post on X" loading="lazy" allowfullscreen></iframe>');
}

function tiktokEmbedHTML(url, id) {
  const src = 'https://www.tiktok.com/embed/v2/' + id;
  return embedShell('TikTok', '<iframe class="embed-frame tiktok" src="' + esc(src)
    + '" title="TikTok video" loading="lazy" allow="fullscreen" allowfullscreen></iframe>');
}

function instaEmbedHTML(url, ig) {
  const src = 'https://www.instagram.com/' + ig.kind + '/' + ig.code + '/embed';
  return embedShell('Instagram', '<iframe class="embed-frame ig" src="' + esc(src)
    + '" title="Instagram post" loading="lazy" allowfullscreen></iframe>');
}

function vimeoEmbedHTML(url, id) {
  const src = 'https://player.vimeo.com/video/' + id;
  return embedShell('Vimeo', '<div class="embed-169"><iframe class="embed-frame" src="' + esc(src)
    + '" title="Vimeo video" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>');
}

function twitchEmbedHTML(url, tw) {
  const parent = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'localhost';
  let src;
  if (tw.kind === 'clip') src = 'https://clips.twitch.tv/embed?clip=' + tw.id + '&parent=' + parent;
  else if (tw.kind === 'vod') src = 'https://player.twitch.tv/?video=' + tw.id + '&parent=' + parent;
  else src = 'https://player.twitch.tv/?channel=' + tw.id.toLowerCase() + '&parent=' + parent;
  return embedShell('Twitch', '<div class="embed-169"><iframe class="embed-frame" src="' + esc(src)
    + '" title="Twitch player" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>');
}

function streamableEmbedHTML(url, id) {
  const src = 'https://streamable.com/e/' + id;
  return embedShell('Streamable', '<div class="embed-169"><iframe class="embed-frame" src="' + esc(src)
    + '" title="Streamable video" loading="lazy" allow="fullscreen" allowfullscreen></iframe></div>');
}

function soundcloudEmbedHTML(url, info) {
  const src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) + '&color=%23ff5500&auto_play=false&hide_related=true';
  return embedShell('SoundCloud', '<iframe class="embed-frame soundcloud" style="height:' + (info.set ? 450 : 166) + 'px" src="'
    + esc(src) + '" title="SoundCloud player" loading="lazy" allow="autoplay" allowfullscreen></iframe>');
}

function directMediaEmbedHTML(url) {
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { return null; }
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(path)) {
    return '<div class="embed embed-media"><img class="embed-img" src="' + esc(url) + '" alt="" loading="lazy" /></div>';
  }
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) {
    return '<div class="embed embed-media"><video class="embed-vid" src="' + esc(url) + '" controls preload="metadata" playsinline></video></div>';
  }
  if (/\.(mp3|ogg|oga|wav|flac|m4a|opus)$/.test(path)) {
    return '<div class="embed embed-media"><audio src="' + esc(url) + '" controls preload="metadata"></audio></div>';
  }
  return null;
}

function embedForUrl(url) {
  let v;
  if ((v = ytIdFromUrl(url))) return ytEmbedHTML(url, v);
  if ((v = spotifyFromUrl(url))) return spotifyEmbedHTML(url, v);
  if ((v = tweetIdFromUrl(url))) return tweetEmbedHTML(url, v);
  if ((v = tiktokIdFromUrl(url))) return tiktokEmbedHTML(url, v);
  if ((v = instaFromUrl(url))) return instaEmbedHTML(url, v);
  if ((v = vimeoIdFromUrl(url))) return vimeoEmbedHTML(url, v);
  if ((v = twitchFromUrl(url))) return twitchEmbedHTML(url, v);
  if ((v = streamableIdFromUrl(url))) return streamableEmbedHTML(url, v);
  if ((v = soundcloudInfo(url))) return soundcloudEmbedHTML(url, v);
  return directMediaEmbedHTML(url);
}

function linkEmbedsHTML(text) {
  const src = stripEmbedIgnored(text);
  const re = /https?:\/\/[^\s<>"'`]+/g;
  const seen = new Set();
  const out = [];
  let players = 0;
  let cards = 0;
  let m;
  while (out.length < EMBED_TOTAL && (m = re.exec(src))) {
    const url = cleanEmbedUrl(m[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let html = null;
    try { html = embedForUrl(url); } catch { html = null; }
    if (html) {
      if (players < EMBED_MAX) { players++; out.push(html); }
      continue;
    }
    if (cards < CARD_MAX) {
      const card = linkCardHTML(url, cards > 0);
      cards++;
      if (card) out.push(card);
    }
  }
  return out.length ? '<div class="embeds">' + out.join('') + '</div>' : '';
}

// ---------- generic link cards (server-side unfurl) ----------
// A message renders instantly with a hostname-only card; the metadata lands
// asynchronously and is cached, so re-renders paint the finished card inline.
let previewsOn = true;            // turned off by /api/config when the server has UNFURL=0
const cardCache = new Map();      // url -> embed object | null (nothing found)
const cardPending = new Map();    // url -> in-flight promise
let cardObserver = null;

function setLinkPreviews(on) { previewsOn = on !== false; }
function eh(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function embedHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function cardTextHTML(d, url) {
  const host = (d && d.host) || embedHost(url);
  const site = (d && d.site) || host;
  let h = '<span class="el-top">';
  if (d && d.icon) h += '<img class="el-fav" src="' + eh(d.icon) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()" />';
  h += '<span class="el-site">' + eh(site) + '</span></span>';
  if (d && d.title) h += '<span class="el-title">' + eh(d.title) + '</span>';
  if (d && d.description) h += '<span class="el-desc">' + eh(d.description) + '</span>';
  return h;
}
function cardBodyHTML(d, url) {
  let h = '<span class="el-body">' + cardTextHTML(d, url) + '</span>';
  if (d && d.image) {
    const dims = (d.imageW && d.imageH) ? ' width="' + d.imageW + '" height="' + d.imageH + '"' : '';
    h += '<span class="el-media"><img class="el-img" src="' + eh(d.image) + '"' + dims
      + ' alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest(\'.el-media\').remove()" /></span>';
  }
  return h;
}
// The first card for a message gets the full-width treatment; the next few
// collapse to Discord's compact row (thumbnail on the right) so three links
// don't fill the whole channel.
function linkCardHTML(url, compact) {
  if (!previewsOn) return '';
  const cached = cardCache.get(url);
  if (cached === null) return '';     // asked before, nothing to show
  return '<a class="embed embed-link' + (compact ? ' compact' : '') + '" href="' + eh(url) + '" target="_blank" rel="noopener nofollow ugc"'
    + ' data-unfurl="' + eh(url) + '"' + (compact ? ' data-compact="1"' : '') + (cached ? ' data-carded="1"' : '') + '>'
    + cardBodyHTML(cached, url) + '</a>';
}
function cardAuthHeader() {
  try { return (typeof store !== 'undefined' && store.token) ? { Authorization: 'Bearer ' + store.token } : {}; }
  catch { return {}; }
}
function fetchCard(url) {
  if (cardCache.has(url)) return Promise.resolve(cardCache.get(url));
  if (cardPending.has(url)) return cardPending.get(url);
  const p = (async () => {
    try {
      const res = await fetch('/api/unfurl?url=' + encodeURIComponent(url), {
        headers: cardAuthHeader(), credentials: 'same-origin',
      });
      // 429 = we're asking too fast, 403/401 = not signed in: leave the card
      // alone (not negative-cached) so a later render tries again.
      if (!res.ok) return res.status === 429 || res.status === 403 || res.status === 401 ? undefined : null;
      const j = await res.json().catch(() => null);
      const d = (j && j.embed) ? j.embed : null;
      cardCache.set(url, d);
      return d;
    } catch { return undefined; }
    finally { cardPending.delete(url); }
  })();
  cardPending.set(url, p);
  return p;
}
async function fillCard(el) {
  const url = el.dataset.unfurl;
  if (!url) return;
  const d = await fetchCard(url);
  // No data (or the request never landed): drop the stub rather than leave a
  // bare hostname chip. Nothing is negative-cached on a network error, so a
  // later re-render tries again.
  if (!el.isConnected) return;
  if (!d) { el.remove(); return; }
  el.innerHTML = cardBodyHTML(d, url);
}
function scanLinkCards(root) {
  if (!previewsOn || !root || root.nodeType !== 1) return;
  let nodes;
  try {
    nodes = (root.matches && root.matches('a.embed-link[data-unfurl]'))
      ? [root] : Array.from(root.querySelectorAll('a.embed-link[data-unfurl]'));
  } catch { return; }
  for (const el of nodes) {
    if (el.dataset.carded) continue;
    el.dataset.carded = '1';
    if (cardObserver) cardObserver.observe(el); else fillCard(el);
  }
}
// Message lists are rebuilt wholesale on every update, so watch the DOM rather
// than hooking each render path: any card that appears is picked up, whether
// it came from history, the live socket, search or pins.
function installLinkCards() {
  try {
    if (typeof IntersectionObserver === 'function') {
      cardObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          cardObserver.unobserve(e.target);
          fillCard(e.target);
        }
      }, { rootMargin: '600px 0px' });
    }
  } catch { cardObserver = null; }
  const seen = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    for (const n of seen) scanLinkCards(n);
    seen.clear();
  };
  let mo = null;
  try {
    mo = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) seen.add(n);
      if (!seen.size || scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    });
  } catch { mo = null; }
  const start = () => {
    scanLinkCards(document.body);
    try { if (mo) mo.observe(document.body, { childList: true, subtree: true }); } catch {}
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}
if (typeof document !== 'undefined') installLinkCards();

// Node test hook (browsers ignore: `module` is undefined there).
try { if (typeof module !== 'undefined') module.exports = { linkEmbedsHTML, embedForUrl, cleanEmbedUrl, stripEmbedIgnored, cardBodyHTML, linkCardHTML, setLinkPreviews, __cardCache: cardCache }; } catch {}
