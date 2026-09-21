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
const INVITE_MAX = 3;   // invite cards per message — each carries a live fetch
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

// A YouTube URL carries two things the facade needs: the video's id, and whether
// it is a SHORT. A Short is shot vertical, so it renders as a vertical rectangle
// (9:16) — the 16:9 facade showed it as a pillarboxed strip with black bars down
// both sides, which is a landscape box holding a portrait picture (reported).
// Only the URL can say this: a Short opened through /watch?v= or a bare youtu.be
// link is indistinguishable from a normal video, and the oEmbed answer does not
// carry a shape either.
function ytFromUrl(u) {
  let p;
  try { p = new URL(u); } catch { return null; }
  const host = p.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = p.pathname.slice(1).split('/')[0];
    return YT_ID.test(id) ? { id: id, shorts: false } : null;
  }
  const bare = host.replace(/^(www\.|m\.|music\.)/, '');
  if (bare === 'youtube.com' || bare === 'youtube-nocookie.com') {
    if (p.pathname === '/watch') {
      const id = p.searchParams.get('v');
      return id && YT_ID.test(id) ? { id: id, shorts: false } : null;
    }
    const m = p.pathname.match(/^\/(shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/);
    if (m) return { id: m[2], shorts: m[1] === 'shorts' };
  }
  return null;
}

function ytIdFromUrl(u) {
  const yt = ytFromUrl(u);
  return yt ? yt.id : null;
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

function ytEmbedHTML(url, yt) {
  let provider = 'YouTube';
  try { if (new URL(url).hostname.toLowerCase().includes('music.')) provider = 'YouTube Music'; } catch {}
  // A Short gets a 9:16 tile and its card HUGS that tile (styles.css): a
  // full-width card wrapped around a narrow vertical box reads as a mistake. The
  // poster stays hqdefault — YouTube pillarboxes a vertical frame into that 4:3
  // thumbnail, and `.yt-facade img{object-fit:cover}` crops exactly those bars
  // back off, so the picture fills the tile edge to edge at full height. The
  // label says SHORT because the shape is otherwise unexplained.
  const vertical = !!yt.shorts;
  const thumb = 'https://i.ytimg.com/vi/' + yt.id + '/hqdefault.jpg';
  const play = 'https://www.youtube-nocookie.com/embed/' + yt.id + '?autoplay=1&rel=0';
  return '<div class="embed' + (vertical ? ' embed-vertical' : '') + '">'
    + '<span class="embed-src">' + esc(provider) + (vertical ? ' Short' : '') + '</span>'
    + '<button type="button" class="yt-facade' + (vertical ? ' vertical' : '') + '" data-yt-play="' + esc(play) + '" aria-label="Play video">'
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
    return '<div class="embed embed-media"><img class="embed-img" draggable="false" src="' + esc(url) + '" alt="" loading="lazy" /></div>';
  }
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) {
    return '<div class="embed embed-media"><video class="embed-vid" draggable="false" src="' + esc(url) + '" controls preload="metadata" playsinline></video></div>';
  }
  if (/\.(mp3|ogg|oga|wav|flac|m4a|opus)$/.test(path)) {
    return '<div class="embed embed-media"><audio src="' + esc(url) + '" controls preload="metadata"></audio></div>';
  }
  return null;
}

