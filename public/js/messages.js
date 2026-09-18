'use strict';
// ---------- messages ----------
function canMod(m) {
  if (m.webhook) return S.view === 'server' && canManage();
  if (!m.user) return false;
  if (S.view === 'home') return m.user.id === S.me.id;
  return m.user.id === S.me.id || (S.view === 'server' && canManage());
}
function msgById(id) {
  for (const [, arr] of S.messages) { const f = arr.find((x) => x.id === id); if (f) return f; }
  if (S.thread) {
    if (S.thread.root?.id === id) return S.thread.root;
    const f = S.thread.replies.find((x) => x.id === id); if (f) return f;
  }
  for (const [, arr] of S.dmMessages) { const f = arr.find((x) => x.id === id); if (f) return f; }
  return null;
}
function updateMsgInCaches(mid, fn) {
  for (const [, arr] of S.messages) { const i = arr.findIndex((x) => x.id === mid); if (i >= 0) fn(arr[i]); }
  if (S.thread) {
    if (S.thread.root?.id === mid) fn(S.thread.root);
    const r = S.thread.replies.find((x) => x.id === mid); if (r) fn(r);
  }
  for (const [, arr] of S.dmMessages) { const i = arr.findIndex((x) => x.id === mid); if (i >= 0) fn(arr[i]); }
}
const DL_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
// The download link, withheld while a file is still behind the scan gate: the
// reader has nothing to save yet, and a link to a URL that answers 423 is only a
// way to fail. It arrives with the final bytes (the same moment the chip goes).
function attDl(a, pending) { return pending ? '' : `<a class="att-dl" href="${esc(a.url)}" download="${esc(a.name)}" target="_blank" rel="noopener" title="Download">${DL_ICON}</a>`; }
// ---------- starring a GIF that was shared in chat ----------
// A GIF posted from the picker carries the Klipy item it came from on the
// attachment itself (gif_slug/gif_thumb/gif_mp4 — see cleanGifMeta in
// server.js), and that slug is what a favorite is keyed on. A GIF posted BEFORE
// the picker stamped any of that still has an identity of its own, though: the
// md.gif url the picker posted, which is stable for the life of the Klipy item.
// So a remote GIF attachment with no slug is keyed on a short deterministic hash
// of that url instead (which the favorites table accepts as a slug — see
// GIF_FAV_SLUG_RE), and every lookup matches a favorite by key OR by its gif
// url, so the two ways of naming the same GIF always resolve to one row.
// An UPLOADED .gif has neither a Klipy item nor an https url behind it, and the
// favorites route only takes http(s): it gets no star rather than a dead one.
const ATT_STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.7 7.1-.6z"/></svg>';
function gifUrlFavKey(url) {
  // FNV-1a twice from different offsets — a ~64-bit key in base36. Stability
  // across devices and sessions is the whole point: the same GIF posted twice
  // must resolve to one favorite.
  const h = (seed) => {
    let x = seed;
    for (let i = 0; i < url.length; i++) { x ^= url.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
    return x.toString(36);
  };
  return 'u' + h(2166136261) + h(1099511628);
}
// The identity a favorite is written under: the Klipy slug when the post has
// one, else the url-derived key for a remote GIF, else '' (nothing to star).
function gifFavKeyFor(a) {
  if (!a) return '';
  if (a.gif_slug) return a.gif_slug;
  if (a.kind !== 'image' || a.mime !== 'image/gif' || !/^https:\/\//.test(String(a.url || ''))) return '';
  return gifUrlFavKey(a.url);
}
// Is this GIF already in the account's favorites? By key, or by the gif it
// points at — a GIF starred from chat before the picker knew its slug, then
// starred again from a picker tile, is one row, not two. `favs` is the caller's
// list (the picker passes S.gifFavs explicitly); a null one falls back to the
// account's, and the markup path runs fine without any app state at all.
function gifFavMatch(favs, key, gifUrl) {
  const list = favs || (typeof S !== 'undefined' && S.gifFavs) || [];
  return list.some((f) => f && ((!!key && f.slug === key) || (!!gifUrl && f.gif === gifUrl)));
}
function attFavHTML(a, pending) {
  if (pending) return ''; // nothing to star until the bytes are the final ones
  const key = gifFavKeyFor(a);
  if (!key) return '';
  const on = gifFavMatch(null, key, a.url);
  const label = on ? 'Remove from favorites' : 'Add to favorites';
  return `<button type="button" class="att-star${on ? ' on' : ''}" data-act="gif-fav"` +
    ` data-gif-key="${esc(key)}" data-gif-url="${esc(a.url)}" data-gif-thumb="${esc(a.gif_thumb || a.url || '')}"` +
    ` data-gif-mp4="${esc(a.gif_mp4 || '')}" data-gif-title="${esc(String(a.name || '').replace(/\.gif$/i, ''))}"` +
    ` title="${label}" aria-label="${label}" aria-pressed="${on ? 'true' : 'false'}">${ATT_STAR_SVG}</button>`;
}
// Shield mark for the virus-scan cards (inline SVG keeps UI chrome emoji-free).
const SCAN_SHIELD_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3.5v5.2c0 5-3.4 9.4-8 10.8-4.6-1.4-8-5.8-8-10.8V5.5z"/><path d="M9 11.5l2.2 2.2L15.5 9.5"/></svg>';
// Media downloads go through plain anchor navigation (works in every WebView),
// so confirm them with a toast — otherwise the file just lands in Downloads
// with no indication anything happened. Native behavior is untouched.
document.addEventListener('click', (e) => {
  const dl = e.target.closest ? e.target.closest('a.att-dl') : null;
  if (!dl) return;
  toast(`Downloading ${(dl.getAttribute('download') || 'file').slice(0, 60)}…`);
});
// Full-size chat images are what makes opening a channel crawl on a slow link:
// one photo is 10-30x the bytes of its own 640px preview, and a backlog is
// mostly pictures. Every chat/DM STILL image therefore renders its DERIVED
// preview (/uploads/thumbs/files/<name>.<ext>.webp — minted on first request,
// see media-compress.js) with the attachment's own bytes one error away: the
// document error handler (final.js) swaps in the original exactly once, so a
// preview that cannot be minted costs a slower load, never a broken picture.
// An ANIMATED picture is the one case that preview cannot stand in for — it is
// a single frame (see attIsAnimated below).
// ---------- the shape of a picture, before its bytes ----------
// A chat picture used to render at zero height and then snap to full size as it
// landed, which collapses the row it is in and shoves everything below it — the
// whole-list rebuilds make that happen again on every new message. So every
// image gets its intrinsic size as width/height attributes: the browser then
// reserves exactly the box the picture will occupy, and the placeholder below
// has something to paint into.
//
// The size comes from the attachment record (server-measured, see image-size.js
// / att-dims.js), and from the image itself once it has painted here — that
// second source is what keeps media posted before the record existed stable
// across the constant re-renders within a session.
const attDimsSeen = new Map(); // clean upload path -> { w, h }
function attCleanUrl(url) { return String(url || '').split('?')[0]; }
function attDimsFor(a) {
  const w = Number(a && a.w) || 0, h = Number(a && a.h) || 0;
  if (w > 0 && h > 0) return { w, h };
  return attDimsSeen.get(attCleanUrl(a && a.url)) || null;
}
// Remember what a painted picture turned out to be. Keyed on the ORIGINAL url
// (the preview has its own, and the attachment is what carries the size).
function attDimsLearn(img) {
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!(w > 0) || !(h > 0)) return;
    const url = img.dataset.fbUrl || img.getAttribute('src') || '';
    if (url) attDimsSeen.set(attCleanUrl(url), { w, h });
  } catch {}
}
// Hold the placeholder until the picture has actually painted, then hand the box
// over to it. A cached image can already be complete by the time this runs, so
// `complete` is checked too — a load listener alone would leave the placeholder
// up forever on a warm cache. A failed preview is not a reason to keep it: the
// document error handler (final.js) swaps in the original, whose own load comes
// through here, and a picture that never loads at all ends as a file card, which
// the stylesheet drops the placeholder for.
//
// `.pending` is what SHOWS the placeholder, and it is set here rather than in the
// markup: a surface that renders an attachment without wiring it (and the tests
// that drive attachmentHTML directly) then gets the old behaviour — a visible
// picture — instead of one parked invisible behind a spinner that never lifts.
function wireAttImage(img) {
  if (!img || img.dataset.phWired) return;
  img.dataset.phWired = '1';
  const wrap = (img.closest && img.closest('.att-wrap')) || null;
  if (wrap) wrap.classList.add('pending');
  const done = () => {
    attDimsLearn(img);
    // `.pending` deliberately STAYS: `.ready` is the switch, and the stylesheet
    // fades the placeholder out on it. Clearing the class instead would make the
    // placeholder vanish without its transition, which is its own little flicker —
    // and a picture that was already painted (a warm cache: `complete` is true
    // before a listener can be attached) still goes through this same path.
    if (wrap) wrap.classList.add('ready');
  };
  if (img.complete && img.naturalWidth > 0) done();
  else img.addEventListener('load', done, { once: true });
}
// ---------- the picked bytes as a stand-in for a pending one ----------
// A chat upload is not servable until the scan slot has judged it AND the
// compressor has settled its bytes: the file posts to chat immediately, and the
// gate answers 423 in the meantime (see server.js scanGate). The uploading
// browser is holding those very bytes, so the honest rendering during that
// window is the picture itself — not a spinner card standing where it will be —
// and the same bytes are what the composer chip already paints.
//
// So a preview is kept from the moment the file is picked and is keyed BOTH by
// the attachment id (stable across the whole pipeline: the compressor may republish
// the bytes under a new key and a fresh ?v, and the id is what survives that) and
// by the attachment url (what the composer's chip lookups ask for). Rendering a
// pending attachment with a preview gives a box the exact shape of the final one,
// so the pending -> final handover moves no pixels; once the verdict lands the
// element keeps the preview it already has and only swaps the url it will fall
// back to, so the reader never sees an unload.
//
// Entries older than LOCAL_PREVIEW_CAP_BYTES are dropped oldest-first (blob urls
// revoked) — the map outlives the composer now that it feeds the message list, so
// it cannot be pruned by "is it still staged" alone.
const attPreviews = new Map(); // key (att id, else att url) -> { id, url, src, blob, bytes, unstagedAt }
let attPreviewBytes = 0;
// Keys whose file is still sitting in a composer. The size cap below evicts
// oldest-first, and a file the reader has picked but not sent yet must never be
// the one pushed out — its chip would lose the thumbnail it is built from.
let attPreviewStaged = new Set();
const LOCAL_PREVIEW_CAP_BYTES = 192 * 1024 * 1024;
// The two lifetimes of an entry that is in no composer (see pruneAttPreviews):
// one that a message has painted is kept until its slot has settled and then for
// KEEP_MS more, and one that NOTHING has painted — dropped with the ✕, or sent a
// moment ago — gets UNPAINTED_MS of grace before it is released. That grace is
// what carries the picked bytes across the SEND: the composer clears its list
// synchronously while the message that paints them arrives a WebSocket round trip
// later, and releasing in that gap revoked the blob — the row then rendered the
// ORIGINAL file's preview instead, and the compressor's republish under a fresh
// key had no picked frame left to carry over. That second swap is the blink.
const LOCAL_PREVIEW_KEEP_MS = 60000;
const LOCAL_PREVIEW_UNPAINTED_MS = 15000;
function attPreviewEntry(id, url) {
  if (id) { const hit = attPreviews.get(id); if (hit) return hit; }
  return url ? (attPreviews.get(url) || null) : null;
}
// What a MEDIA element for this attachment should point at right now: its local
// preview while there is one (the only bytes that are certainly servable), else
// the attachment's own url.
function attPreviewSrc(a) {
  if (!a || !a.url) return '';
  const hit = attPreviewEntry(a.id, a.url);
  if (hit) return hit.src;
  return (a.kind === 'image' && a.scan !== 'pending' && a.scan !== 'infected') ? a.url : '';
}
// Is this attachment still waiting on the slot AND are the picked bytes here?
// `attPreviewSrc` answers for the URL a media element should use; this answers
// "is that URL a local stand-in", which is what tells a pending media attachment
// apart from one with no local preview to show (the scanning card).
function attPendingPreview(a) {
  return !!(a && a.scan === 'pending' && a.url && attPreviewEntry(a.id, a.url));
}
// …and is that entry the MEDIA, or only a picture OF it? A picture and a voice
// note keep their own picked bytes, so a pending one paints the real thing. A
// CLIP does not: the store's entry for a video is a still FRAME captured off the
// picked file (see videoPreviewShot) — a poster, not a playable source. A pending
// clip therefore falls through to the scanning card, which is the honest
// "Processing file" state a reload already shows. Handing that frame to a <video>
// (which is what used to happen) is a broken element: the browser refuses an image
// as a media source, and its failed load ALSO lifted the loading shell — so the
// sender was left looking at a dead player until a refresh (reported: "a video
// uploaded just fails to render").
function attPendingStandIn(a) {
  return !!(a && a.scan === 'pending' && a.kind !== 'video' && attPendingPreview(a));
}
// The picked bytes, when they are a STAND-IN rather than the attachment's own
// file. Only the uploading browser's own copy qualifies: it is the one entry made
// from a File this page is holding (a blob url), plus any preview at all while the
// upload is still waiting on the slot. A clean attachment has no stand-in: its own
// bytes, and the derived preview of them, are what it renders, exactly as before
// this existed. PICTURES and VOICE NOTES only — a clip's entry is a still frame,
// which is its poster (see attVideoHTML / attPickedFrame), never a source.
function attShot(a) {
  if (!a || !a.url) return null;
  const hit = attPreviewEntry(a.id, a.url);
  if (!hit) return null;
  const picked = /^blob:/.test(String(hit.src || ''));
  const stand_in = picked || a.scan === 'pending';
  return stand_in ? { src: String(hit.src || '') } : null;
}
function setAttPreview(url, src, blob, bytes) {
  if (!url || !src) return false;
  const old = attPreviews.get(url);
  if (old && old.blob && old.src !== src) { try { URL.revokeObjectURL(old.src); } catch {} }
  if (old) attPreviewBytes -= old.bytes || 0;
  const entry = { id: '', url, src, blob: !!blob, bytes: blob ? (Number(bytes) || 0) : 0, unstagedAt: 0 };
  attPreviews.set(url, entry);
  attPreviewBytes += entry.bytes;
  evictAttPreviews();
  return true;
}
// The message-side registration. `id` is the attachment's own id once the upload
// answered (see xhr.onload); before that the url key is all there is, which is
// exactly what the composer chip asks for.
function setAttPreviewFor(a, src, blob, bytes) {
  const url = a && a.url;
  if (!url || !src) return false;
  const id = String((a && a.id) || '');
  const old = attPreviewEntry(id, url);
  if (old && old.blob && old.src !== src) { try { URL.revokeObjectURL(old.src); } catch {} }
  if (id && old && old.url && old.url !== url) attPreviews.delete(old.url);
  const entry = { id, url, src, blob: !!blob, bytes: blob ? (Number(bytes) || 0) : 0, unstagedAt: 0 };
  attPreviews.set(id || url, entry);
  if (id && url && url !== (id || url)) attPreviews.set(url, entry);
  if (old) attPreviewBytes -= old.bytes || 0;
  attPreviewBytes += entry.bytes;
  evictAttPreviews();
  return true;
}
function releaseAttPreview(url) {
  const hit = attPreviews.get(url);
  if (!hit) return;
  // One entry can be registered under two keys (id + url): retiring one of them
  // must not revoke the blob the other still points at.
  for (const [k, v] of [...attPreviews]) if (v === hit) attPreviews.delete(k);
  attPreviewBytes -= hit.bytes || 0;
  if (hit.blob) { try { URL.revokeObjectURL(hit.src); } catch {} }
}
// Retire a preview once the PUBLISHED bytes are what the element is loading: the
// entry keyed by the id AND the one the original url kept (the compressor
// republishes under a new ?v, so that key is stale from here on — leaving it
// would hand a revoked blob url to the next render).
function retireAttPreview(a, oldUrl) {
  try {
    const idKey = String((a && a.id) || '');
    const hit = attPreviewEntry(idKey, String((a && a.url) || '')) || (oldUrl ? attPreviews.get(oldUrl) : null);
    if (!hit) return;
    releaseAttPreview(hit.id || hit.url);
  } catch {}
}
function evictAttPreviews() {
  if (attPreviewBytes <= LOCAL_PREVIEW_CAP_BYTES) return;
  const done = new Set();
  for (const [k, v] of [...attPreviews]) {
    if (attPreviewBytes <= LOCAL_PREVIEW_CAP_BYTES) break;
    if (done.has(v)) continue;      // the same entry under its second key
    if (attPreviewStaged.has(k)) continue;  // still in a composer: never the victim
    done.add(v);
    releaseAttPreview(k);
  }
}
function thumbSrcFor(url) {
  const clean = String(url || '').split('?')[0];
  if (!/^\/uploads\/files\/[A-Za-z0-9._-]+$/.test(clean)) return '';
  return '/uploads/thumbs/' + clean.slice('/uploads/'.length) + '.webp';
}
function imageSrcFor(a) {
  const url = String((a && a.url) || '');
  const thumb = thumbSrcFor(url);
  if (!thumb) return '';
  const q = url.indexOf('?');
  return thumb + (q >= 0 ? url.slice(q) : '');
}
// …except for a picture whose whole point is that it MOVES. The derived preview
// is ONE WebP frame by construction (media-compress.js: `-frames:v 1`), so an
// animated source painted from it is a still picture — reported exactly that way:
// "a manually uploaded GIF doesn't autoplay, linked ones do." A Klipy GIF is an
// https url with no /uploads/ key behind it, so it never had a preview to be
// frozen by; an uploaded one always did. An animated attachment therefore skips
// the preview and renders its own bytes, which the browser animates on its own.
// The preview is still minted and still wanted by surfaces that ask for a STILL
// TILE (an inbox bookmark's thumbnails, security.js), which is why the server
// side is unchanged.
//
// GIF and APNG are what can be recognized from here without downloading the file
// (mime, else the stored extension): an animated WebP is indistinguishable from a
// still one until its bytes are read, and treating every WebP as animated would
// take the preview away from the far more common still one.
const ATT_ANIMATED_EXT_RE = /\.(gif|apng)$/i;
function attIsAnimated(a) {
  const mime = String((a && a.mime) || '').toLowerCase();
  if (mime === 'image/gif' || mime === 'image/apng') return true;
  return ATT_ANIMATED_EXT_RE.test(attCleanUrl(a && a.url));
}
// The attachment's OWN identity, on every element that represents it. The menus
// (desktop right-click, the phone's long-press sheet) resolve from the element
// the pointer is actually over, so a rendering that does not carry this is an
// attachment nothing can act on. `data-att-id` is what the attachment menus look
// up (and what the "Scan info" panel asks the server about); `data-fb-*` is
// the media identity the copy/save/link items and the lightbox already read.
// The scanning and infected CARDS carry it too — those are the ones a reader
// most wants explained, and they have no `.att-wrap` to inherit it from.
function attMeta(a, kind) {
  const k = kind || (a && a.kind) || 'file';
  return ` data-att-id="${esc((a && a.id) || '')}" data-fb-url="${esc((a && a.url) || '')}"`
    + ` data-fb-name="${esc((a && a.name) || '')}" data-fb-kind="${esc(k)}" data-fb-size="${esc((a && a.size) || 0)}"`
    + ` data-fb-scan="${esc((a && a.scan) || 'clean')}"`;
}
function attachmentHTML(a) {
  // Virus-scan states (see virus-scan.js): infected files render a greyed-out
  // warning — never the bytes, no preview, no download link anywhere. A PENDING
  // file is different when the uploading browser still holds the picked bytes:
  // the media renders from that local preview (the box is the final one's shape)
  // and NOTHING is painted over it — the picture the sender just picked stands on
  // its own, and the verdict lands on the element underneath without touching what
  // is on screen. (A "Processing" chip used to sit in the picture's corner; the
  // owner asked for it gone, and the pending state is already legible from the
  // composer's own chip and the missing download link.) Only a file with no local
  // preview to show — another device, a reload, a non-media upload, and a CLIP
  // (whose entry in the store is a still frame, not its bytes — see
  // attPendingStandIn) — falls back to the scanning card, which is a whole card
  // rather than an overlay and stays.
  if (a.scan === 'infected') return `<div class="scan-block infected"${attMeta(a)}><span class="scan-ic">${SCAN_SHIELD_SVG}</span><span class="scan-tx"><b>${esc(a.name)}</b><span>Virus detected — this file was removed and can't be downloaded.</span></span></div>`;
  const pending = a.scan === 'pending';
  const local = attPendingStandIn(a);
  if (pending && !local) return `<div class="scan-block scanning"${attMeta(a)}><span class="scan-tx"><b>${esc(a.name)} (${fmtSize(a.size)})</b><span>Processing file<span class="scan-dots"></span></span><span class="scan-track"><span class="scan-fill"></span></span></span></div>`;
  return `<span class="att-slot" data-att-slot="${esc(a.id || '')}">${attachmentBodyHTML(a)}</span>`;
}
// The attachment itself, whatever shape it takes. Split out so the suspicious
// marker can precede every one of them without four copies of the call.
function attachmentBodyHTML(a, opts) {
  // `live` (the default) means "the picked bytes are a valid stand-in while this
  // file waits on the slot". The verdict patch passes false: what it is building
  // is the FINAL rendering, and asking the preview store again would hand it the
  // very bytes it is replacing.
  const live = !opts || opts.live !== false;
  const shot = live ? attShot(a) : null;
  if (a.kind === 'image') {
    // data-fb-url is the ORIGINAL: the lightbox and the download link use it, and
    // it is where the preview falls back to. data-fb-thumb marks a src that may
    // still need that fallback. While the file is pending there is no download
    // link (see attDl) and `src` is the picked bytes when this browser still has
    // them — otherwise the derived preview, which is what a reader anywhere else
    // gets (see attPreviewEntry / attPendingPreview).
    const pending = a.scan === 'pending';
    const preview = shot ? shot.src : (pending ? attPreviewSrc(a) : '');
    // An animated source has no preview to paint: the derived one is a still
    // frame, and `src` then falls through to the attachment's own animating
    // bytes (see attIsAnimated). `thumb` empty also means no data-fb-thumb, so
    // a failure here degrades straight to the file card rather than asking for
    // the same still preview that was skipped.
    const thumb = (preview || attIsAnimated(a)) ? '' : imageSrcFor(a);
    // A known size reserves the box. It has to go on the WRAP rather than the
    // image: the wrap is shrink-to-fit, so the image's own max-width:100% has no
    // definite containing block to resolve against until the bytes arrive — the
    // percentage collapses to nothing and the reservation is worthless. The
    // width expression is the box the picture will end up in, the same one the
    // caps compute: no wider than the picture, the column, 420px, or the height
    // cap at this ratio. `.pin-atts` moves the height cap (see styles.css).
    const d = attDimsFor(a);
    const ar = d ? d.w / d.h : 0;
    const r = ar ? ar.toFixed(4) : '';
    const style = d ? ` style="--att-ar:${r};width:min(${d.w}px,100%,420px,calc(var(--att-max-h,320px) * ${r}))"` : '';
    // The wrap carries the attachment's own identity too (url/name/kind): the
    // long-press and right-click menus are opened on whatever the finger is
    // over, which is the wrap, the image, the download chip or the star — one
    // read from the wrap covers all of them (see attFromEl in actions.js).
    const meta = attMeta(a, 'image');
    return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}${d ? ' ar' : ' no-ar'}"${style}${meta}><span class="att-ph" aria-hidden="true"><span class="att-spin"></span></span><img class="att-img" draggable="false" src="${esc(preview || thumb || a.url)}" alt="${esc(a.name)}" loading="lazy" decoding="async"${d ? ` width="${d.w}" height="${d.h}"` : ''}${thumb ? ' data-fb-thumb="1"' : ''} data-fb-orig="${esc(a.url)}" data-fb-name="${esc(a.name)}" data-fb-url="${esc(a.url)}" />${attDl(a, pending)}${attFavHTML(a, pending)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  }
  if (a.kind === 'video') return attVideoHTML(a, opts);
  if (a.kind === 'audio') return audioPlayerHTML(a, opts);
  if (textPreviewable(a)) return textFileHTML(a);
  return attFileCardHTML(a);
}
// A clip is a PLAYER, and what the preview store holds for it is a FRAME — never
// the clip's own bytes (see videoPreviewShot / the upload path) — so the frame is
// the POSTER and is never a source: a <video> pointed at an image is a broken
// element whose failed load also lifts the loading shell, which is exactly the
// "uploaded and it just doesn't render" that got reported. A clip with no frame
// yet (another device, a reload, the capture still in flight) is parked behind
// the spinner shell until `requestVideoPoster` has one. data-fb-src is the
// published source the element receives the moment the verdict lands.
function attVideoHTML(a, opts) {
  const pending = a.scan === 'pending';
  const d = attDimsFor(a);
  const ar = d ? (d.w / d.h) : 0;
  const style = ar ? ` style="--att-ar:${ar.toFixed(4)}"` : '';
  const poster = (!opts || opts.live !== false) ? attPickedFrame(a) : '';
  return `<span class="att-wrap${poster ? '' : ' loading'}${a.spoiler ? ' spoiler' : ''}${ar ? ' ar' : ' no-ar'}"${style}${attMeta(a, 'video')}><video class="att-vid" draggable="false" src="${esc(a.url)}" data-fb-src="${esc(a.url)}" controls preload="metadata" playsinline${poster ? ` poster="${esc(poster)}"` : ''}></video><button type="button" class="att-vid-load" aria-label="Play video"><span class="att-spin"></span></button>${attDl(a, pending)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
}
// The still FRAME this page already holds for a clip, as the poster to paint it
// with — the upload path files the frame the upload card captured under the
// attachment's own url (see videoPreviewShot), so the sender's own clip shows its
// picture in the same tick the verdict lands instead of fetching one. The second
// source is the picked frame itself, which is what survives a republish under a
// new key (the compressor turning WebM into MP4) — the same fallback the patch
// borrows from. Only a captured frame qualifies: the clip's own bytes are not a
// poster, and a still picture is never a source.
function attPickedFrame(a) {
  if (!a || !a.url) return '';
  // The frame the upload path captured, filed under the url the upload answered
  // with — looked up the way the patch looks up the source on screen, because a
  // republish in place hands the attachment a fresh ?v= (see videoPosterFor).
  const shot = (typeof videoPosterFor === 'function') ? videoPosterFor(a.url) : '';
  if (/^data:/.test(String(shot || ''))) return String(shot);
  // Then the picked frame itself, which outlives the poster cache's 30 entries.
  const hit = attPreviewEntry(a.id, a.url);
  const picked = hit ? String(hit.src || '') : '';
  return /^data:/.test(picked) ? picked : '';
}
// The plain-file card, in ONE place. Two callers need it and they have to agree:
// the markup above for a file that never claimed to be a picture, and the
// document error handler (final.js) for a picture THIS browser cannot decode —
// an iPhone HEIC on Windows being the everyday case, since the bytes are fine
// and simply have no decoder here. That fallback used to build its own card with
// the name alone, which left a bare outlined box around a filename (reported:
// "the file name leaves the outline around it") with no icon, no size and no
// attachment identity — so the menus could not act on the file it was showing.
// Reusing the real card, `attMeta` included, makes the degraded rendering an
// ordinary file card.
function attFileCardHTML(a) {
  const att = a || {};
  const kind = att.kind || 'file';
  // A caller that does not know the size (the error handler on a rendering
  // that predates data-fb-size) says null and gets no size line, rather than a
  // "0 B" that would be a claim about the file.
  const sizeLine = att.size == null ? '' : `<br/><span class="fsize">${fmtSize(att.size)}</span>`;
  return `<a class="file-card" href="${esc(att.url)}" target="_blank" rel="noopener"${attMeta(att, kind)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span><span class="fname">${esc(att.name)}</span>${sizeLine}</span></a>`;
}
// ---------- one message's attachments, as ONE block ----------
// More than one PICTURE in a message is a gallery (see .msg-atts.gallery in
// styles.css): equal square tiles whose arrangement follows the count — 3 and 5
// are the counts that used to leave a hole in a plain two-column grid, which is
// the whole reason the count is a fact of the message and not a CSS guess (CSS
// can style a tile, but "one tall picture and two stacked beside it" is markup).
//
// Only when EVERY attachment is a picture: a clip, a voice note or a file keeps
// the full-width rendering it needs, and a tile grid holding one of those would
// either squeeze it or leave the hole this exists to avoid. A message carries at
// most five attachments (the composer's own cap, and the server slices the same
// way), so the layouts are the five below and nothing else.
function attsBlockHTML(list) {
  const atts = Array.isArray(list) ? list : [];
  const gallery = atts.length > 1 && atts.every((a) => (a && a.kind ? a.kind : 'file') === 'image');
  const cls = 'msg-atts' + (gallery ? ' gallery g' + Math.min(atts.length, 5) : '');
  return '<div class="' + cls + '">' + atts.map(attachmentHTML).join('') + '</div>';
}
// ---------- the pending -> final handover (no unload) ----------
// A verdict landing re-broadcasts the message with the attachment's final url
// (and, for a pending one, the fact that it is no longer pending). The list must
// NOT be rebuilt for that: a rebuild recreates every <img> and <video> on screen
// — the picture the reader just sent flickers back through its placeholder, and
// a clip that is already playing restarts. So a media attachment whose node can
// carry the change is patched where it stands, and a message with nothing to
// patch falls back to the ordinary render.
//
// Only the two things that cannot be done in place go back through the renderer:
// an attachment that appeared or went away (the slot list no longer lines up),
// and one whose KIND changed (a card became a picture — an unmeasurable HEIC
// becoming a JPEG, a picture this browser cannot decode). The shape has to match
// too: the pending box was reserved from the stored size, and the published
// bytes normally have exactly that size. When they do not, a full render lets
// the picture take its own shape instead of being squashed into a stale box.
function attApproxAr(w, h) {
  if (!(w > 0) || !(h > 0)) return 0;
  return w / h;
}
function attSameShape(oldAr, newAr) {
  const a = Number(oldAr) || 0;
  if (!(a > 0)) return true;        // nothing was reserved, nothing to defend
  if (!(newAr > 0)) return false;
  return Math.abs(a - newAr) / a <= 0.02;
}
// A clip whose frame was captured off the picked file, for the message that is
// already waiting on the slot (the frame's own capture is asynchronous, so it may
// land before — or after — the attachment exists; see uploadAndAttach/xhr.onload).
function videoPreviewShot(url, dataUrl) {
  if (!url || !dataUrl) return;
  try { if (!attPreviews.has(url)) setAttPreview(url, dataUrl, false); } catch {}
  try { rememberVideoPoster(url, dataUrl); } catch {}
}
// A clip from a preview this page still holds as a local blob: capture it, and
// once the frame is here the clip is registered under BOTH urls — the attachment
// that produced it (if it is not already registered) and the file it became.
function startVideoPreviewCapture(a, blobUrl) {
  whenVideoPoster(blobUrl, (shot) => {
    if (!shot) return;
    videoPreviewShot(a.url, shot);
    try { if (!attPreviewEntry(a.id, a.url)) setAttPreviewFor(a, shot, false); } catch {}
    renderComposerMeta();
  });
}
// The role an element plays, for the one case the patch has to refuse: a card
// that is about to become a picture (an unmeasurable HEIC turning into a JPEG)
// is not the same rendering, and only the renderer can build the new one.
const ATT_ROLE_SEL = {
  image: '.att-wrap .att-img',
  video: '.att-wrap video.att-vid',
  audio: '.vplayer',
  file: '.file-card',
  text: '.txtfile',
};
function attElementRole(el) {
  if (!el) return '';
  for (const [role, sel] of Object.entries(ATT_ROLE_SEL)) { try { if (el.matches(sel) || (el.querySelector && el.querySelector(sel))) return role; } catch {} }
  return '';
}
// One file, whatever url form it is written in: `currentSrc` is absolute and an
// attribute is usually relative, so both are cut down to the path that picks the
// object — and ?v=, which only busts caches, is dropped with it. Two renderings
// with the same path are the SAME picture (a blob and the upload it was made
// from, or an upload and its republish in place), which is what lets the patch
// leave the painted element alone.
function srcPathOf(u) {
  const s = String(u || '');
  const i = s.indexOf('/uploads/');
  return (i >= 0 ? s.slice(i) : s).split('?')[0];
}
// The frame a player already captured for a url, if any (see videoPosterCache).
function videoPosterShot(url) {
  try { return (url && typeof videoPosterCache !== 'undefined') ? (videoPosterCache.get(url) || null) : null; } catch { return null; }
}
// …and the same question for a url written differently. The upload path files the
// frame under the url the UPLOAD answered with, and the attachment comes back with
// a fresh ?v= the moment the compressor settles it in place (see srcPathOf: the
// cache-buster is not a different file, and the republished bytes are the same
// picture). So the exact key first, then any key naming the same file.
function videoPosterFor(url) {
  const exact = videoPosterShot(url);
  if (exact) return exact;
  const want = srcPathOf(url);
  if (!want || typeof videoPosterCache === 'undefined') return '';
  for (const [k, v] of videoPosterCache) { if (srcPathOf(k) === want) return v; }
  return '';
}
// The shape the box was RESERVED at, read off the node itself (the img's own
// width/height attributes) rather than from the cached message — the reserved box
// is what must keep matching, because that is what is on screen.
function attReservedAr(el) {
  try {
    const node = (el.matches && el.matches('img.att-img, video.att-vid')) ? el : (el.querySelector ? el.querySelector('img.att-img, video.att-vid') : null);
    if (!node) return 0;
    const w = Number(node.getAttribute('width')) || 0;
    const h = Number(node.getAttribute('height')) || 0;
    return (w > 0 && h > 0) ? w / h : 0;
  } catch { return 0; }
}
// Keep the frame the reader is looking at, and swap the element under it. What
// cannot be brought over in place (a rendering of a different role) goes back to
// the renderer instead.
function patchAttachmentNode(oldEl, a) {
  if (!oldEl || !a) return false;
  // An infected verdict is not a patch at all: the server has DELETED the bytes, so
  // the rendering has to become the warning card, which only the renderer builds.
  // Left to the `!clean` line below an unchanged url returned "nothing to move" and
  // the reader went on looking at a picture of a file that was removed.
  if (a.scan === 'infected') return false;
  const clean = a.scan !== 'pending' && a.scan !== 'infected';
  const newRole = a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : a.kind === 'audio' ? 'audio' : (textPreviewable(a) ? 'text' : 'file');
  const oldRole = attElementRole(oldEl);
  // The photo the reader sent arrives as 'image' both times; a scan card standing
  // in for something with no local preview is the renderer's to replace.
  if (oldRole !== newRole) return false;
  // The pending box was reserved from the stored size and the published bytes
  // normally have exactly that size. When they do not (a re-encode that changed
  // the aspect), let the renderer reshape it instead of squashing the picture.
  const oldAr = attReservedAr(oldEl);
  const newAr = attApproxAr(Number(a.w) || 0, Number(a.h) || 0);
  if (!attSameShape(oldAr, newAr)) return false;
  const oldSrc = oldEl.getAttribute('data-fb-orig') || oldEl.getAttribute('data-fb-url') || '';
  if (oldSrc === String(a.url || '') && !clean) return true;  // nothing to move yet
  if (newRole === 'image') return patchImageNode(oldEl, a);
  if (newRole === 'video') return patchVideoNode(oldEl, a);
  if (newRole === 'audio') return patchAudioNode(oldEl, a);
  return false;
}
// A still: the wrap is REBUILT from the real markup — that is what carries the
// published url, the download link, the star and the reserved shape, all built by
// attachmentBodyHTML itself so a patched row can never drift from a rendered one
// — while the frame the reader is ALREADY LOOKING AT stays on screen (absolutely
// positioned over the new box) until the new bytes paint. Same picture, so
// nothing moves and nothing blinks.
//
// The element is only replaced when the thing it is SHOWING changes. A photo the
// compressor settled by rewriting the same key comes back as the same thumbnail
// with a fresh `?v=` (the bytes on disk are the same file), and re-pointing the
// <img> at it would throw away the painted frame and decode it again — the flash
// this whole path exists to remove. Only the identity moves then (data-fb-url /
// data-fb-orig, which the lightbox and the menus read); the painted picture is
// left exactly as it is.
function patchImageNode(oldEl, a) {
  const wrap = oldEl.closest && oldEl.closest('.att-wrap');
  if (!wrap) return false;
  const oldImg = oldEl.querySelector ? oldEl.querySelector('img.att-img') : null;
  const box = document.createElement('div');
  // `live:false`: this is the FINAL rendering. Asking the preview store again
  // would hand back the picked bytes that are being replaced.
  box.innerHTML = attachmentBodyHTML(a, { live: false });
  const nextWrap = box.firstElementChild;
  const img = nextWrap && nextWrap.querySelector('img.att-img');
  if (!img) return false;
  // The url the element is showing NOW (its own bytes, not the preview stand-in):
  // the store still holds an entry under it, and it dies with the swap below.
  const oldUrl = String(oldEl.getAttribute('data-fb-orig') || oldEl.getAttribute('data-fb-url') || '');
  // One file, whatever url form it is written in: currentSrc is absolute and an
  // attribute is usually relative, and ?v= only busts caches.
  const shownPath = srcPathOf(oldImg && (oldImg.currentSrc || oldImg.getAttribute('src')));
  const wantPath = srcPathOf(img.currentSrc || img.getAttribute('src'));
  // Is the new rendering the SAME FILE the element is already showing? A blob and
  // the published upload of it — or an upload and its republish-in-place under a
  // fresh ?v= — are one picture. Showing the freshly parsed element then would
  // throw the painted frame away and decode the same bytes again, which is the
  // blink this path exists to remove. So nothing is re-pointed: the element the
  // reader is looking at is MOVED into the new box (which brings the reserved
  // shape and the download link that arrived with the verdict), and only the
  // identity the menus and the lightbox read (data-fb-url) is updated.
  if (oldImg && oldImg.dataset.phWired && shownPath && shownPath === wantPath) {
    nextWrap.classList.add('ready');
    oldEl.setAttribute('data-fb-url', String(a.url || ''));
    oldEl.setAttribute('data-fb-scan', String(a.scan || 'clean'));
    // The element carries the identity too (the menus and the broken-image
    // fallback read it off the img): moving it without these would leave the row
    // pointing at the url it was published FROM.
    if (oldImg.dataset.fbOrig) oldImg.dataset.fbOrig = String(a.url || '');
    if (oldImg.dataset.fbUrl) oldImg.dataset.fbUrl = String(a.url || '');
    const at = nextWrap.querySelector('.att-ph');
    if (at) at.after(oldImg); else nextWrap.insertBefore(oldImg, nextWrap.firstChild);
    if (wrap.isConnected) wrap.replaceWith(nextWrap); else oldEl.replaceWith(nextWrap);
    try { observeStick(oldImg); } catch {}
    if (a.scan === 'clean') retireAttPreview(a, oldUrl);
    return true;
  }
  // A DIFFERENT file. The freshly built picture has no bytes yet, and an inserted
  // <img> is either blank or a broken-image box until it has them — the flash this
  // path exists to remove. The hook for that is already in the markup and the
  // stylesheet: the wrap is NOT `ready`, so `.att-ph` covers it and
  // `.att-wrap.pending:not(.ready) img.att-img` holds the picture at opacity 0. So
  // the new picture is put in DARK, behind its own placeholder, and the placeholder
  // only stands down once those bytes have actually decoded:
  //   . the frame that is on screen is carried into the new box as an absolutely
  //     positioned overlay, so the reader's picture never leaves the page;
  //   . the new <img> loads normally behind the placeholder (its `src` is the real
  //     one from the start — an <img> with no source at all is a broken-image box);
  //   . when it loads, `ready` goes on and the overlay goes, in the same tick.
  const rawSrc = String(img.getAttribute('src') || '');
  let held = null;
  try {
    // What has to be carried is "the frame that is ON SCREEN", whatever put it
    // there — this browser's own picked bytes, or the original file's derived
    // preview, which is every reader who did not upload the file (and the
    // uploading browser too, once its picked copy has been retired). So the test
    // is the ELEMENT's own state, not the store's: it must have painted real
    // bytes (carrying a node that never loaded would park a blank box behind
    // `.att-swap`), and it must not already be showing the incoming file.
    if (oldImg && oldImg.complete && oldImg.naturalWidth > 0 && oldImg.getAttribute('src') !== rawSrc) {
      held = oldImg;
      oldImg.classList.add('att-held');
      // The carried frame is the one thing that must stay VISIBLE while the new
      // bytes load (and the placeholder over it is switched off for the same
      // reason, see `.att-swap`).
      oldImg.style.setProperty('z-index', '3');
      oldImg.style.setProperty('opacity', '1', 'important');
    }
  } catch {}
  const live = wrap.isConnected;
  // While the published bytes load, NOTHING may paint in this box but the frame
  // the reader already has: the placeholder is switched off for the duration
  // (`.att-swap`), the new picture is held dark behind it, and the carried frame
  // sits on top at z-index 3. Without this the placeholder itself is what the
  // reader sees — a dark panel (or, before this, a blank box) where their photo
  // was, for as long as the fetch takes.
  nextWrap.classList.add('att-swap');
  if (live) wrap.replaceWith(nextWrap);
  else oldEl.replaceWith(nextWrap);
  if (held) {
    try {
      const at = nextWrap.querySelector('.att-ph');
      if (at) at.after(held); else nextWrap.insertBefore(held, nextWrap.firstChild);
    } catch {}
  }
  let settled = false;
  const reveal = () => {
    if (settled) return;
    if (!(img.complete && img.naturalWidth > 0)) return;
    settled = true;
    img.dataset.phWired = '1';
    nextWrap.classList.remove('att-swap');
    nextWrap.classList.add('ready');
    if (held) { try { held.remove(); } catch {} held = null; }
    try { observeStick(img); } catch {}
    if (a.scan === 'clean') retireAttPreview(a, oldUrl);
  };
  img.addEventListener('load', reveal, { once: true });
  img.addEventListener('error', () => {
    // The bytes are not coming. The document error handler owns the fallback (the
    // original upload, then the degraded card); what must NOT happen here is an
    // empty box, so the placeholder is put back — or, when there is a frame the
    // reader already has, that frame is left exactly where it is.
    if (settled) return;
    settled = true;
    if (!held) { nextWrap.classList.remove('att-swap'); nextWrap.classList.add('ready'); }
    try { observeStick(img); } catch {}
    if (a.scan === 'clean') retireAttPreview(a, oldUrl);
  }, { once: true });
  img.loading = 'eager';
  // The source goes in before the swap so the fetch is already running, and the
  // element is dark from the moment it lands.
  img.setAttribute('src', rawSrc);
  if (img.complete) reveal();
  return true;
}
// A clip: the player is REPLACED (its own controls and poster state belong to the
// element), wired exactly as a freshly rendered one would be, and the poster we
// already captured is filed under the final URL so it paints without a download.
function patchVideoNode(oldEl, a) {
  const oldVid = oldEl.querySelector ? oldEl.querySelector('video.att-vid') : null;
  if (!oldVid) return false;
  const oldUrl = String(oldEl.getAttribute('data-fb-url') || '');
  // The same file behind a fresh ?v= — the everyday "the compressor settled it in
  // place": the player is left completely alone (a replaced <video> restarts, and
  // its poster would have to be captured again), and only the identity moves.
  const sameFile = !!srcPathOf(oldVid.getAttribute('src')) && srcPathOf(oldVid.getAttribute('src')) === srcPathOf(a.url);
  if (sameFile) {
    const shot = videoPosterShot(oldVid.getAttribute('src'));
    oldEl.setAttribute('data-fb-url', String(a.url || ''));
    oldEl.setAttribute('data-fb-scan', String(a.scan || 'clean'));
    oldVid.dataset.fbSrc = String(a.url || '');
    if (shot) { try { rememberVideoPoster(a.url, shot); } catch {} }
    if (a.scan === 'clean') retireAttPreview(a, oldUrl);
    return true;
  }
  const box = document.createElement('span');
  box.innerHTML = attVideoHTML(Object.assign({}, a, { scan: 'clean' }), { live: false });
  const wrap = box.firstElementChild;
  const nextVid = wrap && wrap.querySelector('video.att-vid');
  if (!nextVid) return false;
  // The frame the reader is already looking at has to come with the replacement,
  // or the new player is a black panel with a spinner in it until the clip's own
  // first frame can be captured — the same disappear-and-return the still path
  // refuses. Two sources, best first: the poster this page captured for the source
  // on screen, then the picked FRAME the upload registered (a data URL — never the
  // clip's own bytes; see startVideoPreviewCapture), which stands for the
  // re-encoded file just as well because it is the same picture.
  let shot = null;
  if (oldVid.dataset.posterOk === '1') {
    const oldSrc = oldVid.currentSrc || oldVid.getAttribute('src') || '';
    shot = videoPosterShot(oldSrc) || videoPosterShot(oldVid.getAttribute('src'));
  }
  if (!shot) {
    const prev = attPreviewEntry(String(a.id || ''), oldUrl);
    if (prev && /^data:/.test(String(prev.src || ''))) shot = String(prev.src);
  }
  if (shot) { try { rememberVideoPoster(a.url, shot); } catch {} nextVid.poster = shot; nextVid.dataset.posterOk = '1'; }
  try { oldVid.pause(); } catch {}
  oldEl.replaceWith(wrap);
  // With the frame already in hand there is nothing left to wait for, so the
  // loading shell has to come off in the same tick: `attVideoHTML` parks every
  // fresh player behind it (hidden element + spinner panel), and leaving it there
  // while `posterOk` short-circuits requestVideoPoster below is a clip that never
  // reveals itself until the reader clicks the panel.
  if (nextVid.dataset.posterOk === '1') { try { revealVideoShell(nextVid); } catch {} }
  try { requestVideoPoster(nextVid); observeStick(nextVid); } catch {}
  // The published bytes are the source now, so the picked copy can be released
  // once the new element has read its metadata (a beat later, not before).
  if (a.scan === 'clean') {
    const drop = () => { retireAttPreview(a); };
    nextVid.addEventListener('loadedmetadata', drop, { once: true });
    nextVid.addEventListener('error', drop, { once: true });
    setTimeout(drop, 2000);
  }
  return true;
}
// Audio: the player's chrome, volume and (if it is playing) its position are
// worth keeping, so only the <audio> source moves. Replacing the whole player
// restarts a voice note mid-sentence for a change that is only ever "the final
// bytes are here now".
function patchAudioNode(oldEl, a) {
  const el = oldEl.classList && oldEl.classList.contains('vplayer') ? oldEl : (oldEl.querySelector ? oldEl.querySelector('.vplayer') : null);
  const audio = el && el.querySelector('audio');
  if (!audio) return false;
  audio.dataset.fbSrc = String(a.url || '');
  audio.src = String(a.url || '');
  try { audio.load(); } catch {}
  // The player keeps its position and its chrome; the picked bytes are no longer
  // needed once the published source is what it is loaded with.
  if (a.scan === 'clean') retireAttPreview(a);
  return true;
}
// Patch one message's attachments where they stand. Returns false when ANY of
// them needs the renderer (see the note above) — a half-patched message is worse
// than a rebuilt one, and settling that is the caller's job.
function patchAttachmentsIn(node, m) {
  const atts = (m && m.attachments) || [];
  if (!node) return false;
  const slots = node.querySelectorAll('.msg-atts > .att-slot');
  if (slots.length !== atts.length) return false;
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    const slot = slots[i];
    if (String(slot.getAttribute('data-att-slot') || '') !== String(a.id || '')) return false;
    const mb = slot.querySelector(':scope > .att-wrap, :scope > .vplayer, :scope > .file-card, :scope > .txtfile');
    if (!mb) return false;
    const kind = mb.getAttribute('data-fb-kind') || '';
    if (kind !== (a.kind || 'file')) return false;
    // An infected verdict cannot be patched in place at all: the server DELETED the
    // bytes, so the rendering has to become the warning card, which only the
    // renderer builds. (The `!clean` skip below is for a file still waiting on the
    // slot: its picked bytes are on screen, and the verdict that settles it is
    // applied by the patch itself.)
    if (a.scan === 'infected') return false;
    const clean = a.scan !== 'pending' && a.scan !== 'infected';
    if (clean) {
      // Not an in-place change: the attachment is already what it will be, and
      // rewriting it here would only lose playback state.
      if ((mb.getAttribute('data-fb-url') || '') === String(a.url || '')) continue;
      if (!patchAttachmentNode(mb, a)) return false;
    }
    slot.setAttribute('data-att-slot', String(a.id || ''));
  }
  return true;
}
// The one question the socket handlers ask: can this update be applied to the
// list where it stands? A message can be on screen TWICE (a channel and an open
// thread panel showing the same row), so every node for it is patched, and the
// answer is false — meaning "rebuild it" — unless all of them took the change.
// `paint` is the caller's own repaint, used for the containers that could not be
// patched; the fallback is per-container so a patched list is never rebuilt.
function patchMessageAttachmentsInList(mid, next, paint) {
  try {
    if (!next || !(next.attachments || []).length) return false;
    const sel = '.msg[data-mid="' + CSS.escape(String(mid)) + '"]';
    const nodes = [...document.querySelectorAll('#messages ' + sel), ...document.querySelectorAll('#thread-replies ' + sel)];
    if (!nodes.length) return false;
    const byBox = new Map();
    for (const node of nodes) {
      const box = node.closest('#thread-replies') ? '#thread-replies' : '#messages';
      if (!byBox.has(box)) byBox.set(box, []);
      byBox.get(box).push(node);
    }
    for (const [box, list] of byBox) {
      let ok = true;
      for (const node of list) { if (!patchAttachmentsIn(node, next)) { ok = false; break; } }
      if (!ok && typeof paint === 'function') paint(box);
    }
    return true;
  } catch { return false; }
}
// Is this message's row on screen anywhere — the channel list or an open thread?
// (The patch above answers "did the change land"; this answers "is there a node
// at all", which is what tells a socket handler whether the list still has to be
// rendered for a message it just cached.)
function messageAttachmentsOnScreen(mid) {
  try {
    const sel = '.msg[data-mid="' + CSS.escape(String(mid)) + '"]';
    return !!(document.querySelector('#messages ' + sel) || document.querySelector('#thread-replies ' + sel));
  } catch { return false; }
}
// ---------- resync: cards still saying "Processing" after a missed push --------
// A verdict reaches the reader as a LIVE push (message-updated / dm-updated).
// That push is gone forever if the socket was down when it fired — a deploy
// restarts the app, a phone loses signal, a laptop sleeps — and the reader is
// left looking at "Processing file" for a file that has been ready for hours,
// with no way out but a reload. The list itself is deliberately NOT refetched on
// reconnect (that would cost the reader their place in the conversation), so
// this asks about exactly the messages STILL showing a scanning card and patches
// them where they stand through the same in-place path the pushes use. In the
// common case there is nothing pending, and the whole thing costs one DOM query
// and not a single request.
async function resyncPendingMedia() {
  if (!S.me || !store.token) return;
  const byMid = new Map();
  try {
    for (const el of document.querySelectorAll('#messages .scan-block.scanning[data-att-id], #thread-replies .scan-block.scanning[data-att-id]')) {
      const mid = ((el.closest('.msg') || {}).dataset || {}).mid;
      if (!mid) continue;
      if (!byMid.has(mid)) byMid.set(mid, []);
      byMid.get(mid).push(el);
    }
  } catch { return; }
  if (!byMid.size) return;
  // Which list these came from decides which twin to ask — the same one the two
  // socket handlers answer for.
  const dm = S.view === 'home';
  for (const [mid, cards] of byMid) {
    let message = null;
    try {
      const r = await api(dm ? `/api/dms/messages/${encodeURIComponent(mid)}` : `/api/messages/${encodeURIComponent(mid)}`);
      message = r && r.message;
    } catch { continue; } // deleted, or no longer ours to read: nothing to patch
    if (!message || !message.id) continue;
    // Only a card that actually MOVED is worth touching. A re-read that still
    // reports the very same bytes as pending means the slot is genuinely still
    // working — and patching then would rebuild the whole list (a scanning card
    // is not an `.att-slot`, so the in-place patch declines it, see
    // patchAttachmentsIn) to change nothing at all.
    const moved = cards.some((el) => {
      const a = (message.attachments || []).find((x) => String(x.id || '') === String(el.dataset.attId || ''));
      return !a || a.scan !== 'pending' || String(a.url || '') !== String(el.dataset.fbUrl || '');
    });
    if (!moved) continue;
    updateMsgInCaches(message.id, (old) => Object.assign(old, message));
    patchMessageAttachmentsInList(message.id, message, () => { if (dm) renderDmMessages(); else renderMessages(); });
  }
}
// ---------- video posters: desktop shows the first frame natively, but the
// Android WebView shows a black box + giant play button until playback
// starts. Capture a frame offscreen once per video URL and set it as the
// poster thumbnail so every platform previews the same. Same-origin
// uploads, so the canvas is never tainted.
const videoPosterCache = new Map(); // url -> dataURL thumbnail
const videoPosterWaiters = new Map(); // url -> [callback(shot|null)]
// Poster must be at least as large as the rendered box: the poster defines the
// element's intrinsic size while paused, so a smaller poster shrinks the box
// and playback grows it again. 640px covers the 420px wrap with no upscale.
// (Deliberately no width/height attributes: they clamp each axis independently
// against the max-width/max-height caps and letterbox the frame.)
// The wrap starts life with `.loading`: mobile browsers paint their own grey
// play-button placeholder into an unstarted <video>, which reads as broken
// until the poster frame lands. Hide the element behind a spinner instead and
// reveal it with the poster (or the native preview if the capture fails).
function revealVideoShell(v) {
  try { const wrap = v && v.closest && v.closest('.att-wrap'); if (wrap) wrap.classList.remove('loading'); } catch {}
}
// Capture can outlast the reader's patience on a big file, so the overlay is a
// button (and the play affordance it replaced): tapping or pressing it reveals
// the element and starts playback.
function wireVideoLoader(v) {
  if (!v || v.dataset.loadWired) return;
  const wrap = v.closest && v.closest('.att-wrap');
  const load = wrap && wrap.querySelector('.att-vid-load');
  if (!load) return;
  v.dataset.loadWired = '1';
  load.addEventListener('click', (e) => {
    if (e && e.preventDefault) e.preventDefault();
    revealVideoShell(v);
    try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch {}
  });
}
function applyVideoPoster(v, img) {
  if (!v || !img) return;
  try { v.poster = img; } catch {}
  v.dataset.posterOk = '1';
  revealVideoShell(v);
}
// One frame per URL, captured once and shared by every caller — the chat
// poster, the composer chip thumbnail, the upload card. cb(shot|null).
function whenVideoPoster(url, cb) {
  if (!url) { if (cb) cb(null); return; }
  if (videoPosterCache.has(url)) { if (cb) cb(videoPosterCache.get(url)); return; }
  let list = videoPosterWaiters.get(url);
  if (!list) { list = []; videoPosterWaiters.set(url, list); startVideoPosterCapture(url); }
  if (cb) list.push(cb);
}
// A frame we already hold, filed under a SECOND url. A clip that was uploaded in
// this session has its poster captured off the local preview before the slot
// publishes the bytes, and the published file is the same picture — so the frame
// is handed to the final url too, and the player that swaps to it never starts a
// download just to redraw a poster it already has.
function rememberVideoPoster(url, shot) {
  if (!url || !shot || videoPosterCache.has(url)) return;
  if (videoPosterCache.size > 30) { try { videoPosterCache.delete(videoPosterCache.keys().next().value); } catch {} }
  videoPosterCache.set(url, shot);
}
function startVideoPosterCapture(url) {
  const tmp = document.createElement('video');
  tmp.muted = true; tmp.playsInline = true; tmp.preload = 'auto'; tmp.src = url;
  let done = false;
  const finish = (shot) => {
    if (done) return; done = true;
    try { tmp.pause(); tmp.removeAttribute('src'); tmp.load(); } catch {}
    const waiters = videoPosterWaiters.get(url) || [];
    videoPosterWaiters.delete(url);
    if (shot) {
      if (videoPosterCache.size > 30) { try { videoPosterCache.delete(videoPosterCache.keys().next().value); } catch {} }
      videoPosterCache.set(url, shot);
    }
    waiters.forEach((fn) => { try { fn(shot || null); } catch {} });
  };
  tmp.addEventListener('loadeddata', () => {
    try { tmp.currentTime = Math.min(0.5, (tmp.duration || 1) / 3) || 0.1; }
    catch { finish(null); }
  }, { once: true });
  tmp.addEventListener('seeked', () => {
    try {
      if (!tmp.videoWidth) { finish(null); return; }
      const w = 640, h = Math.max(1, Math.round((w * tmp.videoHeight) / tmp.videoWidth));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(tmp, 0, 0, w, h);
      finish(c.toDataURL('image/jpeg', 0.8));
    } catch { finish(null); }
  }, { once: true });
  tmp.addEventListener('error', () => finish(null), { once: true });
  setTimeout(() => finish(null), 8000);
}
function ensureVideoPoster(v) {
  if (!v || v.dataset.posterOk) return;
  const url = v.currentSrc || v.src;
  if (!url) return;
  wireVideoLoader(v);
  whenVideoPoster(url, (shot) => {
    if (shot) applyVideoPoster(v, shot);
    else { v.dataset.posterOk = '1'; revealVideoShell(v); }
  });
}
// Capturing a poster frame costs a real fetch of the clip (the temp element
// seeks into the file), so it waits until the video is about to be seen instead
// of starting one download per clip in a channel's backlog — opening a busy
// channel used to fire a video fetch for every video on the page, which is the
// same slow-link problem the image previews solve. One observer for the whole
// document; a clip already near the viewport captures on the first callback,
// and without IntersectionObserver the old eager path stands.
let posterIO = null;
function requestVideoPoster(v) {
  if (!v || v.dataset.posterOk || v.dataset.posterWanted) return;
  if (typeof IntersectionObserver !== 'function') { ensureVideoPoster(v); return; }
  v.dataset.posterWanted = '1';
  if (!posterIO) {
    posterIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        try { posterIO.unobserve(e.target); } catch {}
        if (e.target.isConnected) ensureVideoPoster(e.target);
      }
    }, { rootMargin: '320px 0px' });
  }
  try { posterIO.observe(v); } catch { ensureVideoPoster(v); }
}
// ---------- stick-to-bottom on media resize ----------
// A video can change size more than once: no intrinsic size until metadata
// loads, the poster-to-frame swap, and some WebViews relayout again when
// playback starts. If the user is sitting at the bottom, stay pinned
// through all of it instead of stranding the view mid-video.
let stickRO = null;
const stickH = typeof WeakMap !== 'undefined' ? new WeakMap() : new Map(); // target -> last seen height
// Explicit "the reader is pinned to the live bottom" state, per scroll box.
// Distance-from-bottom is only a snapshot of the current layout: when media
// finishes loading while the page isn't rendering at all (background tab,
// deferred lazy images), after the bottom hold has expired, or between a
// restore and the images that follow it, the geometry reads "scrolled up" even
// though the reader never scrolled — believing that is what strands people
// hundreds of px up with the Jump-to-present pill as their only way back.
// So the flag only changes when someone *asks*: the reader's own scrolling, or
// a placement we make on their behalf ('1' pinned, '0' an anchor restore).
//
// Being NEAR the bottom is not being ON it. Promoting a reader to the pin takes
// them actually arriving — a wheel notch or a flick lands a few px short of the
// clamp, which is still the bottom — while the 200px band only ever KEEPS a pin
// that already exists, so a picture landing above a reader who is following the
// tail cannot strand them. Promoting from the band was the "scrolling down
// nearly to the bottom glitches you to the bottom" report: the pin was handed
// out 200px early, and the next scroll event of the reader's own gesture (or a
// stray one from the browser's anchoring under late media) was read as "hold
// the bottom", finishing the scroll for them.
const AT_BOTTOM_PX = 4; // a landing short of the clamp is still a landing
function markBottomState(box) {
  try {
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
    const at = dist <= AT_BOTTOM_PX || (box.dataset.atBottom === '1' && dist < 200);
    box.dataset.atBottom = at ? '1' : '0';
  } catch {}
}
// "Is the reader still on the live bottom?" — the question every repaint and
// every resize asks before it follows the tail instead of holding the reader's
// place. An explicit demotion ('0', written only by the reader's own upward
// movement) is FINAL until they come back down; the 200px band is inference,
// for a box nothing has seeded yet, and letting it overrule a deliberate
// scroll-up is what drags a reader back down a wheel notch at a time (see
// watchBottomState). `sameCtx` is false for a box still showing another
// conversation, whose flag is not this list's to trust.
function nearLiveBottom(box, sameCtx = true) {
  try {
    if (!box) return false;
    const at = sameCtx ? box.dataset.atBottom : undefined;
    if (at === '0') return false;
    if (at === '1') return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  } catch { return false; }
}
// Programmatic placement. Records where we put the box so the scroll listener
// can tell our own moves (bottom holds, anchor restores, jumps) apart from the
// reader's — only theirs may un-pin the view. `intent` states the resulting
// pin state outright instead of inferring it from a layout we're mid-way through.
function setScrollTop(box, v, intent) {
  try {
    box.scrollTop = v;
    box._autoTop = box.scrollTop; // the clamped value our own scroll event will report
    box._lastTop = box.scrollTop; // ...and the baseline the reader's next move is read against
    if (intent) box.dataset.atBottom = intent;
    // A placement is a decision about where the reader should be: the line guard
    // takes it as the new truth instead of correcting back towards the old one.
    // Every placement re-baselines — including the ones made while a pinned
    // reader is being held at the bottom, or the baseline would still be the one
    // from before they scrolled up.
    if (box._lineReset) box._lineReset();
  } catch {}
}
// ---------- hold a scrolled-up reader's place across layout changes ----------
// A chat list changes height under the reader all the time, and every one of
// those changes is something they did not ask for: a clip's metadata landing
// (the box is the element's default 300x150 until then — a video is the one
// attachment whose size is never recorded, see uploadDims), a picture's bytes
// arriving, a reaction bar appearing on the message under their eye, a link
// embed resolving, the paging status row sliding in and out.
//
// Chromium's own scroll anchoring does NOT cover this: it only promises that the
// topmost node it picks keeps its position, so when that node is the one that
// GROWS everything below it slides under the reader and nothing compensates
// (measured: a clip's metadata moved the messages 86px with the scroll offset
// untouched). WebKit/Safari has no scroll anchoring at all, so there every
// change above the viewport slides them. Either way the reader who notices is
// the one who scrolled up — "when I scroll up a couple of messages it glitches
// me upwards".
//
// So hold the place here, off a reference the reader can see: the last message
// whose top is still inside the viewport. Scrolling cannot change that
// reference's screen position (the view and the reference travel together), so
// only a box above it changing size can — and restoring its offset is therefore
// exactly "do not move the reader". It is a no-op wherever the browser already
// compensated (the measurement is the truth, so the two can never double up),
// and the bottom pin keeps ownership of a reader who is ON the live bottom.
function pickLineRef(box) {
  try {
    const btop = box.getBoundingClientRect().top, cut = btop + box.clientHeight;
    let last = null;
    for (const el of box.querySelectorAll('.msg')) {
      if (el.getBoundingClientRect().top >= cut) break;
      last = el;
    }
    return last;
  } catch { return null; }
}
function armLineGuard(box) {
  try {
    if (!box || box._lineGuard) return;
    box._lineGuard = true;
    // What is held is the reference's place ON SCREEN. The reader's own
    // scrolling moves that by design, so their scroll re-baselines it (and a
    // programmatic placement does too); what is left is a change they did not
    // ask for, and the correction is measured against it rather than against a
    // predicted size — which is why it can never double up with the browser's
    // own anchoring: where Chromium already held the line, there is nothing
    // left to restore.
    const state = { mid: null, off: 0, raf: 0 };
    const offOf = (el) => (el ? el.getBoundingClientRect().top - box.getBoundingClientRect().top : null);
    const reset = () => {
      // The reference usually survives a placement (a rebuild replaces the node
      // with the same id), so only re-walk the list when it is really gone.
      let el = state.mid ? box.querySelector('.msg[data-mid="' + CSS.escape(state.mid) + '"]') : null;
      if (!el) { el = pickLineRef(box); state.mid = el ? (el.dataset.mid || null) : null; }
      const off = offOf(el);
      state.off = off == null ? 0 : off;
    };
    const check = () => {
      state.raf = 0;
      try {
        if (!box.isConnected || box.classList.contains('hidden') || box._jumpHold) return;
        if (nearLiveBottom(box)) { reset(); return; } // the pin owns the bottom
        const el = state.mid ? box.querySelector('.msg[data-mid="' + CSS.escape(state.mid) + '"]') : null;
        if (!el) { reset(); return; }
        const off = offOf(el);
        if (off == null) return;
        const d = off - state.off; // how far the reader's line slid under them
        if (Math.abs(d) > 0.5) setScrollTop(box, box.scrollTop + d, '0');
      } catch {}
    };
    box._lineReset = reset;
    box._lineCheck = () => {
      // One check per frame, however many mutations and resizes land together.
      try { if (!state.raf) state.raf = requestAnimationFrame(check); } catch {}
    };
    // The reader's own scrolling re-baselines the line (they moved the view on
    // purpose). A scroll the BROWSER made to hold their place must not: it left
    // the line exactly where it was, and re-baselining there would swallow a
    // growth that landed in the same handful of milliseconds as a wheel notch.
    box.addEventListener('scroll', () => {
      if (box._jumpHold) return;
      if (box._scrollPointer != null || Date.now() - (box._userScrollAt || 0) < 900) reset();
    }, { passive: true });
    // Not every late growth fires a DOM mutation (an image's bytes landing, a
    // clip's metadata) — the media ResizeObserver calls in too (see observeStick).
    // Attributes are watched because that is how a box changes class
    // (`pending` -> `ready`) on its way to its final size.
    try {
      new MutationObserver(() => box._lineCheck())
        .observe(box, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
    } catch {}
    reset();
  } catch {}
}

function watchBottomState(box) {
  if (!box || box.dataset.atBottomWatch) return;
  box.dataset.atBottomWatch = '1';
  // Input proves the reader is driving, a scroll event does not. The box also
  // scrolls on its own: browsers restore a scroll offset on reload, layout
  // clamps scrollTop when the viewport shrinks (composer grows, call stage
  // opens), and native scroll anchoring rewrites it under late media. Reading
  // any of those as "the reader scrolled up" is how a pinned view gets
  // stranded partway up the history with the Jump-to-present pill as the only
  // way back — so only wheel/touch/drag/keyboard input may un-pin it.
  // `up` is the direction of the reader's OWN input when it has one, which is
  // not the same thing as the direction the box moved: native scroll anchoring
  // rewrites scrollTop under late media (a picture growing above the viewport
  // adds its own height to scrollTop), so a notch UP can reach the scroll
  // handler looking exactly like a move DOWN. Input is the only trustworthy
  // statement of intent, so record it where it exists.
  const noteUser = (up) => {
    box._userScrollAt = Date.now();
    // Booleans only: the listeners with no direction to report are wired
    // straight to this function, and their Event must not pass for one.
    if (typeof up === 'boolean') box._userUp = up;
  };
  box.addEventListener('wheel', (e) => { noteUser(e.deltaY ? e.deltaY < 0 : undefined); }, { passive: true });
  box.addEventListener('touchstart', (e) => {
    box._touchY = (e.touches && e.touches[0]) ? e.touches[0].clientY : null;
    noteUser();
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : null;
    // A finger travelling DOWN pulls the content down with it: scrolling up the
    // history.
    if (y != null && box._touchY != null && Math.abs(y - box._touchY) > 3) noteUser(y > box._touchY);
    else noteUser();
    if (y != null) box._touchY = y;
  }, { passive: true });
  box.addEventListener('keydown', noteUser, { passive: true });
  box.addEventListener('focusin', noteUser, { passive: true });
  box.addEventListener('pointerdown', (e) => { box._scrollPointer = e.pointerId; }, { passive: true });
  // Dragging inside the box (scrollbar thumb, text selection) only counts once
  // the pointer actually moves with a button held — a plain click must not
  // hand the next stray scroll event to the reader.
  box.addEventListener('pointermove', (e) => {
    if (box._scrollPointer === e.pointerId && (e.buttons & 1)) noteUser();
  }, { passive: true });
  const endPointer = (e) => { if (box._scrollPointer === e.pointerId) box._scrollPointer = null; };
  window.addEventListener('pointerup', endPointer, { passive: true });
  window.addEventListener('pointercancel', endPointer, { passive: true });
  const userDrove = () => box._scrollPointer != null || Date.now() - (box._userScrollAt || 0) < 900;
  box.addEventListener('scroll', () => {
    if (box._jumpHold) return; // a jump owns the scroll until it settles
    // An in-flight smooth landing (jump-to-present) is ours too: its pass over
    // the history is not the reader leaving the bottom, and re-pinning mid
    // animation would cut it short.
    if (box._smoothUntil && Date.now() < box._smoothUntil) { box._smoothUntil = Date.now() + 250; return; }
    const prevTop = box._lastTop;
    const top = box.scrollTop;
    // Older messages are paged in from the reader's OWN movement upward. Input
    // alone is not enough to believe a movement is theirs: a finger resting on
    // the screen while late media grows the list moves scrollTop too. Direction
    // is what makes it theirs — and where the reader's input HAS a direction,
    // that is the direction (the position test cannot see through native scroll
    // anchoring; see noteUser). Otherwise: the top is smaller than the last
    // position we placed or observed. (setScrollTop keeps that baseline in
    // step, so our own placements never read as a scroll up.)
    const up = prevTop != null && top < prevTop - 2;
    const moved = prevTop == null || Math.abs(top - prevTop) > 0.5;
    box._lastTop = top;
    const drove = userDrove();
    const userUp = up || (drove && box._userUp === true);
    // The reader's own upward movement ends the pin — however small it is, and
    // for the rest of the gesture. One wheel notch is ~100–120px, so a reader
    // who moved up still reads as "near the bottom" to any 200px band; if the
    // band is allowed to hand the pin straight back, the next thing that
    // resizes the list (a picture landing above, a reaction bar appearing, an
    // upload's scan card flipping into its picture) follows the tail by putting
    // them at the bottom again. They can never get more than a notch away, so
    // they can never leave — the "one notch flicks me back down" trap.
    if (userUp && drove) {
      box._userUpAt = Date.now();
      if (box.dataset.atBottom !== '0') { try { box.dataset.atBottom = '0'; } catch {} }
      try { if (typeof maybeLoadOlderMessages === 'function') maybeLoadOlderMessages(box); } catch {}
      return;
    }
    if (box.dataset.atBottom === '1') {
      // Nobody asked for this — hold the bottom the reader never left.
      setScrollTop(box, box.scrollHeight, '1');
      try { if (typeof updatePill === 'function') updatePill(); } catch {}
      return;
    }
    // Still travelling up (a phone's momentum after the finger lifts is not
    // input any more, but it is still the reader's own scroll), or a stray
    // event inside the gesture that demoted the pin: the demotion stands.
    if (userUp || (!moved && Date.now() - (box._userUpAt || 0) < 900)) return;
    markBottomState(box);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || box.dataset.atBottom !== '1') return;
    // Lazy media only started loading once we came back — re-pin the reader
    // who was at the bottom when we lost sight of them.
    setScrollTop(box, box.scrollHeight, '1');
    try { if (typeof updatePill === 'function') updatePill(); } catch {}
  });
  armLineGuard(box); // hold a scrolled-up reader's place through layout changes
}
function observeStick(el) {
  if (!el || el.dataset.stickOn) return;
  el.dataset.stickOn = '1';
  try {
    if (!stickRO) {
      stickRO = new ResizeObserver((entries) => {
        for (const e of entries) {
          if (!e.target.isConnected) { try { stickRO.unobserve(e.target); stickH.delete(e.target); } catch {} continue; }
          const box = e.target.closest ? e.target.closest('#messages,#thread-replies') : null;
          if (!box) continue;
          // A scrolled-up reader's place is held off this resize too (see
          // armLineGuard): an image's bytes or a clip's metadata landing is a
          // layout change with no DOM mutation behind it.
          try { if (box._lineCheck) box._lineCheck(); } catch {}
          // Follow the bottom through the growth itself: one tall image can
          // pop in 300px+ in a single step, jumping a pinned reader clean
          // past the 200px near-bottom band. Subtract this resize's own
          // growth so the check sees where the reader was *before* it grew
          // (a scrolled-up reader's distance dwarfs any single growth and
          // is still left alone).
          let growth = 0;
          try {
            const h = e.contentRect ? e.contentRect.height : 0;
            const prev = stickH.has(e.target) ? stickH.get(e.target) : h;
            if (h > prev) growth = h - prev;
            stickH.set(e.target, h);
          } catch {}
          // Input that arrived since our last placement, with the box no longer
          // at the bottom, IS the reader — and one wheel notch can land in the
          // SAME frame as the growth it sets off, so the scroll event that
          // demotes them has not run yet and the flag still reads '1'. Re-pinning
          // here would swallow the notch: leave them to the scroll handler,
          // which demotes a moment later. (A pinned reader whose box really is
          // at the bottom is untouched by this — nothing has moved.)
          if (Date.now() - (box._userScrollAt || 0) < 900 &&
              box.scrollHeight - box.scrollTop - box.clientHeight > 4) continue;
          // Explicit state beats inference: '1' = the reader is on the live
          // bottom, '0' = they scrolled up (never yank those back, however big
          // the growth). Only when nothing has seeded the box yet do we fall
          // back to distance-minus-growth.
          const at = box.dataset.atBottom;
          if (at === '1' || (at === undefined && box.scrollHeight - box.scrollTop - box.clientHeight - growth < 200)) {
            setScrollTop(box, box.scrollHeight, '1');
            try { if (typeof updatePill === 'function') updatePill(); } catch {}
          }
        }
      });
    }
    stickRO.observe(el);
  } catch {}
}
function reactionNameFor(uid) {
  if (S.me && uid === S.me.id) return S.me.display_name || 'You';
  try {
    const u = typeof memberById === 'function' ? memberById(uid) : null;
    if (u) return u.display_name || u.username || null;
  } catch {}
  return null;
}
// Native title doubles as the hover readout: up to 10 reactor names plus
// the overflow count. Unknown IDs (left users / not-yet-fetched) fall back
// to a plain count — the styled tooltip + View-reactions modal fill those
// in via the details endpoint.
function reactionTitle(r) {
  const users = Array.isArray(r.users) ? r.users : [];
  if (!users.length) return `${r.count} reaction${r.count === 1 ? '' : 's'} — click to react`;
  const names = users.slice(0, 10).map((id) => reactionNameFor(id) || 'Unknown user');
  const extra = users.length > 10 ? ` and ${users.length - 10} more` : '';
  return `${names.join(', ')}${extra} reacted with ${r.emoji}`;
}
function reactionsHTML(m) {
  if (!m.reactions?.length) return '';
  return '<div class="reactions">' + m.reactions.map((r) => {
    const em = S.emojiAll[r.emoji.slice(1, -1)];
    const label = r.emoji.startsWith(':') && r.emoji.endsWith(':') && em
      ? `<img class="cemoi" src="${em.url}" alt="${esc(r.emoji)}" data-fb-emoji="${esc(r.emoji)}">`
      : esc(r.emoji);
    return `<button class="reaction${r.me ? ' me' : ''}" data-act="react" data-emoji="${esc(r.emoji)}" title="${esc(reactionTitle(r))}" aria-label="${esc(reactionTitle(r))}">${label} <span class="rcount">${r.count}</span></button>`;
  }).join('') + '</div>';
}
// What a rolling value is SHOWING. While the two copies are stacked the
// container's textContent is both of them run together ("12" for 1 -> 2), so the
// pending copy is the only honest answer — asking the wrong question makes a
// later increase look like no change at all.
function rollShownText(el) {
  if (!el) return '';
  const pending = el.querySelector ? el.querySelector('.rc-new') : null;
  return ((pending || el).textContent || '');
}
// The number a pill is showing (see rollShownText for why it is not just
// textContent).
function pillCount(b) {
  const el = b && b.querySelector('.rcount');
  if (!el) return null;
  const n = parseInt(rollShownText(el), 10);
  return Number.isFinite(n) ? n : null;
}
// Count changed on an existing pill: roll the number like an odometer tick
// instead of swapping the digit under the reader's eye. Two stacked copies
// animate past each other inside a one-digit window, then collapse back to plain
// text. UP when a reaction is added (the new number rises in), DOWN when one is
// taken back (it drops in from above) — the direction is the whole point of the
// gesture, so a removal never just snaps.
function rollReactionCount(el, from, to, dir) { rollValue(el, from, to, dir, ''); }
// The roll itself, shared by the reaction count (a digit-sized window) and the
// me bar's sub-line (a `wide`, text-sized one — see the stylesheet). `extra`
// names the window size, `dir` which way the strip travels.
function rollValue(el, from, to, dir, extra) {
  try {
    if (!el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = String(to); return; }
    const wrap = document.createElement('span');
    wrap.className = 'rc-roll' + (extra ? ' ' + extra : '') + (dir === 'down' ? ' down' : '');
    const a = document.createElement('span'); a.className = 'rc-old'; a.textContent = String(from);
    const b = document.createElement('span'); b.className = 'rc-new'; b.textContent = String(to);
    wrap.append(a, b);
    el.replaceChildren(wrap);
    const settle = () => { if (el.isConnected) el.textContent = String(to); };
    wrap.addEventListener('animationend', settle, { once: true });
    setTimeout(settle, 500); // background tabs / interrupted animations never fire it
  } catch { try { el.textContent = String(to); } catch {} }
}
// ---------- text/code file previews (expandable, copyable, downloadable) ----------
// Every text-ish file — source, script, config, markup, log — embeds as a code
// BOX rather than a plain file card: the opening lines under a fade, an
// Expand/Collapse toggle and Copy in the footer, the download chip in the
// header. Detection is mime first, then extension, then bare file name, so a
// `.env`, a `Dockerfile` and a `.ps1` all land in the box. `txtExpanded` records
// the URLs the reader opened so a repaint (an edit, a new message, a reconnect)
// puts the card back exactly as they left it.
const TEXT_EXTS = new Set([
  // plain text / docs
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'org', 'adoc', 'asciidoc', 'tex', 'bib', 'log', 'csv', 'tsv', 'srt', 'vtt',
  // js / ts and friends
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'json5', 'jsonc', 'map', 'vue', 'svelte', 'astro',
  // web
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
  // data / config
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env', 'lock', 'plist', 'gradle', 'pro', 'cmake',
  // shells / scripts
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'awk', 'reg',
  // languages
  'py', 'pyw', 'pyi', 'rb', 'erb', 'gemspec', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'h', 'hpp', 'hh', 'cxx', 'cpp', 'cc', 'cs', 'go', 'rs', 'php', 'swift', 'm', 'mm', 'dart', 'lua',
  'pl', 'pm', 'r', 'jl', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'edn', 'hs', 'lhs', 'ml', 'mli', 'fs', 'fsx',
  'vb', 'asm', 's', 'sol', 'zig', 'nim', 'cr', 'tcl', 'pas', 'f90', 'd', 'elm', 'scm', 'lisp', 'el',
  // data / query languages
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'tf', 'tfvars', 'hcl', 'nix',
  // misc text formats
  'diff', 'patch', 'pem', 'asc',
]);
// Whole names, for the extension-less ones (a `Dockerfile` has no `.ext` at all).
const TEXT_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'rakefile', 'gemfile',
  'guardfile', 'procfile', 'brewfile', 'vagrantfile', 'jenkinsfile', 'justfile',
  'taskfile', 'license', 'licence', 'readme', 'changelog', 'contributing',
  'notice', 'authors', 'codeowners', 'hosts', 'fstab', 'sudoers',
]);
const TEXT_MIMES = new Set([
  'application/json', 'application/ld+json', 'application/javascript',
  'application/x-javascript', 'application/ecmascript', 'application/xml',
  'application/xhtml+xml', 'application/x-sh', 'application/x-csh',
  'application/x-httpd-php', 'application/x-httpd-php-source',
  'application/x-python', 'application/x-ruby', 'application/x-perl',
  'application/x-lua', 'application/x-yaml', 'application/yaml',
  'application/toml', 'application/sql', 'application/graphql',
  'application/x-tex', 'application/x-latex', 'application/x-desktop',
]);
const TXT_MAX_BYTES = 512 * 1024; // beyond this a file is a download, not a read
const TXT_PREVIEW_LINES = 12;
const TXT_PREVIEW_CHARS = 1200;
function textPreviewable(a) {
  if (!a || (a.size || 0) > TXT_MAX_BYTES) return false;
  if (/^text\//.test(a.mime || '') || TEXT_MIMES.has(a.mime)) return true;
  const name = String(a.name || '').toLowerCase();
  if (TEXT_NAMES.has(name)) return true;
  const parts = name.split('.');
  return parts.length > 1 && TEXT_EXTS.has(parts.pop());
}
const txtCache = new Map();     // url -> {status, text, preview}
const txtExpanded = new Set();  // urls expanded inline, so a repaint keeps them open
const TXT_COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5"/></svg>';
const TXT_CHEV_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
function txtPreviewOf(t) {
  return String(t || '').split('\n').slice(0, TXT_PREVIEW_LINES).join('\n').slice(0, TXT_PREVIEW_CHARS);
}
// An extension means different things in different places (`.key` is a private
// key in a repo and a Keynote deck on a Mac), and a server can label anything
// `text/*`. So the bytes get the last word: NUL or a wall of replacement
// characters is not text, and the card says so instead of painting mojibake.
function txtLooksBinary(t) {
  const head = String(t || '').slice(0, 2048);
  if (!head) return false;
  if (head.indexOf('\u0000') >= 0) return true;
  let bad = 0;
  for (const ch of head) if (ch === '\uFFFD') bad++;
  return bad / head.length > 0.05;
}
// One place that turns fetched bytes into a cache entry, so every path (the
// render fetch, Expand and Copy) classifies them the same way.
function txtCacheText(url, t) {
  const prev = txtCache.get(url);
  if (txtLooksBinary(t)) { txtCache.set(url, { status: 'bin' }); return null; }
  const entry = { status: 'ready', text: t, preview: (prev && prev.preview) || txtPreviewOf(t) };
  txtCache.set(url, entry);
  return entry;
}
function txtBodyText(c, open) {
  if (!c || c.status === 'loading') return 'Loading preview…';
  if (c.status !== 'ready') return 'Preview unavailable — download to view.';
  return (open ? c.text : c.preview) || '(empty file)';
}
function textFileHTML(a) {
  queueTextPreview(a.url);
  scheduleTxtClip();
  const open = txtExpanded.has(a.url);
  return `<div class="txtfile${open ? ' open' : ''}" data-turl="${esc(a.url)}" data-tname="${esc(a.name)}"${attMeta(a, 'file')}>`
    + `<div class="txt-head"><span class="txt-ic" aria-hidden="true">&lt;/&gt;</span><span class="txt-name" title="${esc(a.name)}">${esc(a.name)}</span><span class="txt-size">${fmtSize(a.size)}</span><span class="spacer"></span>${attDl(a)}</div>`
    + `<div class="txt-body"><pre class="txt-prev">${esc(txtBodyText(txtCache.get(a.url), open))}</pre></div>`
    + `<div class="txt-foot">`
    + `<button type="button" class="txt-btn" data-act="expand-file" aria-expanded="${open ? 'true' : 'false'}"><span class="txt-chev">${TXT_CHEV_ICON}</span><span class="txt-lbl">${open ? 'Collapse' : 'Expand'}</span></button>`
    + `<button type="button" class="txt-btn" data-act="copy-file">${TXT_COPY_ICON}<span>Copy</span></button>`
    + `</div></div>`;
}
function queueTextPreview(url) {
  if (!url || txtCache.has(url)) { paintTextPreviews(url); return; }
  txtCache.set(url, { status: 'loading' });
  fetch(url).then((r) => { if (!r.ok) throw 0; return r.text(); }).then((t) => {
    txtCacheText(url, t);
    paintTextPreviews(url);
  }).catch(() => { txtCache.set(url, { status: 'err' }); paintTextPreviews(url); });
}
// Swapping one line ("Loading preview…") for the opening lines — or the preview
// for the whole file — changes the card's height. When that happens at or above
// the viewport it would shove the reader upward, so hold the view steady.
function txtStableSwap(card, apply) {
  let box = null, hBefore = 0, pin = false;
  try {
    box = card.closest ? card.closest('#messages,#thread-replies') : null;
    if (box && !box.classList.contains('hidden')) {
      const btop = box.getBoundingClientRect().top;
      if (card.getBoundingClientRect().top < btop + 1) { hBefore = card.offsetHeight; pin = true; }
    }
  } catch { box = null; }
  try { apply(); } catch {}
  try {
    if (pin && box) { const dh = card.offsetHeight - hBefore; if (dh) setScrollTop(box, box.scrollTop + dh); }
  } catch {}
}
// Paint one card from the cache. The body and the toggle's own state are always
// written together — a button reading "Collapse" over a 12-line preview is the
// bug this shape prevents.
function txtPaintCard(card, open) {
  const el = card.querySelector('.txt-prev');
  if (el) {
    const next = txtBodyText(txtCache.get(card.dataset.turl), open);
    if (el.textContent !== next) txtStableSwap(card, () => { el.textContent = next; });
  }
  txtPaintClip(card, open);
  const btn = card.querySelector('[data-act="expand-file"]');
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const lbl = btn.querySelector('.txt-lbl');
    if (lbl) lbl.textContent = open ? 'Collapse' : 'Expand';
  }
}
// The bottom fade means "there is more of this file" — so it may only appear
// when the box is really cut off. It is a MEASUREMENT, which is why it cannot be
// decided while the markup is being built: the card's own height reads 0 until
// the message element it belongs to is in the document. One rAF pass after a
// render settles every card on the page (a card inside a hidden panel measures 0
// and simply keeps no fade until the next paint).
function txtPaintClip(card, open) {
  const el = card && card.querySelector ? card.querySelector('.txt-prev') : null;
  if (!el) return;
  const c = txtCache.get(card.dataset.turl);
  // A preview that was cut short means more lines follow, whatever the box
  // happens to show; the measurement adds the case a wrapped long line makes
  // (the whole file is in the box, and still taller than the cap).
  let clipped = !open && !!(c && c.status === 'ready' && c.text && c.text.length > (c.preview || '').length);
  try { if (!open && el.clientHeight > 0) clipped = clipped || el.scrollHeight > el.clientHeight + 2; } catch {}
  card.classList.toggle('clipped', clipped);
}
let txtClipPending = false;
function scheduleTxtClip() {
  if (txtClipPending) return;
  txtClipPending = true;
  const run = () => {
    txtClipPending = false;
    document.querySelectorAll('.txtfile').forEach((card) => txtPaintClip(card, card.classList.contains('open')));
  };
  try { requestAnimationFrame(run); } catch { setTimeout(run, 16); }
}
function paintTextPreviews(url) {
  if (!url) return;
  document.querySelectorAll('.txtfile').forEach((card) => {
    if (card.dataset.turl !== url) return;
    txtPaintCard(card, card.classList.contains('open'));
  });
}
// Expand/collapse is INLINE: the same box grows into the whole file (capped and
// scrollable) and shrinks back to the preview. The text is cached per URL, so
// collapsing and re-expanding never re-fetches.
async function expandTextFile(el) {
  const card = el && el.closest ? el.closest('.txtfile') : null;
  const url = card && card.dataset.turl;
  if (!card || !url) return;
  const open = !card.classList.contains('open');
  card.classList.toggle('open', open);
  if (open) txtExpanded.add(url); else txtExpanded.delete(url);
  txtPaintCard(card, open);
  if (!open) return;
  const c = txtCache.get(url);
  if (c && c.status === 'ready') return;
  try {
    const r = await fetch(url);
    if (!r.ok) throw 0;
    const text = await r.text();
    if (!txtCacheText(url, text)) toast('Not a text file');
  } catch {
    txtCache.set(url, { status: 'err' });
    toast('Could not load file');
  }
  // The fetch lands whenever it lands: only the card this started on, and only
  // while it is still open and still in the document.
  if (card.isConnected && card.classList.contains('open')) txtPaintCard(card, true);
}
// Copy is the box's other button: it reads the bytes if the preview never had
// to (a card the reader never expanded), and copies the WHOLE file — not the
// 12-line preview it happens to be showing.
async function copyTextFile(el) {
  const card = el && el.closest ? el.closest('.txtfile') : null;
  const url = card && card.dataset.turl;
  if (!url) return;
  let c = txtCache.get(url);
  try {
    if (!c || c.status !== 'ready') {
      if (c && c.status === 'bin') { toast('Not a text file'); return; }
      const r = await fetch(url);
      if (!r.ok) throw 0;
      c = txtCacheText(url, await r.text());
      paintTextPreviews(url);
      if (!c) { toast('Not a text file'); return; }
    }
    await navigator.clipboard.writeText(c.text || '');
    toast('Copied');
  } catch { toast('Could not copy file'); }
}
function fmtClock(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// ---------- voice/audio player (one shared look for every audio embed) ----------
let vpSeq = 0;
const VP_BARS = 36;
// Shared preview volume (persisted): hover/tap the speaker icon on any audio
// preview to reveal its slider. New previews start at the last chosen level.
let vpVol = 1;
try { const _v = parseFloat(localStorage.getItem('cf_vol')); if (_v >= 0 && _v <= 1) vpVol = _v; } catch {}
function vpVolIcon() {
  return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none"/><path class="vp-wv" d="M15.5 8.5a5 5 0 0 1 0 7"/><path class="vp-wv" d="M18.2 5.8a9 9 0 0 1 0 12.4"/><g class="vp-mx" style="display:none"><path d="M16 9.5l5 5"/><path d="M21 9.5l-5 5"/></g></svg>';
}
function audioPlayerHTML(a, opts) {
  const tag = 'vp' + (++vpSeq).toString(36) + Date.now().toString(36).slice(-3);
  // While the upload waits, the player points at the local preview when the
  // uploading browser still holds the take — a voice message is playable the
  // moment it is sent, and the player is already pointing at its final source
  // (data-fb-src) when the slot publishes it, so the verdict swaps the <audio>
  // source without rebuilding the player (see patchAttachmentNode). A patch
  // passes `live:false` — it is building the FINAL rendering.
  const pending = a.scan === 'pending';
  const shot = (!opts || opts.live !== false) ? attShot(a) : null;
  const src = shot ? shot.src : (pending ? attPreviewSrc(a) : '');
  return `<div class="vplayer" data-vp="${tag}" data-url="${esc(a.url)}" data-size="${a.size || 0}"${attMeta(a, 'audio')}>`
    + `<button type="button" class="vp-play" data-vp-toggle title="Play"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path class="vp-ic-play" d="M8 5v14l11-7z"/><path class="vp-ic-pause" d="M7 5h4v14H7zM13 5h4v14h-4z" style="display:none"/></svg></button>`
    + `<audio src="${esc(src || a.url)}" data-fb-src="${esc(a.url)}" preload="metadata"></audio>`
    + `<div class="vp-body"><div class="vp-name" title="${esc(a.name)}">${esc(a.name)}</div><div class="vp-bars" data-vp-seek>${'<i></i>'.repeat(VP_BARS)}</div>`
    + `<div class="vp-meta"><span data-vp-cur>0:00</span><span class="vp-dur">…</span></div></div>`
    + `<div class="vp-vol"><button type="button" class="vp-volbtn" data-vp-volbtn title="Volume">${vpVolIcon()}</button>`
    + `<span class="vp-volpop"><input type="range" class="vp-volslider" data-vp-vol min="0" max="1" step="0.01" value="${vpVol}" style="--fill:${Math.round(vpVol * 100)}%" aria-label="Preview volume" /></span></div>`
    + attDl(a, pending) + `</div>`;
}
function vpAudio(root) { return root ? root.querySelector('audio') : null; }
function vpPaint(root) {
  const audio = vpAudio(root);
  if (!audio) return;
  const dur = audio.duration || 0, cur = audio.currentTime || 0;
  const ratio = dur > 0 ? Math.min(1, cur / dur) : 0;
  const bars = root.querySelectorAll('.vp-bars i');
  const n = Math.round(ratio * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < n));
  const ce = root.querySelector('[data-vp-cur]');
  if (ce) ce.textContent = fmtClock(cur);
  const playing = !audio.paused && !audio.ended;
  const play = root.querySelector('.vp-ic-play'), pause = root.querySelector('.vp-ic-pause');
  if (play) play.style.display = playing ? 'none' : '';
  if (pause) pause.style.display = playing ? '' : 'none';
  const tg = root.querySelector('[data-vp-toggle]');
  if (tg) tg.title = playing ? 'Pause' : 'Play';
}
function vpVolPaint(root) {
  const audio = vpAudio(root);
  if (!audio) return;
  const v = audio.muted ? 0 : (audio.volume ?? 1);
  const muted = v <= 0.001;
  root.querySelectorAll('.vp-wv').forEach((p) => { p.style.display = muted ? 'none' : ''; });
  root.querySelectorAll('.vp-mx').forEach((p) => { p.style.display = muted ? '' : 'none'; });
  const btn = root.querySelector('[data-vp-volbtn]');
  if (btn) btn.title = muted ? 'Unmute' : 'Mute';
  const sl = root.querySelector('[data-vp-vol]');
  if (sl && document.activeElement !== sl) sl.value = String(v);
  if (sl) sl.style.setProperty('--fill', Math.round(v * 100) + '%');
}
function vpSetVol(root, v) {
  const audio = vpAudio(root);
  if (!audio) return;
  v = Math.min(1, Math.max(0, parseFloat(v) || 0));
  audio.muted = false;
  audio.volume = v;
  vpVol = v;
  try { localStorage.setItem('cf_vol', String(v)); } catch {}
  vpVolPaint(root);
}
// Real waveform peaks, decoded lazily once the clip's metadata is in.
// Big files skip decoding and keep the flat segmented track.
let vpAC = null;
async function paintPeaks(root, audio) {
  if (!root || root.dataset.peaks) return;
  const size = parseInt(root.dataset.size || '0', 10) || 0;
  if (size > 25 * 1024 * 1024) return;
  root.dataset.peaks = '1';
  try {
    if (!vpAC) vpAC = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await (await fetch(audio.currentSrc || audio.src)).arrayBuffer();
    const dec = await vpAC.decodeAudioData(buf);
    if (!dec || !dec.length) return;
    const ch = dec.getChannelData(0);
    const out = new Array(VP_BARS).fill(0);
    const per = Math.max(1, Math.floor(ch.length / VP_BARS));
    for (let i = 0; i < VP_BARS; i++) {
      let m = 0;
      const s = i * per;
      for (let j = s; j < Math.min(s + per, ch.length); j += 11) { const v = Math.abs(ch[j]); if (v > m) m = v; }
      out[i] = m;
    }
    const mx = Math.max(...out, 0.02);
    root.querySelectorAll('.vp-bars i').forEach((b, i) => { b.style.height = Math.max(14, Math.round((out[i] / mx) * 100)) + '%'; });
  } catch { delete root.dataset.peaks; }
}
document.addEventListener('input', (e) => {
  const sl = e.target.closest ? e.target.closest('[data-vp-vol]') : null;
  if (!sl) return;
  const root = sl.closest('.vplayer');
  if (root) vpSetVol(root, sl.value);
});
document.addEventListener('click', (e) => {
  const vb = e.target.closest ? e.target.closest('[data-vp-volbtn]') : null;
  if (vb) {
    const root = vb.closest('.vplayer');
    if (!root) return;
    // Touch (no hover): tap opens/closes the slider popup instead of muting,
    // since there is no hover to reveal it with. Mute via slider-to-zero.
    if (window.matchMedia && matchMedia('(hover: none)').matches) {
      const box = vb.closest('.vp-vol');
      const was = box ? box.classList.contains('open') : false;
      document.querySelectorAll('.vp-vol.open').forEach((o) => o.classList.remove('open'));
      if (box && !was) box.classList.add('open');
      return;
    }
    const audio = vpAudio(root);
    if (!audio) return;
    if (audio.muted || audio.volume <= 0.001) {
      const prev = parseFloat(root.dataset.prevvol);
      vpSetVol(root, (prev > 0.001 && prev <= 1) ? prev : (vpVol > 0.001 ? vpVol : 1));
    } else {
      root.dataset.prevvol = String(audio.volume);
      vpSetVol(root, 0);
    }
    return;
  }
  if (!e.target.closest || !e.target.closest('.vp-vol'))
    document.querySelectorAll('.vp-vol.open').forEach((o) => o.classList.remove('open'));
});
document.addEventListener('click', (e) => {
  const tg = e.target.closest('[data-vp-toggle]');
  const sk = e.target.closest('[data-vp-seek]');
  if (tg) {
    const root = tg.closest('.vplayer'), audio = vpAudio(root);
    if (!audio) return;
    if (audio.paused) {
      // one clip at a time: stop anything else playing first
      document.querySelectorAll('.vplayer audio').forEach((o) => { if (o !== audio && !o.paused) o.pause(); });
      audio.play().catch(() => {});
    } else audio.pause();
    return;
  }
  if (sk) {
    const root = sk.closest('.vplayer'), audio = vpAudio(root);
    if (audio && audio.duration) {
      const r = sk.getBoundingClientRect();
      audio.currentTime = Math.min(0.999, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))) * audio.duration;
      vpPaint(root);
    }
    return;
  }
});
['play', 'pause', 'timeupdate', 'ended'].forEach((ev) => document.addEventListener(ev, (e) => {
  const t = e.target;
  if (t && t.tagName === 'AUDIO' && t.closest) {
    const root = t.closest('.vplayer');
    if (root) vpPaint(root);
  }
}, true));
document.addEventListener('loadedmetadata', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'AUDIO' || !t.closest) return;
  const root = t.closest('.vplayer');
  if (!root) return;
  try { t.volume = vpVol; t.muted = false; } catch {}
  const de = root.querySelector('.vp-dur');
  if (de && isFinite(t.duration)) de.textContent = fmtClock(t.duration);
  vpPaint(root);
  vpVolPaint(root);
  paintPeaks(root, t);
}, true);
document.addEventListener('volumechange', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'AUDIO' || !t.closest) return;
  const root = t.closest('.vplayer');
  if (root) vpVolPaint(root);
}, true);
// ---------- polls ----------
function pollHTML(m) {
  const p = m.poll;
  if (!p) return '';
  const total = p.total || 0;
  const opts = (p.options || []).map((o) => {
    const mine = !!(S.me && (o.voters || []).includes(S.me.id));
    const pct = total ? Math.round(((o.votes || 0) / total) * 100) : 0;
    return `<button type="button" class="poll-opt${mine ? ' voted' : ''}" data-act="vote" data-opt="${o.id}" title="${o.votes || 0} vote${(o.votes || 0) === 1 ? '' : 's'}">`
      + `<span class="poll-fill" style="width:${pct}%"></span>`
      + `<span class="poll-label">${esc(o.label)}</span>`
      + `<span class="poll-meta">${mine ? '✓ ' : ''}${o.votes || 0} · ${pct}%</span></button>`;
  }).join('');
  return `<div class="poll" data-poll="${p.id}"><div class="poll-opts">${opts}</div>`
    + `<div class="poll-foot">${total} vote${total === 1 ? '' : 's'} · tap an option to vote</div></div>`;
}
async function votePoll(mid, optionId) {
  const m = msgById(mid);
  const pid = m && m.poll && m.poll.id;
  if (!pid || !optionId) return;
  try { await api(`/api/polls/${pid}/vote`, { method: 'POST', body: JSON.stringify({ optionId }) }); }
  catch (err) { toast(prettyError(err.message)); }
}
// ---------- the hover bar's quick reactions ----------
// One builder for the strip, so a repaint and a fresh render can never disagree
// about what it holds: the account's own list (topReactions — most reacted-with,
// then most recent), then More / Reply / menu.
function quickReactHTML(e) {
  return `<button data-act="react" data-emoji="${esc(e)}" title="${esc(e)}">${emojiGlyphHTML(e)}</button>`;
}
// One emoji rendered the way the app renders it everywhere: a custom emoji is
// its own image, anything else is the glyph itself.
function emojiGlyphHTML(e) {
  e = String(e == null ? '' : e);
  const em = S.emojiAll && S.emojiAll[e.slice(1, -1)];
  return (e.startsWith(':') && e.endsWith(':') && em)
    ? `<img class="cemoi" src="${esc(em.url)}" alt="${esc(e)}">` : esc(e);
}
// The plus that means "add a reaction" — the hover bar's More button and the
// message menu's Add reaction row. It is a STROKED SVG in the chrome's own ink
// (`currentColor`), never the COLOURED plus emoji it used to be: this is UI
// chrome, and the design rule is no emoji there (the emoji in the bar beside it
// are the account's own most-used reactions, which is user content).
function plusSVG(s = 14) {
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
}
function quickReactsHTML() {
  return topReactions().map(quickReactHTML).join('')
    + `<button data-act="more" title="More reactions" aria-label="More reactions">${plusSVG(15)}</button><button data-act="reply" title="Reply">↩</button><button data-act="menu" title="More actions">⋯</button>`;
}
// The strip is baked into each message's markup when it renders, so reacting with
// something new moved the ranking with nothing on screen to show for it: the bar
// under the pointer stayed the five it had. Repaint the ones already up — every
// surface renders `.msg-actions` through the builder above.
function paintQuickReacts() {
  const html = topReactions().map(quickReactHTML).join('');
  for (const bar of document.querySelectorAll('.msg-actions')) {
    bar.querySelectorAll('button[data-emoji]').forEach((b) => b.remove());
    bar.insertAdjacentHTML('afterbegin', html);
  }
}
// ---------- the thread card under a root message ----------
// A root with replies wears a compact card instead of a bare "N replies" line:
// the label and reply count, then the thread's LATEST reply — author, the first
// reaction on it, the snippet, when it landed. The whole card is one button
// (`data-act="thread"` is wired where every other message action is), so the
// click target is the thing being read rather than a word at the end of it.
// The server sends `threadLast` with every hydrated message; a reply that
// arrives live is folded into it by socket.js through the same shape.
function threadSnippetOf(t) {
  if (!t) return '';
  const s = String(t.content || '').trim().replace(/\s+/g, ' ');
  if (s) return s;
  const n = Number(t.attachments) || 0;
  if (n) return n === 1 ? 'sent an attachment' : 'sent ' + n + ' attachments';
  if (t.poll) return 'sent a poll';
  return '';
}
// A live message (from the socket or the open panel) turned into the card's
// preview line. Mirrors the server's threadLastOf so a card painted from a push
// and one painted from a reload read the same.
function threadLastFromMsg(m) {
  if (!m) return null;
  return {
    id: m.id,
    created_at: m.created_at,
    content: String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    user: m.user || null,
    webhook: m.webhook || null,
    attachments: (m.attachments || []).length,
    poll: !!m.poll,
    emoji: (m.reactions && m.reactions.length) ? (m.reactions[0].emoji || null) : null,
  };
}
function threadCardHTML(m) {
  const n = m.threadCount || 0;
  let inner = '<span class="tc-top"><span class="tc-label">Thread</span>'
    + `<span class="tc-count">${n} ${n === 1 ? 'Message' : 'Messages'} ›</span></span>`;
  const last = m.threadLast;
  if (last) {
    const au = msgAuthor(last);
    const who = au ? (au.display_name || au.username || '?') : 'deleted';
    let row = `<span class="avatar tc-av"></span><span class="tc-who" style="${nameStyleFor(au)}">${esc(who)}</span>`;
    if (last.emoji) row += `<span class="tc-react">${emojiGlyphHTML(last.emoji)}</span>`;
    const snip = threadSnippetOf(last);
    if (snip) row += `<span class="tc-text${String(last.content || '').trim() ? '' : ' att'}">${esc(snip)}</span>`;
    const ago = fmtAgo(last.created_at);
    if (ago) row += `<span class="tc-when">${esc(ago)}</span>`;
    inner += '<span class="tc-last">' + row + '</span>';
  }
  return `<button class="thread-link" data-act="thread" title="Open thread">${inner}</button>`;
}
// The avatar is the one part of the card that is not markup: paintAvatar owns
// photos, initials, colours and decorations, and the card must match a message
// head exactly.
function paintThreadCardAvatar(card, m) {
  const av = card && card.querySelector('.tc-av');
  if (av) paintAvatar(av, m && m.threadLast ? msgAuthor(m.threadLast) : null);
}
function messageEl(m, opts = {}) {
  const div = document.createElement('div');
  // The painted node carries its own timestamp: a day divider belongs to the day
  // of the messages under it, and this is how anything checking that (a test, or
  // a future seam fixup) can judge it without re-walking the model.
  div.dataset.time = String(m.created_at || 0);
  if (m.sys) {
    div.className = 'msg sys';
    div.dataset.mid = m.id;
    div.textContent = m.content;
    return div;
  }
  const grouped = !!opts.grouped;
  div.className = 'msg' + (grouped ? ' grouped' : '');
  div.dataset.mid = m.id;
  const au = msgAuthor(m);
  const own = au && au.id === S.me.id;
  let inner = grouped
    ? `<span class="avatar ghost" title="${esc(fmtFull(m.created_at))}"><span class="gts">${esc(fmtTime(m.created_at))}</span></span><div class="body">`
    : '<span class="avatar" data-uid="' + (m.webhook ? '' : (m.user ? m.user.id : '')) + '"></span><div class="body">';
  if (!grouped) {
    inner += `<div class="head"><span class="who" data-uid="${m.webhook ? '' : (m.user ? m.user.id : '')}" style="${nameStyleFor(au)}">${esc(au ? au.display_name : 'deleted')}</span>${m.webhook ? '<span class="bot-tag">BOT</span>' : tagHTML(au)}<span class="when" title="${esc(fmtFull(m.created_at))}">${fmtTime(m.created_at)}</span>${m.edited ? '<span class="edited">(edited)</span>' : ''}</div>`;
  }
  if (m.fwdFrom) {
    inner += `<div class="fwd-tag">Forwarded from <b>${esc(m.fwdFrom)}</b></div>`;
  }
  if (m.storyId) {
    inner += '<div class="story-tag"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/></svg><span>Story reply</span></div>';
  }
  if (m.replyTo) {
    if (m.replyTo.deleted || (m.replyTo.author === 'deleted' && !m.replyTo.snippet)) {
      inner += `<div class="reply-quote deleted"><span class="rq-text">Original message was deleted</span></div>`;
    } else {
      inner += `<div class="reply-quote" data-jump="${m.replyTo.id}"><span class="rq-author">${esc(m.replyTo.author)}</span><span class="rq-text">${esc(m.replyTo.snippet)}</span></div>`;
    }
  }
  if (S.editing === m.id) {
    const eatts = (m.attachments || []).filter((a) => a.id && !(S.editRemovals && S.editRemovals.has(a.id)));
    inner += `<div class="edit-box"><textarea id="edit-area" maxlength="5000">${esc(m.content)}</textarea>`
      + (eatts.length ? `<div class="edit-atts">` + eatts.map((a) => `<span class="edit-att">${a.kind === 'image' && a.scan !== 'pending' && a.scan !== 'infected' ? `<img src="${esc(a.url)}" alt="" loading="lazy" />` : ''}<span class="edit-att-name">${esc(a.name)}${a.scan === 'pending' ? ' (processing…)' : ''}${a.scan === 'infected' ? ' (removed: virus detected)' : ''}</span><button type="button" class="mini edit-att-x" data-act="edit-unattach" data-aid="${esc(a.id)}" title="Remove attachment">✕</button></span>`).join('') + `</div>` : '')
      + `<div class="row"><button class="btn small primary" data-act="edit-save">Save</button><button class="btn small" data-act="edit-cancel">Cancel</button></div></div>`;
  } else if (m.content) {
    const big = isBigEmoji(m.content) && !m.attachments?.length;
    inner += `<div class="text${big ? ' bigemoji' : ''}">${renderRich(m.content, { authorId: m.user && m.user.id })}${grouped && m.edited ? ' <span class="edited">(edited)</span>' : ''}</div>`;
    if (!big && typeof linkEmbedsHTML === 'function') inner += linkEmbedsHTML(m.content);
  }
  if (m.attachments?.length) {
    // The list is painting these: the picked-bytes store (see attPreviewEntry)
    // uses this to tell a message's attachment from one that was dropped before
    // it was ever posted.
    for (const a of m.attachments) noteAttPreviewRendered(a);
    inner += attsBlockHTML(m.attachments);
  }
  if (m.viewOnce && typeof voCardHTML === 'function') inner += voCardHTML(m);
  if (m.poll) inner += pollHTML(m);
  inner += reactionsHTML(m);
  if (!opts.inThread && !m.threadRoot && m.threadCount > 0) {
    inner += threadCardHTML(m);
  }
  inner += '</div>';
  // hover bar: my quick reactions + more + reply + overflow menu
  inner += '<div class="msg-actions">' + quickReactsHTML() + '</div>';
  div.innerHTML = inner;
  if (!grouped) paintAvatar(div.querySelector('.avatar'), au);
  if (m.threadLast) paintThreadCardAvatar(div.querySelector('.thread-link'), m);
  try {
    div.querySelectorAll('video.att-vid').forEach((v) => { requestVideoPoster(v); observeStick(v); });
    // Images grow 0 -> full height on load and shove bottom-pinned readers
    // upward; load/error listeners can miss instant (cached) loads, but the
    // resize itself is always observable — follow it while near the bottom.
    div.querySelectorAll('img.att-img').forEach((img) => { observeStick(img); wireAttImage(img); });
  } catch {}
  return div;
}
// Discord-style grouping: consecutive messages from the same author collapse
// onto one header (5-minute window; day dividers, replies and forwards
// always start a new group).
const GROUP_MS = 5 * 60 * 1000;
function shouldGroup(prev, m) {
  if (!prev || !m || prev.sys || m.sys) return false;
  // Webhook posts only group with the same webhook (never with each other,
  // deleted users, or regular messages — all of which share user null).
  if (prev.webhook || m.webhook) {
    if (!prev.webhook || !m.webhook || prev.webhook.id !== m.webhook.id) return false;
  }
  if ((prev.user?.id || null) !== (m.user?.id || null)) return false;
  if ((m.created_at - prev.created_at) > GROUP_MS) return false;
  if (m.replyTo || m.fwdFrom) return false;
  return true;
}
function anchorBottom(box) {
  // Snap to the live bottom, then HOLD it while late content settles.
  // Images, video and link embeds render at 0 height on a cold start
  // (e.g. right after a refresh) and each one popping in above the
  // viewport shoves the view upward as it grows. Without this guard the
  // reader drifts hundreds of px up and gets stranded "way up" with the
  // Jump-to-present pill showing. Keep re-snapping until the reader takes
  // over with real input, or after a few seconds — whichever comes first.
  setScrollTop(box, box.scrollHeight, '1');
  watchBottomState(box);
  // Reachable target: max scrollTop is height minus viewport — tracking raw
  // scrollHeight (unreachable by exactly clientHeight) left every comparison
  // here a few pixels short.
  const bottomOf = () => Math.max(0, box.scrollHeight - box.clientHeight);
  let want = bottomOf(), live = true;
  // One hold per box: a newer hold (re-render, live message, thread reply)
  // supersedes older ones so stale snaps can't cross-kill the current one.
  const my = (box._holdGen = (box._holdGen | 0) + 1);
  const current = () => live && box._holdGen === my;
  const t0 = Date.now();
  // Never yank a different conversation: a channel switch reuses the same
  // #messages box, and late media from the old one may settle afterwards.
  const v = S.view, c = S.channelId, d = S.dmThreadId;
  const stillHere = () => S.view === v && S.channelId === c && S.dmThreadId === d && !box.classList.contains('hidden');
  const stop = () => {
    if (!live) return; live = false;
    try { if (mo) mo.disconnect(); } catch {}
    box.removeEventListener('wheel', take);
    box.removeEventListener('touchmove', take);
    box.removeEventListener('load', onSettle, true);
    box.removeEventListener('error', onSettle, true);
    box.removeEventListener('loadedmetadata', onSettle, true);
  };
  const take = () => stop(); // wheel / touch scroll = the user took over
  const snap = () => {
    if (!current() || !stillHere() || Date.now() - t0 > 8000) { stop(); return; }
    // The reader took over (watchBottomState flips this off their input, not
    // off a stray scroll event) — let go at once.
    if (box.dataset.atBottom === '0') { stop(); return; }
    want = bottomOf();
    if (Math.abs(box.scrollTop - want) > 0.5) setScrollTop(box, want, '1');
    if (typeof updatePill === 'function') { try { updatePill(); } catch {} }
  };
  const onSettle = (e) => {
    // Capture phase: 'load' doesn't bubble, but this still catches media
    // injected later (link embeds resolving seconds after open).
    if (!current()) { stop(); return; }
    if (e.target && e.target.matches && e.target.matches('img, video')) snap();
  };
  // Mutation watch: not all late growth fires a media event. Scan-card →
  // file flips, link-embed fetches resolving into text, waveform/text
  // previews popping in, and full-list rebuilds all rearrange the DOM
  // silently — re-pin through all of it the same way. Our own snaps only
  // move scrollTop (never the DOM), so this can't self-trigger.
  let mo = null;
  try {
    mo = new MutationObserver(() => snap());
    mo.observe(box, { childList: true, subtree: true, characterData: true });
  } catch { mo = null; }
  // Also watch the box itself: when #messages resizes (the composer grows for
  // a restored draft, a call stage opens, the recording bar appears) its
  // scrollTop is clamped — a pinned reader silently ends up short of the
  // bottom with nothing left to snap them back.
  observeStick(box);
  box.addEventListener('wheel', take, { passive: true });
  box.addEventListener('touchmove', take, { passive: true });
  box.addEventListener('load', onSettle, true);
  box.addEventListener('error', onSettle, true);
  box.addEventListener('loadedmetadata', onSettle, true);
  setTimeout(stop, 8100);
}
// Anchor-based scroll preservation for full list rebuilds. Distance-from-
// bottom breaks whenever content heights change across the rebuild (lazy
// images / video metadata load at 0 height, avatar <img>s, waveform bars),
// landing scrolled-up readers noticeably higher after any background update
// (reaction, edit, thread reply…). Pinning the topmost visible message
// instead survives those height changes exactly.
function captureListAnchor(box) {
  try {
    const btop = box.getBoundingClientRect().top;
    for (const el of box.querySelectorAll('.msg')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > btop + 1) return { mid: el.dataset.mid || null, off: r.top - btop };
    }
  } catch {}
  return null;
}
function restoreListAnchor(box, anchor, keepDist) {
  try {
    if (anchor && anchor.mid) {
      const el = box.querySelector('[data-mid="' + CSS.escape(anchor.mid) + '"]');
      if (el) {
        setScrollTop(box, box.scrollTop + ((el.getBoundingClientRect().top - box.getBoundingClientRect().top) - anchor.off), '0');
        return anchor;
      }
    }
  } catch {}
  setScrollTop(box, Math.max(0, box.scrollHeight - keepDist), '0');
  return null;
}
// Hold a restored anchor steady while late media settles. A fresh rebuild
// renders lazy images/videos at 0 height; as they pop in (often ms later,
// from cache) content above the viewport grows and would shove the reader
// upward. Re-pin the anchor as each one lands — stops the moment the user
// scrolls themselves, when everything settles, or after ~2.5s.
function pinAnchorWhileSettling(box, anchor) {
  try {
    watchBottomState(box); // a scrolled-up reader: growth must not re-pin them
    const mid = anchor && anchor.mid;
    if (!box || !mid || typeof anchor.off !== 'number') return;
    if (box._jumpHold) return; // a jump owns the scroll until it settles
    const sel = '[data-mid="' + CSS.escape(mid) + '"]';
    // One hold per box: a jump (holdMsgCentered) bumps this gen to retire any
    // hold that is still chasing the pre-jump anchor.
    const my = (box._pinGen = (box._pinGen | 0) + 1);
    const media = [...box.querySelectorAll('img, video')].filter((m) =>
      m.tagName === 'VIDEO' ? m.readyState < 1 : !m.complete);
    if (!media.length) return;
    const t0 = Date.now();
    let expected = box.scrollTop, done = 0;
    const realign = () => {
      if (box._pinGen !== my) { done = media.length; return; } // a jump owns the scroll
      if (done >= media.length || Date.now() - t0 > 2500) return;
      if (Math.abs(box.scrollTop - expected) > 2) { done = media.length; return; } // user took over
      const el = box.querySelector(sel);
      if (!el || !el.isConnected) return;
      const want = expected + ((el.getBoundingClientRect().top - box.getBoundingClientRect().top) - anchor.off);
      if (Math.abs(want - box.scrollTop) > 0.5) setScrollTop(box, want, '0');
      expected = box.scrollTop;
    };
    setTimeout(() => { done = media.length; }, 2600);
    for (const m of media) {
      const once = () => {
        m.removeEventListener('load', once); m.removeEventListener('error', once);
        m.removeEventListener('loadedmetadata', once); m.removeEventListener('loadeddata', once);
        done++;
        realign();
      };
      m.addEventListener('load', once); m.addEventListener('error', once);
      if (m.tagName === 'VIDEO') { m.addEventListener('loadedmetadata', once); m.addEventListener('loadeddata', once); }
    }
  } catch {}
}
// Surgical single-message removal for the delete path (socket.js
// message-deleted / dm-deleted, thread replies in pickers.js). A full list
// rebuild recreates EVERY image/avatar node at 0 height and then chases
// the resulting growth with scroll holds — deleting the latest
// (often image-bearing) message that way intermittently stranded the
// reader scrolled up at earlier messages. Removing just the one node
// leaves every other node — and the reader's place — exactly where it
// was: no image reloads, no growth, no chase. Neighbor fixups (the next
// message's grouping, orphaned day dividers, reply-quote placeholders)
// are patched in place. Returns false when the node isn't displayed (or
// nothing would remain — the caller then falls back to a full render,
// which also paints the correct empty placeholder).
function patchDeletedQuotes(box, mid) {
  try {
    if (!box) return;
    const sel = '.reply-quote[data-jump="' + CSS.escape(mid) + '"]';
    box.querySelectorAll(sel).forEach((q) => {
      q.className = 'reply-quote deleted';
      try { q.removeAttribute('data-jump'); } catch {}
      q.innerHTML = '<span class="rq-text">Original message was deleted</span>';
    });
  } catch {}
}
function captureListAnchorExcept(box, skipMid) {
  try {
    const btop = box.getBoundingClientRect().top;
    for (const el of box.querySelectorAll('.msg')) {
      if (skipMid && el.dataset.mid === skipMid) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > btop + 1) return { mid: el.dataset.mid || null, off: r.top - btop };
    }
  } catch {}
  return null;
}
function removeMessageNode(box, arr, mid) {
  try {
    if (!box || !box.isConnected) return false;
    const selMid = (id) => '.msg[data-mid="' + CSS.escape(id) + '"]';
    const node = box.querySelector(selMid(mid));
    if (!node) return false;
    if (S.editing === mid) {
      S.editing = null;
      try { if (S.editRemovals) S.editRemovals.clear(); } catch {}
    }
    const nearBottom = nearLiveBottom(box);
    // Anchor on a message that SURVIVES (never the deleted one) so the
    // restore below is exact no matter what shrank above it — and content
    // removed below the viewport correctly compensates to zero.
    const anchor = nearBottom ? null : captureListAnchorExcept(box, mid);
    const keepDist = box.scrollHeight - box.scrollTop; // fallback (no anchor)
    const sib = node.nextElementSibling;
    const nextMid = sib && sib.classList && sib.classList.contains('msg') ? (sib.dataset.mid || null) : null;
    node.remove();
    patchDeletedQuotes(box, mid);
    if (nextMid) {
      const ni = arr.findIndex((x) => x.id === nextMid);
      const nextNode = box.querySelector(selMid(nextMid));
      if (ni >= 0 && nextNode) {
        const psib = nextNode.previousElementSibling;
        const pMid = psib && psib.classList && psib.classList.contains('msg') ? (psib.dataset.mid || null) : null;
        const pMsg = pMid ? arr.find((x) => x.id === pMid) || null : null;
        let wantGrouped = false;
        try { wantGrouped = !!(pMsg && shouldGroup(pMsg, arr[ni])); } catch { wantGrouped = false; }
        let hasGrouped = false;
        try { hasGrouped = !!nextNode.querySelector('.avatar.ghost'); } catch {}
        if (wantGrouped !== hasGrouped) {
          try { nextNode.replaceWith(messageEl(arr[ni], { grouped: wantGrouped })); } catch {}
        }
      }
    }
    try {
      for (const d of [...box.querySelectorAll('.day')]) {
        const nx = d.nextElementSibling;
        if (!nx || (nx.classList && nx.classList.contains('day'))) d.remove();
      }
    } catch {}
    if (!box.querySelector('.msg')) return false; // caller renders the empty placeholder
    if (nearBottom) { try { setScrollTop(box, box.scrollHeight, '1'); } catch {} }
    else restoreListAnchor(box, anchor, keepDist);
    try { if (typeof updatePill === 'function') updatePill(); } catch {}
    return true;
  } catch { return false; }
}
// A thread reply changes only its root's thread card — repaint that one card in
// place instead of rebuilding the whole list (a full rebuild re-creates every
// avatar/media node and used to visibly jump the scroll). The card carries the
// newest reply as well as the count, so it is rebuilt from the root's model.
function paintThreadCount(rootId) {
  try {
    const el = document.querySelector('#messages [data-mid="' + CSS.escape(rootId) + '"]');
    const root = (S.messages.get(S.channelId) || []).find((x) => x.id === rootId);
    const n = root ? (root.threadCount || 0) : 0;
    const link = el && el.querySelector('.thread-link');
    if (!link) { if (el && n > 0) renderMessages(); return; }
    if (n <= 0) { link.remove(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = threadCardHTML(root);
    const next = tmp.firstElementChild;
    link.replaceWith(next);
    paintThreadCardAvatar(next, root);
  } catch { try { renderMessages(); } catch {} }
}
// A reaction change touches exactly one message's reaction bar. Patch that
// node in place instead of rebuilding the whole list: a full rebuild recreates
// every avatar/media node and (on Safari especially) visibly jumps the scroll
// and flashes avatars. Returns false when the message isn't on screen, so the
// caller falls back to a full render.
function patchMessageReactions(mid, box) {
  if (!box || !box.isConnected || !mid) return false;
  let node = null;
  try { node = box.querySelector('.msg[data-mid="' + CSS.escape(mid) + '"]'); } catch { return false; }
  if (!node) return false;
  const m = msgById(mid);
  if (!m || m.sys) return false;
  const body = node.querySelector('.body');
  if (!body) return false;
  const nearBottom = nearLiveBottom(box);
  const html = reactionsHTML(m);
  const cur = body.querySelector(':scope > .reactions');
  if (!html) {
    if (cur) cur.remove();
  } else {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const next = tmp.firstElementChild;
    if (!cur) {
      // Reactions sit after attachments/poll and before the thread link.
      const after = body.querySelector(':scope > .thread-link');
      body.insertBefore(next, after || null);
    } else {
      // PILL BY PILL — never `cur.replaceWith(next)`. Reacting is TWO updates:
      // this patch (which starts the count roll) and the server's own echo back
      // over the socket a few milliseconds later. Rebuilding the bar on that
      // echo tore down the roll that had just started, so the number snapped and
      // the odometer never got to run — the difference between "it ticks" and
      // "it just changes" was one `replaceWith`.
      const want = new Map();
      for (const b of next.querySelectorAll('.reaction')) want.set(b.dataset.emoji, b);
      for (const b of [...cur.querySelectorAll('.reaction')]) {
        const nb = want.get(b.dataset.emoji);
        if (!nb) { b.remove(); continue; } // that reaction was taken back
        want.delete(b.dataset.emoji);
        const el = b.querySelector('.rcount');
        const was = pillCount(b);
        const now = parseInt((nb.querySelector('.rcount') || {}).textContent || '', 10);
        // Who reacted (and what the tooltip calls them) can change on its own.
        b.classList.toggle('me', nb.classList.contains('me'));
        b.title = nb.title;
        b.setAttribute('aria-label', nb.getAttribute('aria-label'));
        if (!el || !Number.isFinite(now)) continue;
        // Unchanged: leave the node — and any roll still running inside it — as
        // it is. This is the line that lets the odometer survive the echo.
        if (was != null && now === was) continue;
        // Either way it ROLLS: up for a reaction added, down for one taken back.
        // A number with no readable predecessor is the one case that is written
        // straight in — there is nothing to roll from.
        if (was == null) { if (el.textContent !== String(now)) el.textContent = String(now); continue; }
        rollReactionCount(el, was, now, now < was ? 'down' : 'up');
      }
      // A kind the bar did not have yet (somebody's first reaction with it).
      for (const nb of want.values()) cur.appendChild(nb);
      // …then the server's order, moving only what is actually out of place: a
      // move is a re-insert, and re-inserting a pill restarts its animation.
      let ref = cur.firstElementChild;
      for (const nb of next.querySelectorAll('.reaction')) {
        const have = [...cur.querySelectorAll('.reaction')].find((x) => x.dataset.emoji === nb.dataset.emoji);
        if (!have) continue;
        if (have !== ref) cur.insertBefore(have, ref);
        ref = have.nextElementSibling;
      }
    }
  }
  // A bar added/removed changes the column height: keep bottom-pinned readers
  // pinned (a scrolled-up reader's place is untouched — no rebuild, no jump).
  if (nearBottom) { try { setScrollTop(box, box.scrollHeight, '1'); } catch {} }
  try { if (typeof updatePill === 'function') updatePill(); } catch {}
  return true;
}
function renderMessages(force = false) {
  const box = $('#messages');
  const msgs = S.messages.get(S.channelId) || [];
  // Stamp the box with the conversation it now shows: saveScrollPos() refuses
  // to key a list under a different one (see there).
  const ctx = 'server:' + (S.channelId || '');
  // Explicit pin state beats inference: late media (or a viewport that shrank
  // underneath the reader) can push the live bottom further than the 200px
  // band without a single scroll event, and demoting a pinned view there is
  // exactly the "refresh left me up in the history" failure. Only trusted for
  // the conversation already on screen — this box is reused across channels,
  // and a switch must still restore its own anchor. The same rule has to cut
  // the other way too, or a reader who scrolled up a notch here is put back at
  // the bottom by the next repaint: nearLiveBottom reads the flag, and falls
  // back to the band only when the box has no state for this conversation.
  const sameCtx = box.dataset.ctx === ctx;
  // A different conversation than the one on screen: fade the list in so the
  // swap reads as one surface changing rather than two pages cutting. Checked
  // before the stamp below overwrites the old value.
  if (box.dataset.ctx && !sameCtx) convoSwapPulse();
  box.dataset.ctx = ctx;
  const nearBottom = nearLiveBottom(box, sameCtx);
  // Rebuilding the list resets scrollTop to 0 — anchor on the topmost
  // visible message so scrolled-up readers keep their exact place through
  // every background update (reaction, edit, thread reply, status change…).
  const anchor = nearBottom ? null : captureListAnchor(box);
  const keepDist = box.scrollHeight - box.scrollTop; // fallback (anchor scrolled away)
  box.innerHTML = '';
  let lastDay = '', prev = null;
  for (const m of msgs) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { lastDay = day; prev = null; const d = document.createElement('div'); d.className = 'day'; d.textContent = day; box.appendChild(d); }
    box.appendChild(messageEl(m, { grouped: shouldGroup(prev, m) }));
    prev = m;
  }
  if (!msgs.length) box.innerHTML += '<p class="muted" style="text-align:center">No messages yet — say hello.</p>';
  if (force || nearBottom) anchorBottom(box);
  else pinAnchorWhileSettling(box, restoreListAnchor(box, anchor, keepDist));
  updatePill();
}
// Incremental live append: add ONE arriving message without rebuilding the
// whole list. A full rebuild recreates every avatar <img>, which visibly
// flashes (all profile pics disappear/reappear) in Safari on every
// send/receive. Returns false when the list isn't in a plain live-tail
// state — the caller then falls back to a full render.
function appendLiveMessage(box, arr, msg) {
  try {
    if (!box || !msg || !arr.length || arr[arr.length - 1] !== msg) return false;
    if (!box.querySelector('.msg')) return false; // empty/placeholder state
    const prev = arr.length > 1 ? arr[arr.length - 2] : null;
    // Out-of-order arrival (shouldn't happen — the server stamps now()):
    // fall back so ordering stays correct.
    if (prev && (msg.created_at || 0) < (prev.created_at || 0)) return false;
    // Same rule as renderMessages: a pinned reader follows the live tail even
    // if late growth already drifted the geometry out of the near-bottom band —
    // and a reader who scrolled up a notch is NOT dragged down to it by a
    // message arriving (they get the "N new messages" pill instead).
    const nearBottom = nearLiveBottom(box);
    let groupPrev = prev;
    if (!prev || fmtDay(prev.created_at) !== fmtDay(msg.created_at)) {
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = fmtDay(msg.created_at);
      box.appendChild(d);
      groupPrev = null;
    }
    box.appendChild(messageEl(msg, { grouped: shouldGroup(groupPrev, msg) }));
    if (nearBottom) anchorBottom(box);
    updatePill();
    return true;
  } catch { return false; }
}
// Live-tail cap: history loads are bounded (80), but WS arrivals push onto
// the cached arrays (and append DOM nodes) forever — a busy chat left open
// would hoard every message of the session in memory and in the DOM.
// trimLiveTail drops the oldest entries past the cap (returns the count);
// pruneLiveTop removes the same count from the top of the list, holding a
// scrolled-up reader's place by compensating scrollTop for removed height.
// (A full rebuild via renderMessages/renderDmMessages/renderThread repaints
// from the array, so it needs no DOM prune — only incremental appends do.)
const LIVE_TAIL_CAP = 300;
function trimLiveTail(arr, cap) {
  cap = cap || LIVE_TAIL_CAP;
  if (!arr || arr.length <= cap) return 0;
  const drop = arr.length - cap;
  arr.splice(0, drop);
  return drop;
}
function pruneLiveTop(box, n) {
  try {
    if (!box || !box.isConnected || !(n > 0)) return;
    const nearBottom = nearLiveBottom(box);
    const h0 = box.scrollHeight;
    for (let i = 0; i < n; i++) {
      const first = box.querySelector('.msg');
      if (!first) break;
      first.remove();
    }
    for (;;) { // drop orphaned day dividers (a .day with no .msg under it)
      const f = box.firstElementChild;
      if (!f || !f.classList || !f.classList.contains('day')) break;
      const nx = f.nextElementSibling;
      if (!nx || (nx.classList && nx.classList.contains('day'))) f.remove();
      else break;
    }
    if (!nearBottom) setScrollTop(box, Math.max(0, box.scrollTop - (h0 - box.scrollHeight)), '0');
  } catch {}
}
// ---------- history paging: older messages on demand ----------
// A conversation opens on its newest page (80) and stops there. Scrolling up
// near the top pages the next-older 80 in, until the server answers short.
// That is what "no cap" has to mean here: every message stays reachable, but
// the client only ever holds what the reader actually walked back through,
// never the whole archive. Four things make it safe. The cursor is the OLDEST
// LOADED message's own `created_at` — the same strictly-older comparison the
// server already pages on — so the window can never drift onto a message that
// was deleted or re-timestamped. Only a genuinely upward scroll by the reader
// asks for a page (see watchBottomState): growth under a finger is not a
// request. The prepended nodes go in ABOVE the reader with their exact place
// held by an anchor message, and the top of the list carries its own quiet
// status slot — absent until a full page has proved there is an older one,
// then it announces the next page while it is in flight, or the retry when it
// failed. A reader who never scrolls up never sees it and never pays for it.
const HIST_PAGE = 80;          // messages per older page
const HIST_LOAD_PX = 600;      // how close to the top counts as "asking for more"
const histState = new Map();   // convo key -> { done, loading, error, extended }
function historyKey() {
  try {
    if (S.view === 'home') return S.dmThreadId ? 'dm:' + S.dmThreadId : null;
    return (S.serverId && S.channelId) ? 's:' + S.serverId + ':' + S.channelId : null;
  } catch { return null; }
}
// Same key, for a caller holding a pins ctx ({kind,id,serverId?}) instead of
// the live S.view — a jump into a conversation pages from that window's oldest
// message, not from whatever the reader was looking at a moment ago.
function historyKeyFor(ctx) {
  try {
    if (!ctx) return null;
    return ctx.kind === 'dm' ? 'dm:' + ctx.id : ('s:' + ctx.serverId + ':' + ctx.id);
  } catch { return null; }
}
// The reader's conversation just changed: drop the status row left in the
// reused box (the paging state itself is per conversation and is kept).
function resetHistoryTop() {
  try { document.querySelector('#messages > .hist-top')?.remove(); } catch {}
}
// Every conversation's paging state, created on first use — opening a chat and
// scrolling straight up has to ask for older messages even if nothing declared
// the conversation pageable first.
function histStateFor(key) {
  if (!key) return null;
  let st = histState.get(key);
  if (!st) { st = { done: false, loading: false, error: false, extended: false }; histState.set(key, st); }
  return st;
}
// A fresh tail page (or a jump window) arrived, and "is there anything older
// loaded behind it?" is decided HERE, where both halves are known. A page
// shorter than a full one in front of an already-loaded history still has older
// messages waiting behind its cursor, so an extended conversation stays pageable
// and the merge checked out below keeps the loaded history instead of pruning it
// back to the newest page.
//
// Returns { list, extended } — `list` is the array to hand to the cache, and
// is the SAME array when nothing needed merging. That matters: a live append
// holds a reference to it (socket.js), so a needless copy on every channel
// open would be pure waste.
function historyAfterTail(key, fetched, loaded, checkedOut, atLeast) {
  const st = histStateFor(key);
  if (!st) return { list: checkedOut, extended: false };
  const fresh = Array.isArray(fetched) ? fetched : [];
  const had = Array.isArray(loaded) ? loaded : [];
  // `atLeast` is how a jump declares what was loaded when it started: `{ msgs }`
  // is the window around the jump — the state of the world the caller can still
  // page from — which the fetched page does not reach back to. A context jump
  // into a deep conversation therefore stays pageable instead of stranding the
  // reader in a 60-message window.
  const bound = atLeast && atLeast.msgs && atLeast.msgs.length ? atLeast.msgs : null;
  const olderLoaded = !!bound
    ? (fresh.length > bound.length || (fresh.length && bound[0].created_at < fresh[0].created_at))
    : (had.length > HIST_PAGE && had.length > fresh.length
      && had[0] && fresh.length && had[0].created_at < fresh[0].created_at);
  const ext = !!(st.extended && had.length > HIST_PAGE) || olderLoaded;
  st.loading = false;
  st.error = false;
  st.extended = ext;
  // A short page ends the conversation only when nothing older is loaded behind
  // it; a shorter one in front of loaded history leaves its own cursor to pull
  // from, which the next scroll does.
  st.done = fresh.length < HIST_PAGE && !ext;
  const base = ext ? (bound || had) : null;
  if (!ext || !base || !base.length || !fresh.length) return { list: checkedOut, extended: ext };
  // Union, not replacement: everything already walked back through stays put,
  // and anything missed while away (a socket gap, a deploy) fills in behind the
  // tail. Both sides are ordered and deduped by id, so the oldest loaded
  // message — the paging cursor — is still the oldest.
  const seen = new Set(base.map((m) => m.id));
  const add = fresh.filter((m) => m && m.id && !seen.has(m.id));
  const list = add.length
    ? base.concat(add).sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
    : base;
  return { list, extended: ext };
}
// The oldest loaded page in a list that is longer than one tail page — the
// array a paging cursor can be taken from after a replace. Null when the list
// is just the newest page.
function historyExtendedWindow(loaded, fetched) {
  const had = Array.isArray(loaded) ? loaded : [];
  const fresh = Array.isArray(fetched) ? fetched : [];
  if (had.length <= HIST_PAGE) return null;
  if (fresh.length && had[0] && had[0].created_at >= fresh[0].created_at) return null;
  return had.slice(0, Math.max(0, had.length - fresh.length)) || null;
}
// A context jump kept older history as its base: say so, or the next
// historyAfterTail would call the freshly-painted short window "the whole
// conversation" and stop paging into it.
function markHistoryExtended(key) {
  const st = histStateFor(key);
  if (!st) return;
  st.extended = true;
  st.done = false;
  st.error = false;
}
// A full render is a clean slate — the in-flight spinner went with the old
// nodes — so re-offer the status row (it is only ever news before a load).
function paintHistoryTop() {
  try {
    const st = histState.get(historyKey());
    if (!st) return;
    if (st.loading) renderHistoryTopBar('Loading older messages…');
    else if (st.error) renderHistoryTopBar('Could not load older messages — retry');
  } catch {}
}
function renderHistoryTopBar(text) {
  try {
    const box = $('#messages');
    if (!box) return;
    let bar = box.querySelector(':scope > .hist-top');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'hist-top';
      box.insertBefore(bar, box.firstChild);
    }
    bar.textContent = text || '';
    if (!text) bar.remove();
  } catch {}
}
// Called from the scroll watcher once the reader's own movement has carried
// them into the top band of the first loaded page.
async function maybeLoadOlderMessages(box) {
  const key = historyKey();
  if (!key || !box || box._jumpHold) return;
  const st = histStateFor(key);
  if (st.done || st.loading || st.error) return;
  // A pin/quote/search jump replaced the list with a window around one message
  // and set histMode; paging behind that window is a different intent (the
  // Jump-to-present pill owns the way back), so a scroll inside it must not
  // rewrite the context out from under the reader.
  if (S.histMode) return;
  if (box.scrollTop > HIST_LOAD_PX + box.clientHeight) return;
  await loadOlderMessages(box);
}
async function loadOlderMessages(box) {
  const key = historyKey();
  if (!key) return;
  const st = histStateFor(key);
  if (st.done || st.loading) return;
  const arr = S.view === 'home' ? S.dmMessages.get(S.dmThreadId) : S.messages.get(S.channelId);
  if (!arr || !arr.length) return;
  const oldest = arr[0];
  if (!oldest || !oldest.created_at) return;
  const cursor = oldest.created_at;
  const url = S.view === 'home'
    ? `/api/dms/${S.dmThreadId}/messages?limit=${HIST_PAGE}&before=${cursor}`
    : `/api/servers/${S.serverId}/channels/${S.channelId}/messages?limit=${HIST_PAGE}&before=${cursor}`;
  st.loading = true;
  st.error = false;
  renderHistoryTopBar('Loading older messages…');
  // Hold the topmost visible message rather than a distance from the bottom:
  // the page is prepended, so the anchor keeps the exact line under their eye.
  const anchor = captureListAnchor(box) || (oldest.id ? { mid: oldest.id, off: 0 } : null);
  const seamId = (() => { const f = box.querySelector('.msg'); return f ? f.dataset.mid || null : null; })();
  try {
    const { messages } = await api(url);
    if (historyKey() !== key) { st.loading = false; return; } // moved on mid-flight
    const have = new Set(arr.map((m) => m.id));
    const older = [];
    for (const m of (messages || [])) {
      if (!m || !m.id || have.has(m.id) || m.created_at >= cursor) continue;
      have.add(m.id);
      older.push(m);
    }
    st.loading = false;
    // A short page is the beginning of the conversation; a full one keeps the
    // door open for the pull after this.
    st.done = (messages || []).length < HIST_PAGE;
    if (older.length) {
      arr.unshift(...older);
      arr.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
      prependOlderMessages(box, older, anchor, seamId);
    }
    renderHistoryTopBar('');
  } catch {
    st.loading = false;
    st.error = true; // the row becomes the retry — never a silent dead end
    renderHistoryTopBar('Could not load older messages — retry');
  }
}
// The day divider that heads the list before a prepend becomes an orphan when
// the new page is spliced in above it. The page brought its own divider for the
// day it starts with, and the message the old one headed now sits under that one
// instead — left in place it printed a divider with no messages under it and,
// when the two pages started on different days, a LATER day above an earlier one
// ("THU, SEP 10" above "WED, SEP 9"). The seam divider is not necessarily the
// head any more (the status row and the page's own dividers land above it), so
// the orphan is identified by what it IS — the earlier of two dividers for the
// same day — which leaves every legitimate divider below the seam alone and
// needs no date parsing.
function dropOrphanDayDividers(box) {
  try {
    const dividers = [...box.children].filter((c) => c.classList && c.classList.contains('day'));
    // From the end: the LAST divider for a day is the honest one (its messages
    // follow it), and anything earlier with the same label is the orphan.
    // Removing only the earlier copies can never leave a day headless.
    const seen = new Set();
    for (let i = dividers.length - 1; i >= 0; i--) {
      const d = dividers[i];
      if (seen.has(d.textContent)) d.remove();
      else seen.add(d.textContent);
    }
  } catch {}
}
// The divider that owns the day of the list's first message, or null when
// something else (a status row) heads it or no message is painted.
function leadingDayDivider(box, firstMsg) {
  try {
    if (!firstMsg) return null;
    let i = box.children.indexOf(firstMsg);
    if (i <= 0) return null;
    const above = box.children[i - 1];
    return (above && above.classList && above.classList.contains('day')) ? above : null;
  } catch { return null; }
}
// Splice one older page in above what is already painted, holding the reader's
// place with their anchor message. Only two seams need attention: a day divider
// that was the list's first element is now interior (the page brought its own),
// and the first painted message may now group with the newest prepended one.
function prependOlderMessages(box, older, anchor, seamId) {
  if (!box || !older.length) return;
  const firstMsg = box.querySelector('.msg');
  if (!firstMsg) return;
  const wasHeld = box._jumpHold;
  // Our own layout movement, not the reader's scroll: the watcher must not read
  // the scrollTop correction below as an upward scroll (or re-pin a bottom hold).
  box._jumpHold = true;
  try {
    // The divider heading the first message belongs to the day of that message.
    // The page goes in front of IT (not merely in front of the message), or the
    // displaced divider would be left above the page's own dividers — a later
    // day printed above an earlier one.
    const anchorNode = leadingDayDivider(box, firstMsg) || firstMsg;
    let lastDay = '';
    let prev = null;
    const out = [];
    for (const m of [...older].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))) {
      const day = fmtDay(m.created_at);
      if (day !== lastDay) {
        lastDay = day;
        prev = null;
        const d = document.createElement('div');
        d.className = 'day';
        d.textContent = day;
        out.push(d);
      }
      out.push(messageEl(m, { grouped: shouldGroup(prev, m) }));
      prev = m;
    }
    for (const node of out) box.insertBefore(node, anchorNode);
    // Seam 1: the divider that used to head the list is orphaned now — the page
    // brought its own divider for the day it starts with, and the message the old
    // one headed sits under that one instead. Left in place it printed a divider
    // with no messages under it and, when the two pages started on different
    // days, put a LATER day above an earlier one ("THU, SEP 10" above
    // "WED, SEP 9").
    dropOrphanDayDividers(box);
    // Seam 2: the first painted message lost its predecessor, so re-render it
    // with grouping recomputed against the newest message we just prepended.
    if (seamId) {
      const sm = older.find((m) => m.id === seamId);
      if (sm) { try { firstMsg.replaceWith(messageEl(sm, { grouped: false })); } catch {} }
    }
    if (anchor && anchor.mid) {
      const el = box.querySelector('[data-mid="' + CSS.escape(anchor.mid) + '"]');
      if (el) setScrollTop(box, box.scrollTop + ((el.getBoundingClientRect().top - box.getBoundingClientRect().top) - anchor.off), '0');
    }
  } catch {
  } finally {
    box._jumpHold = wasHeld;
  }
}
function replyPreviewOf(m) {
  const t = String(m?.content || '').trim().slice(0, 60);
  if (t) return t;
  if (m?.attachments?.length) return 'an attachment';
  if (m?.poll) return 'a poll';
  return '';
}
// ---------- composer chip thumbnails ----------
// The preview store itself lives with the attachment markup (see "the picked
// bytes as a stand-in for a pending one", near attachmentHTML) because the
// message list reads it too: a chip's thumbnail and the picture the message
// paints while its verdict is pending are the SAME local bytes.
// This is where entries belonging to DROPPED files are torn down (blob urls
// revoked). Anything already sent stays registered: the message that carries it
// paints from those bytes until the slot publishes the final ones, and the size
// cap in setAttPreview* is what bounds the rest.
// The id (and upload url) of every attachment the LIST has painted, with when and
// whether the scan slot has finished with it. A preview whose attachment is in no
// message at all was dropped from a composer (its ✕) after the upload answered, or
// was sent a moment ago — nothing has painted it YET. Those are not the same thing,
// so an unpainted entry gets a grace window rather than an instant release (see
// LOCAL_PREVIEW_UNPAINTED_MS); one that IS in a message is released once the
// verdict has landed and swapped it. A file STILL pending is never released: its
// picked bytes are the only thing on screen, and taking them away would put a
// spinner back where the picture is.
const attPreviewRendered = new Map(); // att id AND the url the bytes were picked under -> { at, done }
function noteAttPreviewRendered(a) {
  try {
    if (!a) return;
    const at = Date.now();
    const done = a.scan === 'clean' || a.scan === 'infected';
    // The id AND the url the picked bytes were registered under. The upload
    // response carries no attachment id (the row's id is minted when the message
    // is inserted), so for the whole upload -> post window the url is the only key
    // that can connect a painted row back to the bytes it was picked from — and
    // without it the entry reads as "nothing ever painted this" and is released.
    for (const k of [String(a.id || ''), String(a.url || '')]) {
      if (!k) continue;
      const prev = attPreviewRendered.get(k);
      attPreviewRendered.set(k, { at, done: done || !!(prev && prev.done) });
    }
  } catch {}
}
function pruneAttPreviews() {
  // Which keys a composer is holding right now: rebuilt every time, so the set
  // can never hold a file that was sent, posted or dropped.
  const staged = new Set();
  for (const a of (S.pendingAtts || [])) { if (a.url) staged.add(a.url); if (a.id) staged.add(String(a.id)); }
  const parked = typeof pendingByCtx !== 'undefined' ? pendingByCtx.values() : [];
  for (const list of parked) for (const a of list) { if (a.url) staged.add(a.url); if (a.id) staged.add(String(a.id)); }
  for (const u of (S.uploads || [])) if (u.att && u.att.url) staged.add(u.att.url);
  attPreviewStaged = staged;
  if (!attPreviews.size) return;
  const now = Date.now();
  for (const [key, entry] of [...attPreviews]) {
    // Still in a composer: never a candidate, and the grace clock restarts.
    if (staged.has(key)) { entry.unstagedAt = 0; continue; }
    // What the message list has painted, by attachment id and by upload url (see
    // noteAttPreviewRendered).
    const seen = attPreviewRendered.get(entry.id) || attPreviewRendered.get(entry.url) || attPreviewRendered.get(key);
    if (!seen) {
      // Nothing has painted it. Two things look exactly like this from here: a
      // file dropped from a composer before it was ever posted, and a file SENT a
      // moment ago whose echo has not arrived yet. Only the first should be
      // released — and releasing the second revokes the blob the row is about to
      // paint from (see LOCAL_PREVIEW_UNPAINTED_MS). So it gets a grace window.
      if (!entry.unstagedAt) entry.unstagedAt = now;
      if (now - entry.unstagedAt < LOCAL_PREVIEW_UNPAINTED_MS) continue;
      releaseAttPreview(key);
      continue;
    }
    entry.unstagedAt = 0;
    if (!seen.done) continue;                                // still waiting on the slot
    if (now - seen.at < LOCAL_PREVIEW_KEEP_MS) continue;     // the swap is this recent
    releaseAttPreview(key);
  }
  if (attPreviewRendered.size > 400) {
    for (const k of attPreviewRendered.keys()) { if (attPreviewRendered.size <= 400) break; attPreviewRendered.delete(k); }
  }
}
const CHIP_IMG_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
const CHIP_VID_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="16" rx="3"/><path d="M16 10l6-3v10l-6-3z"/></svg>';
// A picked Klipy GIF carries no bytes of ours (size 0), so "0 B" as its chip
// readout would look like a broken file. It is a GIF, and that is the label.
function attChipSub(a) {
  const remoteGif = a.kind === 'image' && a.mime === 'image/gif' && !a.size && /^https:\/\//.test(String(a.url || ''));
  return (remoteGif ? 'GIF' : fmtSize(a.size)) + (a.spoiler ? ' · Spoiler' : '');
}
// Thumbnail + name/size stack: media chips get a preview tile (or a
// placeholder icon while a video frame is still being grabbed), other
// attachments just get the two-line name/size layout.
function attChipHTML(a) {
  const media = a.kind === 'image' || a.kind === 'video';
  const src = media ? attPreviewSrc(a) : '';
  const thumb = !media ? ''
    : src ? `<img class="chip-thumb" src="${esc(src)}" alt="" />`
      : `<span class="chip-thumb ph">${a.kind === 'video' ? CHIP_VID_ICON : CHIP_IMG_ICON}</span>`;
  return `${thumb}<span class="chip-info"><span class="chip-name">${esc(a.name)}</span>`
    + `<span class="chip-sub">${attChipSub(a)}</span></span>`;
}
// One chip row for ONE composer: the pending reply first (both bars put it in the
// same row as the files, which is how the chat bar has always drawn it), then
// every staged file. `held` also paints the attachments an exiting upload card is
// still holding — only the chat bar can have those: a thread upload files
// straight into its own list the moment its card leaves (see removeUpload).
function paintComposerChips(box, list, reply, clearReply, held) {
  if (!box) return;
  box.innerHTML = '';
  const hasReply = !!reply, hasAtts = list.length > 0;
  box.classList.toggle('hidden', !hasReply && !hasAtts);
  if (hasReply) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    const rau = msgAuthor(reply);
    chip.innerHTML = `<span>Replying to <b>${esc(rau ? rau.display_name : '?')}</b>: ${esc(replyPreviewOf(reply))}</span>`;
    const x = document.createElement('button'); x.className = 'mini'; x.type = 'button'; x.textContent = '✕';
    x.onclick = () => clearReply();
    chip.appendChild(x); box.appendChild(chip);
  }
  // The chip stage for ONE file starts when THAT file's card has left the stage —
  // not when the list above it is empty. This also paints the attachments an
  // exiting card is still holding (their previews have to stay alive, and the
  // chip is there the moment the card goes), and each of those is the one that
  // waits for its OWN card: a second photo still uploading must never hold the
  // first one's Spoiler toggle back (reported — with several photos the spoiler
  // stage waited for every green bar). removeUpload releases the held attachment
  // and repaints this, so a file's chip and its toggle arrive together.
  const staged = held ? [...list, ...(S.uploads || []).filter((u) => u.att && u.attHere).map((u) => u.att)] : list;
  staged.forEach((a) => {
    const chip = document.createElement('div');
    chip.className = 'att-chip' + (a.scan === 'pending' ? ' scanning' : '');
    chip.innerHTML = attChipHTML(a);
    const x = document.createElement('button'); x.className = 'mini'; x.type = 'button'; x.textContent = '✕';
    x.onclick = () => {
      // Find it rather than trust the index: the list also holds attachments
      // whose upload card is still exiting (see `staged` above). Dropping one
      // of those must take the queued attachment with it, or removeUpload would
      // file it straight back a moment later.
      const at = list.indexOf(a);
      if (at >= 0) list.splice(at, 1);
      const heldUp = (S.uploads || []).find((u) => u.att === a);
      if (heldUp) { heldUp.att = null; heldUp.attHere = false; }
      renderComposerMeta();
    };
    if ((a.kind === 'image' || a.kind === 'video') && !uploadHeldOnStage(a)) {
      const sp = document.createElement('button');
      sp.type = 'button'; sp.className = 'mini' + (a.spoiler ? ' on' : ''); sp.textContent = 'Spoiler'; sp.title = 'Mark as spoiler';
      sp.onclick = () => { a.spoiler = !a.spoiler; renderComposerMeta(); };
      chip.appendChild(sp);
    }
    chip.appendChild(x); box.appendChild(chip);
  });
}
// Repaint BOTH composers. The chat bar and the thread bar are on screen at the
// same time and each owns its own context, chip row and upload list, so one
// repaint entry point keeps every caller (a send, an upload landing, a reply
// chip) from having to know which bar it is talking about.
function renderComposerMeta() {
  syncPendingAttsCtx(); // the open conversation's own attachments (see pendingByCtx)
  paintComposerChips($('#attach-preview'), S.pendingAtts, S.replyTo, () => { S.replyTo = null; renderComposerMeta(); }, true);
  paintComposerChips($('#thread-attach-preview'), threadAtts(), S.threadReplyTo, () => { S.threadReplyTo = null; renderComposerMeta(); }, false);
  pruneAttPreviews();
  try { syncComposerRender(); } catch {}
  try { syncThreadRender(); } catch {}
  try { paintComposerSend(); } catch {}
}
// The thread bar's own repaint entry point (thread switches, the in-thread reply
// chip). One painter for both bars, so they can never drift apart.
function renderThreadComposerMeta() { renderComposerMeta(); }
// Dispatch a Reply from a message. Inside an open thread it replies in-thread;
// otherwise it replies in the main channel. Fixes replying to an in-thread
// message landing outside the thread.
function replyToMsg(m) {
  if (!m) return;
  const inThread = S.thread && S.thread.rootId && (m.id === S.thread.rootId || m.threadRoot === S.thread.rootId);
  if (inThread) {
    S.replyTo = null; S.threadReplyTo = m;
    renderThreadComposerMeta();
    const ti = $('#in-thread'); if (ti) ti.focus();
  } else {
    S.threadReplyTo = null; S.replyTo = m;
    renderComposerMeta();
    const im = $('#in-message'); if (im) im.focus();
  }
}
// ---------- attachments belong to a conversation ----------
// An attachment — and the upload still running for it — belongs to the chat it
// was started in, exactly like the text draft. `S.pendingAtts` is ALWAYS the
// open conversation's list; every other conversation's is parked here and taken
// back when that conversation is opened again. Without this a half-uploaded file
// followed the reader into the next server, painted its progress bar over that
// chat's composer, and (once it landed) became a chip in the wrong conversation
// — one Enter away from being posted there.
const pendingByCtx = new Map(); // ctx -> [attachment, …]
const PENDING_CTX_MAX = 20;     // how many parked conversations are remembered
let pendingCtxKey = null;       // the context S.pendingAtts currently belongs to

function attsCtxNow() { try { return draftCtx(); } catch { return null; } }
function attsListFor(ctx) {
  let list = pendingByCtx.get(ctx);
  if (!list) { list = []; pendingByCtx.set(ctx, list); }
  return list;
}
// The thread bar is a composer of its own, so its staged files live under the
// thread's own context — the same 't:<rootId>' key its draft uses. That is what
// keeps a file picked for a reply out of the channel's list (and off the channel
// composer, which is on screen at the same time), and what lets a reply's files
// survive closing the panel and come back with the thread, exactly like a draft.
function threadAttCtx() { return S.thread && S.thread.rootId ? 't:' + S.thread.rootId : null; }
function threadAtts() {
  const ctx = threadAttCtx();
  if (!ctx) return [];
  return attsListFor(ctx);
}
// Oldest parked conversations fall off the front; the open one is never dropped
// (a Map keeps insertion order, and re-setting an existing key does not move it).
function trimPendingByCtx() {
  if (pendingByCtx.size <= PENDING_CTX_MAX) return;
  for (const k of [...pendingByCtx.keys()]) {
    if (pendingByCtx.size <= PENDING_CTX_MAX) break;
    if (k === pendingCtxKey) continue;
    pendingByCtx.delete(k);
  }
}
// The composer now belongs to another conversation: file what the old one was
// holding under its own key and take back what this one had. Called from
// renderComposerMeta (so every path that repaints the composer for a new context
// gets it for free) and explicitly by the switchers that repaint without it.
function syncPendingAttsCtx() {
  const ctx = attsCtxNow();
  if (ctx === pendingCtxKey) return false;
  if (pendingCtxKey) {
    if ((S.pendingAtts || []).length) pendingByCtx.set(pendingCtxKey, S.pendingAtts.slice());
    else pendingByCtx.delete(pendingCtxKey);
  }
  pendingCtxKey = ctx;
  const saved = ctx ? pendingByCtx.get(ctx) : null;
  if (ctx) pendingByCtx.delete(ctx); // adopted: the composer holds them now
  S.pendingAtts = saved ? saved.slice() : [];
  trimPendingByCtx();
  renderUploads();
  return true;
}
// In-flight uploads for one conversation: the 5-per-message cap is per message,
// and a message belongs to a conversation.
function activeUploadCount(ctx) {
  const k = ctx === undefined ? pendingCtxKey : ctx;
  return (S.uploads || []).filter((u) => u.state === 'uploading' && (k == null || u.ctx == null || u.ctx === k)).length;
}
// ---------- composer uploads: progress cards above the message box ----------
// Each in-flight file gets a card in #upload-list with a live progress bar, %
// readout, spinner, and cancel. XHR (not fetch) so we get upload progress
// events. Finished files move into S.pendingAtts; failures stay on the card
// with a Retry button instead of vanishing into a toast.
let uploadSeq = 0;
// A card can be in either composer's list (the chat bar's or the thread bar's),
// so the lookup is by id across both — an upload belongs to one of them and
// every painter (progress, icon, the held-attachment test) has to find it.
function uploadCardEl(id) {
  return document.querySelector('#upload-list [data-up="' + id + '"], #thread-upload-list [data-up="' + id + '"]');
}
// Is THIS attachment's own upload card still on stage? A card the server has
// answered stays in the list in its green `done` state for a 650ms exit (and a
// failed one stays until it is dismissed), and a chip must not grow its Spoiler
// toggle under a card that is still the thing the reader is looking at. The
// question is per-ATTACHMENT and never about the list as a whole: five photos
// are five independent handovers, so asking "is any card up there?" made the
// first finished photo wait for the last one's green bar (reported). Counted
// from the DOM — exactly the element the reader sees — so the toggle arrives the
// moment that card is gone, whichever way it left.
function uploadHeldOnStage(att) {
  return (S.uploads || []).some((u) => u.att === att && u.attHere && uploadCardEl(u.id));
}
// Repaint both composer lists: the chat bar shows the open conversation's cards,
// the thread bar the open thread's. One entry point (every caller — a progress
// tick, a landing answer, a cancel — repaints whatever it touched without having
// to know which bar that was).
function renderUploads() {
  const tctx = threadAttCtx();
  // Only this conversation's cards. A file uploading in another chat has no
  // business painting a progress bar over this one — and its ✕ cancels a file
  // the reader can no longer see.
  paintUploadList($('#upload-list'), (S.uploads || []).filter((u) => (u.ctx == null ? pendingCtxKey == null : u.ctx === pendingCtxKey)));
  paintUploadList($('#thread-upload-list'), (S.uploads || []).filter((u) => !!tctx && u.ctx === tctx));
}
function paintUploadList(box, mine) {
  if (!box) return;
  box.classList.toggle('hidden', !mine.length);
  const seen = new Set();
  mine.forEach((u) => {
    seen.add(String(u.id));
    let el = box.querySelector('[data-up="' + u.id + '"]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'up-card';
      el.dataset.up = u.id;
      el.innerHTML =
        '<div class="up-ic">' + (u.thumb ? '<img src="' + esc(u.thumb) + '" alt="" />'
          : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>')
          + '<span class="up-spin"></span></div>'
        + '<div class="up-body"><div class="up-top"><span class="up-name"></span><span class="up-pct">0%</span></div>'
        + '<div class="up-track"><div class="up-fill"></div></div><div class="up-sub"></div></div>'
        + '<button type="button" class="mini up-retry hidden">Retry</button>'
        + '<button type="button" class="mini up-x" title="Cancel upload">✕</button>';
      el.querySelector('.up-name').textContent = u.name;
      el.querySelector('.up-x').onclick = () => cancelUpload(u.id);
      el.querySelector('.up-retry').onclick = () => retryUpload(u.id);
      box.appendChild(el);
    }
    paintUploadCard(el, u);
  });
  [...box.children].forEach((el) => { if (!seen.has(el.dataset.up)) el.remove(); });
}
function paintUploadCard(el, u) {
  el.classList.toggle('done', u.state === 'done');
  el.classList.toggle('failed', u.state === 'failed');
  const pct = el.querySelector('.up-pct'), fill = el.querySelector('.up-fill'), sub = el.querySelector('.up-sub');
  const retry = el.querySelector('.up-retry'), x = el.querySelector('.up-x');
  if (u.state === 'done') {
    pct.textContent = '✓'; fill.classList.remove('indet'); fill.style.width = '100%';
    sub.textContent = fmtSize(u.size) + ' · Uploaded';
    retry.classList.add('hidden'); x.classList.add('hidden');
  } else if (u.state === 'failed') {
    pct.textContent = '!'; fill.classList.remove('indet'); fill.style.width = '100%';
    sub.textContent = 'Failed · ' + (u.err || 'upload failed');
    retry.classList.remove('hidden'); x.classList.remove('hidden'); x.title = 'Dismiss';
  } else {
    // The browser hands the whole body to the network stack before the server
    // has answered, so "every byte sent" is not "done": the request is still in
    // flight through the last ACKs, the bucket write and the scan/compress slot.
    // A frozen 99% for that reads as a stuck upload, so once the body is out the
    // bar goes indeterminate and says what it is waiting for.
    const sent = u.total > 0 && u.loaded >= u.total;
    const p = u.total > 0 ? Math.max(0, Math.min(99, Math.round((u.loaded / u.total) * 100))) : 0;
    // The trailing cell is left EMPTY while the card is indeterminate: a bare
    // "…" beside the ✕ reads as a "more options" menu button (reported), and the
    // travelling bar plus "Finishing…" already say what is happening.
    if (u.indet || sent) { pct.textContent = ''; fill.classList.add('indet'); }
    else { pct.textContent = p + '%'; fill.classList.remove('indet'); fill.style.width = p + '%'; }
    sub.textContent = fmtSize(u.size) + (sent ? ' · Finishing…' : ' · Uploading…');
    retry.classList.add('hidden'); x.classList.remove('hidden'); x.title = 'Cancel upload';
  }
}
function patchUploadProgress(u) { const el = uploadCardEl(u.id); if (el) paintUploadCard(el, u); }
// A card's icon is built once at creation; the poster for a video arrives
// later, so patch it into the existing card instead of rebuilding the list.
function paintUploadIcon(u) {
  const el = uploadCardEl(u.id);
  if (!el || !u.thumb) return;
  const ic = el.querySelector('.up-ic');
  if (!ic) return;
  const img = ic.querySelector('img');
  if (img) img.src = u.thumb;
  else try { ic.insertAdjacentHTML('afterbegin', '<img src="' + esc(u.thumb) + '" alt="" />'); } catch {}
}
// Server-owned attachment cap (see /api/config maxUploadMb) — a file the
// server would reject must never start uploading. The fallback mirrors the
// server default so the two can't drift before config lands.
function maxUploadBytes() {
  const mb = Number(S.maxUploadMb);
  return (Number.isFinite(mb) && mb > 0 ? mb : 200) * 1024 * 1024;
}
// Stage one file on a composer. `ctx` names the composer it belongs to: the chat
// bar passes nothing (it stages into the open conversation, see
// syncPendingAttsCtx) and the thread bar passes its thread's own context — both
// bars are on screen at once, so "the current conversation" is not enough to say
// which one a picked file was for.
function uploadAndAttach(file, ctx) {
  if (!file) return;
  // An attachment needs a conversation to belong to (and every finished file is
  // filed under one). The picker/drop paths check this too; the + menu and a
  // paste can reach here with the composer hidden.
  if (!ctx) {
    if (!composerTargetReady()) { toast('Pick a chat first, then attach'); return; }
    syncPendingAttsCtx(); // the open conversation owns the composer (and its list)
  }
  const target = ctx || attsCtxNow();
  if (!target) { toast('Pick a chat first, then attach'); return; }
  const list = target === pendingCtxKey ? (S.pendingAtts || []) : attsListFor(target);
  const maxBytes = maxUploadBytes();
  if (file.size > maxBytes) { toast('File too big (max ' + Math.round(maxBytes / 1048576) + 'MB)'); return; }
  if (list.length + activeUploadCount(target) >= 5) { toast('Max 5 attachments per message'); return; }
  S.uploads = S.uploads || [];
  const entry = {
    id: ++uploadSeq, file, name: file.name || 'file',
    size: file.size || 0, loaded: 0, total: file.size || 0,
    indet: false, state: 'uploading', err: '', xhr: null, thumb: '', att: null,
    // The conversation this upload belongs to (see pendingByCtx): its card only
    // paints there, and the finished attachment is filed there.
    ctx: target,
  };
  const mime = String(file.type || '');
  if (mime.startsWith('image/')) {
    try { entry.thumb = URL.createObjectURL(file); } catch {}
  } else if (mime.startsWith('video/')) {
    // Videos have no <img>-able bytes: grab a frame for the upload card AND for
    // the message that will hold the clip (the card only exists for the length of
    // the upload, so the message — which may already be waiting on the slot —
    // needs its own registration, made when the frame lands), then drop the blob
    // before it holds a large file.
    let src = '';
    try { src = URL.createObjectURL(file); } catch {}
    if (src) {
      entry.vthumbSrc = src;
      whenVideoPoster(src, (shot) => {
        try {
          if (shot) { entry.thumb = shot; paintUploadIcon(entry); }
          // The attachment this clip is about to become may already exist (the
          // upload answered while the frame was being captured): register the
          // frame for the message, and file it under the final url too so the
          // player never starts a download just to redraw a poster it has.
          if (shot && entry.att) {
            if ((S.uploads || []).includes(entry)) {
              try { setAttPreview(entry.att.url, shot, false); } catch {}
            } else {
              try { setAttPreviewFor(entry.att, shot, false); } catch {}
            }
            try { rememberVideoPoster(entry.att.url, shot); } catch {}
            renderComposerMeta();
          }
          if ((S.uploads || []).includes(entry)) renderUploads();
        } finally {
          try { URL.revokeObjectURL(src); } catch {}
          entry.vthumbSrc = '';
        }
      });
    }
  }
  S.uploads.push(entry);
  renderUploads();
  startUpload(entry);
}
// A stalled upload must never shimmer forever, because that bar is the only
// feedback a reader has. The dangerous case is not an error: a phone that slept,
// a half-open connection, or a proxy that dropped the answer leaves the XHR
// pending with NO event at all — no onerror, no onabort, and no timeout of its
// own. Reproduced live: a 36 KB upload whose bytes reached the bucket, whose
// verdict landed 0.5 s later, and whose card still read "Finishing…" minutes on.
//
// Three ceilings, all measured from the last sign of life, so a genuinely slow
// transfer is never killed by them:
//   - the body is still going out and events keep arriving → re-armed per event;
//   - the body is out and the server owes an answer → it answers in
//     milliseconds (it queues compression instead of waiting for it), so a
//     minute and a half of silence means that answer was lost;
//   - the size is unknown, so progress cannot be judged → only a long silence.
const UPLOAD_IDLE_MS = 60 * 1000;
const UPLOAD_IDLE_UNKNOWN_MS = 3 * 60 * 1000;
const UPLOAD_ANSWER_MS = 90 * 1000;
// When this attempt is declared dead. `sentAt` is stamped the moment the browser
// reports every byte handed to the network stack; `lastTick` moves on every
// progress event.
function uploadStalledAt(u) {
  const base = u.sentAt || u.lastTick || u.startedAt || Date.now();
  if (u.sentAt) return base + UPLOAD_ANSWER_MS;
  return base + (u.total > 0 ? UPLOAD_IDLE_MS : UPLOAD_IDLE_UNKNOWN_MS);
}
function checkUploadStall(u) {
  if (!u || u.state !== 'uploading') return;
  if (Date.now() < uploadStalledAt(u)) { armUploadWatchdog(u); return; }
  failUpload(u, 'upload_timeout');
}
function armUploadWatchdog(u) {
  clearTimeout(u.watch);
  u.watch = setTimeout(() => { u.watch = null; checkUploadStall(u); }, Math.max(1000, uploadStalledAt(u) - Date.now()));
}
// The page was hidden while an upload was in flight: background timers are
// throttled there, so the ceiling is re-checked the moment the reader is looking
// again — an honest "Retry" beats a bar that never moves.
function sweepStalledUploads() {
  for (const u of (S.uploads || [])) checkUploadStall(u);
}
// Abandon this attempt's XHR. `u` is reused by Retry (and by a cancel), so a
// late answer from the abandoned request must not be able to run: it would set
// the entry to done and push a SECOND attachment for one file.
function detachUpload(u) {
  const x = u && u.xhr;
  if (!x) return;
  try { x.onload = null; x.onerror = null; x.onabort = null; } catch {}
  try { if (x.upload) x.upload.onprogress = null; } catch {}
  try { x.abort(); } catch {}
  u.xhr = null;
}
function startUpload(u) {
  detachUpload(u);
  u.state = 'uploading'; u.loaded = 0; u.indet = false; u.err = '';
  u.sentAt = 0; u.startedAt = Date.now(); u.lastTick = u.startedAt;
  clearTimeout(u.watch); u.watch = null;
  renderUploads();
  const fd = new FormData();
  fd.append('file', u.file);
  const xhr = new XMLHttpRequest();
  u.xhr = xhr;
  xhr.open('POST', '/api/upload');
  if (store.token) xhr.setRequestHeader('Authorization', 'Bearer ' + store.token);
  xhr.upload.onprogress = (e) => {
    u.lastTick = Date.now();
    if (e.lengthComputable && e.total > 0) { u.loaded = e.loaded; u.total = e.total; u.indet = false; }
    else u.indet = true;
    if (u.total > 0 && u.loaded >= u.total && !u.sentAt) u.sentAt = Date.now();
    armUploadWatchdog(u);
    patchUploadProgress(u);
  };
  xhr.onload = () => {
    clearTimeout(u.watch); u.watch = null;
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300 && data) {
      u.state = 'done'; u.loaded = u.total || u.size;
      // The attachment belongs to the conversation the upload started in, not to
      // whichever one is open now: park it there (and leave the composer alone)
      // when the reader has moved on.
      const here = !u.ctx || u.ctx === pendingCtxKey;
      // The attachment does NOT join its list yet: the card that just answered
      // stays on stage in its green done state for its ~650ms exit, and a chip
      // appearing under it read as the second stage arriving before the first
      // one had finished (reported). It is held on the upload entry instead and
      // filed by removeUpload, which is also what repaints the composer — so the
      // chip arrives exactly when the card has left.
      u.att = data;
      u.attHere = here;
      // The local preview, registered against the attachment's own ID as well as
      // its url (see "the picked bytes as a stand-in for a pending one"): the
      // composer chip reads it now, and the message the file is about to be
      // posted into paints from it while the scan slot holds the bytes back — the
      // picture is on screen from the moment it is sent, not a spinner card. The
      // object URL is a fresh registration, independent of the upload card's
      // `u.thumb` so either side can revoke without breaking the other; the bytes
      // ride along so the store's cap can evict the oldest without weighing files.
      if (data.kind === 'image' && u.file) {
        try { setAttPreviewFor(data, URL.createObjectURL(u.file), true, u.file.size); } catch {}
      } else if (data.kind === 'video') {
        // A frame (a data URL), never the clip's own blob: the upload card's
        // poster came off the picked file, and if it is not captured yet the
        // picked file is still here to capture from (see startVideoPreviewCapture).
        if (u.thumb) videoPreviewShot(data.url, u.thumb);
        else if (u.file) { try { startVideoPreviewCapture(data, URL.createObjectURL(u.file)); } catch {} }
        if (u.thumb) { try { setAttPreviewFor(data, u.thumb, false); } catch {} }
      }
      patchUploadProgress(u);
      setTimeout(() => removeUpload(u.id), 650);
    } else failUpload(u, (data && data.error) || ('http_' + xhr.status));
  };
  xhr.onerror = () => { clearTimeout(u.watch); u.watch = null; failUpload(u, 'network_error'); };
  xhr.onabort = () => { clearTimeout(u.watch); u.watch = null; };
  try { xhr.send(fd); } catch (err) { failUpload(u, err && err.message); return; }
  // Armed from the send rather than from a progress event: a transfer that never
  // reports progress is exactly the one that used to hang with no ceiling at all.
  armUploadWatchdog(u);
}
function failUpload(u, errMsg) {
  if (!u || u.state !== 'uploading') return;
  clearTimeout(u.watch); u.watch = null;
  try { u.err = prettyError(errMsg || 'upload_failed'); } catch { u.err = String(errMsg || 'upload failed'); }
  u.state = 'failed';
  renderUploads();
  toast('Upload failed: ' + u.err);
}
function cancelUpload(id) {
  const u = (S.uploads || []).find((x) => x.id === id);
  if (!u) return;
  detachUpload(u);
  removeUpload(id);
}
function retryUpload(id) {
  const u = (S.uploads || []).find((x) => x.id === id);
  if (!u || u.state !== 'failed') return;
  startUpload(u);
}
function removeUpload(id) {
  const i = (S.uploads || []).findIndex((x) => x.id === id);
  if (i < 0) return;
  const [u] = S.uploads.splice(i, 1);
  if (u) { clearTimeout(u.watch); u.watch = null; }
  // The attachment this card was holding: NOW it becomes a composer chip (see
  // xhr.onload), in the conversation the upload started in — the reader may have
  // moved on, exactly as before.
  if (u && u.att) {
    const home = u.attHere ? S.pendingAtts : attsListFor(u.ctx);
    home.push(u.att);
    u.att = null;
  }
  // The upload card's own thumbnail goes with the card. For a clip that IS the
  // frame the message paints from, so it was handed to the preview store first
  // (xhr.onload) — if that never happened (the capture failed after all), the
  // message simply falls back to the card's url, which is still correct.
  if (u && u.thumb && u.thumb.startsWith('blob:')) { try { URL.revokeObjectURL(u.thumb); } catch {} }
  if (u && u.vthumbSrc) { try { URL.revokeObjectURL(u.vthumbSrc); } catch {} }
  renderUploads();
  // Repaint every time, not only when this card emptied the list: the chip for
  // THIS file (and its Spoiler toggle, see uploadHeldOnStage) is due now that its
  // own card has left, whatever else is still uploading above it.
  renderComposerMeta();
}

$('#btn-attach').onclick = () => $('#in-attach').click();
// The picker takes SEVERAL files at once (owner request). Each one becomes its
// own upload card exactly like a multi-file drop or paste, and the per-message
// cap is applied HERE, off the same `room` calculation, so picking a dozen files
// is one toast instead of a dozen. The selection is walked in order and files
// past the cap are simply dropped — never parked somewhere invisible.
$('#in-attach').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (files.length) {
    if (!composerTargetReady()) toast('Pick a chat first, then attach');
    else {
      const room = Math.max(0, 5 - ((S.pendingAtts || []).length + activeUploadCount(attsCtxNow())));
      if (files.length > room) {
        toast(room > 0
          ? 'Added ' + room + ' of ' + files.length + ' — max 5 attachments per message'
          : 'Max 5 attachments per message');
      }
      files.slice(0, room).forEach((f) => uploadAndAttach(f));
    }
  }
  // File picker steals focus — hand it back so Enter sends right away.
  try { $('#in-message').focus({ preventScroll: true }); } catch { $('#in-message')?.focus(); }
});
// Dialog dismissed without picking: focus was still lost to the picker,
// so restore it for the same Enter-to-send flow.
$('#in-attach').addEventListener('cancel', () => {
  try { $('#in-message').focus({ preventScroll: true }); } catch { $('#in-message')?.focus(); }
});
// The thread bar has its own file input and stages onto its own thread: the chat
// composer is on screen beside it, and a file picked here must never become a
// chip on that one (or a message in the channel).
$('#tbtn-attach').onclick = () => $('#in-thread-attach').click();
$('#in-thread-attach').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  const ctx = threadAttCtx();
  if (files.length && !ctx) toast('That thread is closed');
  else if (files.length) {
    // Same 5-per-message cap and the same one-toast accounting as the chat bar.
    const room = Math.max(0, 5 - (threadAtts().length + activeUploadCount(ctx)));
    if (files.length > room) {
      toast(room > 0
        ? 'Added ' + room + ' of ' + files.length + ' — max 5 attachments per message'
        : 'Max 5 attachments per message');
    }
    files.slice(0, room).forEach((f) => uploadAndAttach(f, ctx));
  }
  try { $('#in-thread').focus({ preventScroll: true }); } catch { $('#in-thread')?.focus(); }
});
$('#in-thread-attach').addEventListener('cancel', () => {
  try { $('#in-thread').focus({ preventScroll: true }); } catch { $('#in-thread')?.focus(); }
});
function composerTargetReady() {
  return S.view === 'home' ? !!S.dmThreadId : !!(S.serverId && S.channelId);
}
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [...(cd.files || [])];
  if (files.length) {
    // screenshots / images / video pasted anywhere go straight to the composer
    e.preventDefault();
    if (!composerTargetReady()) { toast('Pick a chat first, then paste'); return; }
    files.slice(0, 5).forEach((f) => uploadAndAttach(f));
    $('#in-message').focus();
    return;
  }
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  // plain text pasted while the window (not a field) is focused → drop it in the composer
  let text = '';
  try { text = cd.getData('text/plain'); } catch {}
  if (text) {
    if (!composerTargetReady()) return;
    e.preventDefault();
    $('#in-message').focus();
    insertAtCursor($('#in-message'), text);
  }
});
// drag-and-drop files anywhere in the app window → composer attachments.
// Document-level (not just #chat) so drops on the sidebar / member list work
// too — and so a stray drop can never navigate the tab away to the file,
// which would wipe a half-typed message.
//
// A drag that STARTED in this window is never a file drop. Chrome hands a
// dragged <img> over as a temporary FILE, so `dataTransfer.types` really does
// say "Files" — which is why dragging a photo out of a message and letting go
// over the composer used to attach the same picture all over again. `dragstart`
// at capture marks the gesture and it stays marked until the drag ends, so the
// mark cannot be lost by dragging in and out of the page. (Images the app
// renders are also non-draggable now — see the media rules in styles.css — but
// this is the guarantee that does not depend on every render path remembering.)
let dropDepth = 0;
let draggedInApp = false;
const dragHasFiles = (e) => !draggedInApp && [...(e.dataTransfer?.types || [])].includes('Files');
const dropReset = () => {
  draggedInApp = false;
  dropDepth = 0;
  $('#chat').classList.remove('dropping');
};
document.addEventListener('dragstart', () => { draggedInApp = true; }, true);
document.addEventListener('dragend', () => { dropReset(); }, true);
document.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dropDepth++;
  $('#chat').classList.add('dropping');
});
document.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  // relatedTarget is null once the pointer leaves the window: whatever was being
  // dragged is out of our hands, so a mark left over from an internal drag must
  // not survive it (that would refuse the NEXT real file drop).
  if (!e.relatedTarget) draggedInApp = false;
  if (!dragHasFiles(e)) return;
  if (--dropDepth <= 0) { dropDepth = 0; $('#chat').classList.remove('dropping'); }
});
document.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) { dropReset(); return; }
  e.preventDefault();
  const files = [...(e.dataTransfer.files || [])];
  dropReset();
  if (!files.length) return;
  if (!composerTargetReady()) { toast('Pick a chat first, then drop'); return; }
  files.slice(0, 5).forEach((f) => uploadAndAttach(f));
  $('#in-message').focus();
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#in-message');
  const content = inp.value.trim();
  const ctx = draftCtx();
  inp.value = '';
  hideMentionPop();
  const noChat = S.view === 'home' ? !S.dmThreadId : (!S.serverId || !S.channelId);
  // Nothing to send (Enter on an empty box — including one grown tall with
  // stray line breaks) or no conversation open: the box is empty either way,
  // so drop the height with the text and forget the (now empty) draft. The
  // height style lives on the shared composer element, so leaving it behind
  // makes every other chat open with a super-tall box until a reload.
  if ((!content && !S.pendingAtts.length) || noChat) {
    inp.value = content;
    syncComposerRender();
    composerAutoGrow(inp);
    if (!content) draftClear(ctx); // nothing left to restore — kill the phantom draft
    try { paintComposerSend(); } catch {}
    return;
  }
  if (S.view === 'home') sendDm(content, { attachments: S.pendingAtts, replyTo: S.replyTo?.id || null });
  else sendChat(content, { attachments: S.pendingAtts, replyTo: S.replyTo?.id || null });
  draftClear(ctx); // sent: the draft goes with it
  S.pendingAtts = []; S.replyTo = null;
  renderComposerMeta();
  syncComposerRender();
  composerAutoGrow(inp); // programmatic clear doesn't fire 'input', so reset height here
  // Mobile: tapping Send blurs the textarea and collapses the keyboard —
  // refocus synchronously (still in the tap gesture) so it stays open.
  try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
});
function sendChat(content, opts = {}) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({
      t: 'message', serverId: S.serverId, channelId: S.channelId, content,
      attachments: opts.attachments || [], replyTo: opts.replyTo || null, threadRoot: opts.threadRoot || null,
    }));
    // Optimistic: the echo arrives via WS in ms and appends incrementally
    // (see appendLiveMessage) — pin to the bottom now, with the hold, so
    // late image growth between send and echo can't strand the view.
    // A full render here would rebuild every avatar and flash them in Safari.
    if (!opts.threadRoot) { try { const _b = $('#messages'); anchorBottom(_b); updatePill(); } catch {} }
  } else {
    toast('Reconnecting… try again in a second');
  }
}
$('#in-message').addEventListener('input', () => {
  const t = Date.now();
  if (t - S.lastTypingSent > 2500 && S.ws?.readyState === 1) {
    S.lastTypingSent = t;
    if (S.view === 'home' && S.dmThreadId) S.ws.send(JSON.stringify({ t: 'dm-typing', threadId: S.dmThreadId }));
    else S.ws.send(JSON.stringify({ t: 'typing', serverId: S.serverId, channelId: S.channelId }));
  }
});
// …and the reply box says so in ITS thread. The frame carries the root, so the
// server's fan-out (and every reader's strip) can tell a thread reply from a
// channel message without a second event type.
$('#in-thread').addEventListener('input', () => {
  const t = Date.now();
  if (t - S.lastThreadTypingSent > 2500 && S.ws?.readyState === 1 && S.thread) {
    S.lastThreadTypingSent = t;
    S.ws.send(JSON.stringify({ t: 'typing', serverId: S.serverId, channelId: S.channelId, threadRoot: S.thread.rootId }));
  }
});
function paintTyping() {
  const el = $('#typing');
  const bar = $('#typing-bar');
  if (!el) return;
  const entries = [...S.typingNames.entries()].filter(([, n]) => n);
  if (!entries.length) { el.textContent = ''; if (bar) bar.classList.remove('show'); return; }
  const bit = ([id, nm]) => esc(nm) + tagHTML(memberById(id));
  if (entries.length === 1) el.innerHTML = `${bit(entries[0])} is typing…`;
  else if (entries.length === 2) el.innerHTML = `${bit(entries[0])} and ${bit(entries[1])} are typing…`;
  else el.innerHTML = `${bit(entries[0])}, ${bit(entries[1])} and ${entries.length - 2} other${entries.length - 2 === 1 ? '' : 's'} are typing…`;
  if (bar) bar.classList.add('show');
}
function clearTyping() {
  for (const t of S.typingTimers.values()) clearTimeout(t);
  S.typingTimers.clear();
  S.typingNames.clear();
  const el = $('#typing');
  if (el) el.textContent = '';
  const bar = $('#typing-bar');
  if (bar) bar.classList.remove('show');
  // Whatever clears the channel strip (a channel / server / DM switch) leaves the
  // open thread behind with it, so its strip goes too.
  try { clearThreadTyping(); } catch {}
}
// The thread panel's own strip — same wording, same 2.5s lease, a separate map,
// because the two are on screen at once and answer different questions.
function paintThreadTyping() {
  const el = $('#thread-typing');
  const bar = $('#thread-typing-bar');
  if (!el) return;
  const entries = [...S.threadTypingNames.entries()].filter(([, n]) => n);
  if (!entries.length) { el.textContent = ''; if (bar) bar.classList.remove('show'); return; }
  const bit = ([id, nm]) => esc(nm) + tagHTML(memberById(id));
  if (entries.length === 1) el.innerHTML = `${bit(entries[0])} is typing…`;
  else if (entries.length === 2) el.innerHTML = `${bit(entries[0])} and ${bit(entries[1])} are typing…`;
  else el.innerHTML = `${bit(entries[0])}, ${bit(entries[1])} and ${entries.length - 2} other${entries.length - 2 === 1 ? '' : 's'} are typing…`;
  if (bar) bar.classList.add('show');
}
function clearThreadTyping() {
  for (const t of S.threadTypingTimers.values()) clearTimeout(t);
  S.threadTypingTimers.clear();
  S.threadTypingNames.clear();
  paintThreadTyping();
}
function showThreadTyping(userId, name) {
  if (userId === S.me.id) return;
  S.threadTypingNames.set(userId, name || 'Someone');
  paintThreadTyping();
  clearTimeout(S.threadTypingTimers.get(userId));
  S.threadTypingTimers.set(userId, setTimeout(() => {
    S.threadTypingTimers.delete(userId);
    S.threadTypingNames.delete(userId);
    paintThreadTyping();
  }, 2500));
}
function fmtSlow(secs) {
  secs = Number(secs) || 0;
  return secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm';
}
// Slowmode indicator above the input (far right of the typing strip).
// Painted on every channel/DM switch and whenever the server pushes an
// updated channel list, so admin toggles show up live.
function paintSlowmodeHint() {
  const hint = $('#slowmode-hint');
  if (!hint) return;
  const ch = S.view === 'server'
    ? (S.serverDetail?.channels || []).find((c) => c.id === S.channelId) : null;
  const secs = ch && ch.type === 'text' ? (ch.slowmode || 0) : 0;
  if (!secs) { hint.classList.add('hidden'); return; }
  hint.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>Slow mode · ' + fmtSlow(secs) + '</span>';
  hint.title = `You can send one message every ${fmtSlow(secs)} in this channel`;
  hint.classList.remove('hidden');
}
function showTyping(userId, name) {
  if (userId === S.me.id) return;
  S.typingNames.set(userId, name || 'Someone');
  paintTyping();
  clearTimeout(S.typingTimers.get(userId));
  S.typingTimers.set(userId, setTimeout(() => {
    S.typingTimers.delete(userId);
    S.typingNames.delete(userId);
    paintTyping();
  }, 2500));
}