function embedForUrl(url) {
  let v;
  if ((v = ytFromUrl(url))) return ytEmbedHTML(url, v);
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
  const invites = [];
  const out = [];
  let players = 0;
  let cards = 0;
  let m;
  // A Campfire invite is not a link to preview — it is a server, and the card
  // below is the invitation itself. It is resolved from this app's own API
  // rather than unfurled (no external fetch, no cache TTL on somebody else's
  // HTML, and the member count and icon are the live ones), it goes FIRST, and
  // it is not beaten to the front by the players and generic cards sharing the
  // same message.
  while ((m = re.exec(src))) {
    const url = cleanEmbedUrl(m[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (inviteFromUrl(url)) { if (invites.length < INVITE_MAX) invites.push(inviteCardHTML(url)); continue; }
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
  const all = invites.concat(out);
  return all.length ? '<div class="embeds">' + all.join('') + '</div>' : '';
}

// ---------- plain-prose surfaces: story captions, story markup text ----------
// A caption and the text of a text-only story are typed prose, not chat markup:
// they keep their exact shape (every whitespace character, no markdown) and the
// only thing that changes is that a URL becomes a real link. Escaped HTML out,
// so callers assign it with innerHTML.
function anchorHTML(url) {
  return '<a href="' + eh(url) + '" target="_blank" rel="noopener nofollow ugc">' + eh(url) + '</a>';
}
function linkifyHTML(text) {
  const src = String(text == null ? '' : text);
  const re = /https?:\/\/[^\s<>"'`]+/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    const url = cleanEmbedUrl(m[0]);
    if (!url) continue;
    out += eh(src.slice(last, m.index)) + anchorHTML(url)
      + eh(src.slice(m.index + url.length, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  return out + eh(src.slice(last));
}
// A link on a story STICKER turns into the little card itself — that is what the
// sticker shows instead of the URL. A sticker is display text at 8.5% of the
// picture's height, where a raw URL is a ladder of characters, and the card is
// the thing worth looking at. Words around the link keep their line and the card
// lands under them; a sticker that is nothing but a URL IS the card. Anything
// the card cannot cover — previews off, a second link in the same sticker —
// stays a real link, so a URL can never be swallowed.
function storyTextHTML(text) {
  const src = String(text == null ? '' : text);
  const sole = /^\s*(https?:\/\/[^\s<>"'`]+)\s*$/.exec(src);
  if (sole) {
    const url = cleanEmbedUrl(sole[1]);
    const card = url ? storyLinkEmbedsHTML(url) : '';
    if (card) return card;
  }
  const re = /https?:\/\/[^\s<>"'`]+/g;
  let out = '';
  let last = 0;
  let placed = false;
  let m;
  while ((m = re.exec(src))) {
    const url = cleanEmbedUrl(m[0]);
    if (!url) continue;
    let html = '';
    if (!placed) { html = storyLinkEmbedsHTML(url); if (html) placed = true; }
    // Punctuation the URL did not own stays in the sentence, outside the card.
    out += eh(src.slice(last, m.index)) + (html || anchorHTML(url))
      + eh(src.slice(m.index + url.length, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  return out + eh(src.slice(last));
}
// The card a story shows. Always the compact unfurl card — never a player: a
// story is a picture first, and an iframe (Spotify, X, a Twitch player), a 16:9
// YouTube facade or a full-size image would cover the thing the reader opened.
// One card per story, and the caller asks for it with `keep` so a page the
// unfurl found nothing for still shows its little card instead of nothing.
function storyLinkEmbedsHTML(text) {
  const src = stripEmbedIgnored(text);
  const re = /https?:\/\/[^\s<>"'`]+/g;
  let m;
  while ((m = re.exec(src))) {
    const url = cleanEmbedUrl(m[0]);
    if (!url) continue;
    // An invite link stays a plain link on a story: the chat invite card is a
    // call to action, and the compact unfurl card underneath it is the same
    // link twice. (The story surfaces are pinned by scripts/test-story-links.js.)
    if (inviteFromUrl(url)) continue;
    // Nothing known for this URL (or the server had nothing): try the next one.
    const card = linkCardHTML(url, true, true);
    if (card) return '<div class="embeds">' + card + '</div>';
  }
  return '';
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
    h += '<span class="el-media"><img class="el-img" draggable="false" src="' + eh(d.image) + '"' + dims
      + ' alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest(\'.el-media\').remove()" /></span>';
  }
  return h;
}
// The little we can say about a link without asking anybody: a YouTube video's
// poster frame is a stable URL on YouTube's own CDN (the chat facade already
// loads it straight from there), so the card has a thumbnail the instant it is
// painted. The unfurl fills the title and channel in a moment later; an unfurl
// that finds nothing, or is switched off, still leaves a card worth tapping
// instead of a bare hostname.
function seedMeta(url) {
  const id = ytIdFromUrl(url);
  if (!id) return null;
  return {
    host: embedHost(url) || 'youtube.com',
    site: 'YouTube',
    title: '',
    description: '',
    image: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
    imageW: 480,
    imageH: 360,
  };
}
// The first card for a message gets the full-width treatment; the next few
// collapse to Discord's compact row (thumbnail on the right) so three links
// don't fill the whole channel.
//
// `keep` is the story's rule: there, the card IS the embed, so it must never
// vanish — a page the unfurl found nothing on (or one already asked about)
// still keeps the little card with the site on it, rather than leaving the
// reader with a bare underlined URL.
function linkCardHTML(url, compact, keep) {
  const seed = seedMeta(url);
  // Previews off means no card — EXCEPT one that needs no fetch at all (a
  // YouTube poster frame). Chat has always shown its YouTube facade with
  // UNFURL=0; a story's card should not be blinder than that.
  if (!previewsOn && !seed) return '';
  const cached = cardCache.get(url);
  if (cached === null && !keep && !seed) return '';   // asked before, nothing to show
  return '<a class="embed embed-link' + (compact ? ' compact' : '') + '" href="' + eh(url) + '" target="_blank" rel="noopener nofollow ugc"'
    + ' data-unfurl="' + eh(url) + '"' + (compact ? ' data-compact="1"' : '') + (cached ? ' data-carded="1"' : '') + (keep ? ' data-keep="1"' : '') + '>'
    + cardBodyHTML(cached || seed, url) + '</a>';
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
  // bare hostname chip — except where the card was asked for with `keep` (a
  // story, where the card is the whole embed and the hostname chip is still
  // worth more than nothing). Nothing is negative-cached on a network error, so
  // a later re-render tries again.
  if (!el.isConnected) return;
  if (!d) { if (!el.dataset.keep) el.remove(); return; }
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
    for (const n of seen) { scanLinkCards(n); scanInviteCards(n); }
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
    scanInviteCards(document.body);
    document.addEventListener('click', inviteCardClick);
    try { if (mo) mo.observe(document.body, { childList: true, subtree: true }); } catch {}
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}
// ---------- server invite cards ----------
// A Campfire invite link in a message is a SERVER, not a link to read: Discord's
// invite embed is the model, and the difference from every other card here is
// where the data comes from. This app's own /api/invite/:code already knows the
// server's name, description, icon and live member count, so the card asks it
// instead of unfurling — no external fetch, no week-long cache row describing a
// server that has since been renamed or emptied, and the one question a reader
// actually has ("am I already in there?") is answered by the same response.
//
// What the card does NOT do is join anybody. Someone already in the server gets
// "Open server" (it navigates straight there); someone who is not gets a Join
// button that opens the invite landing page, where the join still has to be
// accepted — a paste in chat must never silently put somebody in a server.
const INVITE_TTL_MS = 5 * 60e3;   // member counts move; a tab re-asks eventually
const inviteCache = new Map();    // "origin|code" -> { data, err, at }
const INVITE_PATH = /^\/invite\/([A-Za-z0-9_-]{1,64})\/?$/;

// Only a link that leads to an invite LANDING PAGE is treated as one. Our own
// origin always counts; another host has to look like the same app (the
// /invite/CODE page this app serves), which is what lets a second Campfire
// instance's invites still render here — the shape check is the whole test,
// because a false positive is only a card, never a fetch of anything private.
function inviteFromUrl(raw) {
  let p;
  try { p = new URL(raw); } catch { return null; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
  if (p.username || p.password) return null;
  const m = INVITE_PATH.exec(p.pathname);
  if (!m) return null;
  const self = (typeof location !== 'undefined' && location.host) ? location.host === p.host : false;
  return { code: m[1], origin: p.origin, self, url: p.href };
}
function inviteCacheKey(inv) { return inv.origin + '|' + inv.code; }
function inviteEndpoint(inv) {
  if (inv.self) return '/api/invite/' + encodeURIComponent(inv.code);
  return inv.origin + '/api/invite/' + encodeURIComponent(inv.code);
}
// Card state -> the words on it. `err` is what is KNOWN rather than what was
// hoped: a revoked link says so instead of pretending it is still an invitation.
function inviteView(err) {
  if (err === 'invite_expired') return { bad: 1, note: 'This invite has expired' };
  if (err === 'invite_exhausted') return { bad: 1, note: 'This invite has reached its use limit' };
  if (err) return { bad: 1, note: 'This invite is no longer valid' };
  return null;
}
function fmtMembers(n) { return n === 1 ? '1 member' : n + ' members'; }
// What the card calls itself. The heading NAMES the invitation rather than just
// the server ("Invite to Lisa's Basement"), which is the one line that tells a
// reader who scrolled past what this box is for — the server's own name and
// face are right underneath it. A card with no answer yet falls back to the
// plain heading, because "Invite to undefined" is worse than saying nothing.
function inviteHeading(d) {
  return (d && d.name) ? 'Invite to ' + d.name : 'Campfire invite';
}
// The card's OUTER element and its INNER contents are built separately on
// purpose. A repaint replaces the contents (`.iv-out`), never the element: the
// link-card scan reads `.embed-invite[data-invite]`, so an element rebuilt from
// the outside would be picked up again by the observer that is watching the very
// mutation it just caused — and the card would nest inside itself, one copy per
// pass. (scripts/test-invite-embeds-browser.js pins the single copy.)
function inviteBodyHTML(inv, hit) {
  const d = hit && hit.data;
  const bad = hit && hit.err;
  if (d) {
    const initial = esc((d.name || 'S').trim().charAt(0).toUpperCase());
    const inner = d.icon_url
      ? '<img src="' + eh(d.icon_url) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()" />'
      : initial;
    // "Open server" is only ever true for THIS deployment: another instance's
    // invite cannot be opened in this app however that instance answers, so it
    // stays a Join offer to its own landing page.
    const open = !!(d.joined && inv.self);
    return '<span class="iv-icon">' + inner + '</span>'
      + '<span class="iv-head">' + eh(inviteHeading(d)) + '</span>'
      + '<span class="iv-name">' + eh(d.name || 'Server') + '</span>'
      + '<span class="iv-meta">' + fmtMembers(Number(d.memberCount) || 0) + '</span>'
      + (d.description ? '<span class="iv-desc">' + eh(d.description) + '</span>' : '')
      + '<a class="btn primary small emb-go" href="' + eh(inv.url) + '"' + (inv.self ? '' : ' target="_blank" rel="noopener nofollow ugc"')
      + (open ? ' data-invite-join="' + eh(d.serverId || '') + '"' : '')
      + '>' + (open ? 'Open server' : 'Join server') + '</a>';
  }
  return '<span class="iv-head">' + (bad ? 'Invite unavailable' : 'Campfire invite') + '</span>'
    + '<span class="iv-meta">' + (bad ? esc(inviteView(hit && hit.err).note) : 'Checking link…') + '</span>';
}
function inviteBodyFor(url) {
  const inv = inviteFromUrl(url);
  if (!inv) return null;
  return { inv, hit: inviteCache.get(inviteCacheKey(inv)) || null };
}
function inviteCardHTML(url) {
  const f = inviteBodyFor(url);
  if (!f) return '';
  // No `href` on the card itself: a click anywhere but the button must not
  // navigate away from a half-read channel (the URL is already in the message).
  return '<div class="embed embed-invite' + (f.hit && f.hit.err ? ' bad' : '') + '" data-invite="' + eh(f.inv.url) + '">'
    + '<span class="iv-out">' + inviteBodyHTML(f.inv, f.hit) + '</span></div>';
}
// Repaint a card in place from whatever is known now (a live answer, a verdict
// about the link, or still nothing): the CONTENTS move, the element does not.
function paintInviteCard(el, hit, inv) {
  el.classList.toggle('bad', !!(hit && hit.err));
  el.innerHTML = '<span class="iv-out">' + inviteBodyHTML(inv, hit) + '</span>';
  el.dataset.invited = '1';
}
// An answer that is already known and young enough is reused outright; anything
// else goes to the network EVERY time. There is deliberately no in-flight
// dedupe: message lists are rebuilt wholesale on every update, so a promise left
// over from the render before this one would answer for an element that is no
// longer on screen — and the reader would keep a stale "Join server" on a server
// they just joined. The window is small and this endpoint is local and cached
// server-side.
async function fetchInvite(inv) {
  const key = inviteCacheKey(inv);
  const hit = inviteCache.get(key);
  if (hit && Date.now() - hit.at < INVITE_TTL_MS) return hit;
  let next;
  try {
    const res = await fetch(inviteEndpoint(inv), {
      // A cross-origin invite is somebody else's deployment: it may not ask
      // for our token, and `joined` there could only ever be about our own
      // servers, so it is left out of the request entirely.
      headers: (inv.self && typeof cardAuthHeader === 'function') ? cardAuthHeader() : {},
      credentials: inv.self ? 'same-origin' : 'omit',
    });
    if (res.ok) next = { data: await res.json(), at: Date.now() };
    // 404/410 are verdicts about the LINK and are remembered as such; a 5xx or
    // a dead network is not (the next render asks again).
    else if (res.status === 404 || res.status === 410) {
      const j = await res.json().catch(() => null);
      next = { err: (j && j.error) || 'bad_invite', at: Date.now() };
    } else next = { at: 0 };
  } catch { next = { at: 0 }; }
  inviteCache.set(key, next);
  return next;
}
async function fillInvite(el) {
  const inv = inviteFromUrl(el.dataset.invite);
  if (!inv) return;
  const hit = await fetchInvite(inv);
  if (!el.isConnected || !el.dataset.invite) return;
  // A verdict about the link (revoked, expired) is painted; a network hiccup is
  // not — the headerless stub the message rendered is left alone rather than
  // mislabelled "unavailable", and the next render asks again.
  if (hit && (hit.data || hit.err)) paintInviteCard(el, hit, inv);
}
// The card's one action, delegated on the document: "Open server" switches to a
// server this account is already in. Anything else (not signed in, not a
// member) is an ordinary anchor to the landing page, where joining is confirmed.
function inviteCardClick(ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-invite-join]') : null;
  if (!el) return;
  const sid = el.getAttribute('data-invite-join');
  if (!sid || typeof selectServer !== 'function') return;
  ev.preventDefault();
  selectServer(sid).catch(() => { try { location.assign(el.getAttribute('href') || '/'); } catch {} });
}
// One MutationObserver already watches the whole list for link cards; invites
// ride the same scan rather than opening a second observer on the same tree.
function scanInviteCards(root) {
  if (!root || root.nodeType !== 1) return;
  let nodes;
  try {
    nodes = (root.matches && root.matches('.embed-invite[data-invite]'))
      ? [root] : Array.from(root.querySelectorAll('.embed-invite[data-invite]'));
  } catch { return; }
  for (const el of nodes) {
    if (el.dataset.invited) continue;
    el.dataset.invited = '1';
    // A card the message rendered from the cache is already complete; this is
    // the cold path (first paint, or the cache has aged out).
    fillInvite(el);
  }
}

if (typeof document !== 'undefined') installLinkCards();

// Node test hook (browsers ignore: `module` is undefined there).
try { if (typeof module !== 'undefined') module.exports = { linkEmbedsHTML, linkifyHTML, storyTextHTML, storyLinkEmbedsHTML, embedForUrl, cleanEmbedUrl, stripEmbedIgnored, cardBodyHTML, linkCardHTML, setLinkPreviews, inviteFromUrl, inviteCardHTML, fillInvite, fmtMembers, __cardCache: cardCache, __inviteCache: inviteCache }; } catch {}
