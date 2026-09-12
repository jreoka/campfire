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
function attDl(a) { return `<a class="att-dl" href="${esc(a.url)}" download="${esc(a.name)}" target="_blank" rel="noopener" title="Download">${DL_ICON}</a>`; }
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
function attachmentHTML(a) {
  // Virus-scan states (see virus-scan.js): pending files render an
  // animated scanning card and infected files a greyed-out warning —
  // never the bytes, no preview, no download link anywhere.
  if (a.scan === 'infected') return `<div class="scan-block infected"><span class="scan-ic">${SCAN_SHIELD_SVG}</span><span class="scan-tx"><b>${esc(a.name)}</b><span>Virus detected — this file was removed and can't be downloaded.</span></span></div>`;
  if (a.scan === 'pending') return `<div class="scan-block scanning"><span class="scan-tx"><b>${esc(a.name)} (${fmtSize(a.size)})</b><span>Processing file<span class="scan-dots"></span></span><span class="scan-track"><span class="scan-fill"></span></span></span></div>`;
  if (a.kind === 'image') return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" data-fb-name="${esc(a.name)}" data-fb-url="${esc(a.url)}" />${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'video') return `<span class="att-wrap loading${a.spoiler ? ' spoiler' : ''}"><video class="att-vid" src="${esc(a.url)}" controls preload="metadata" playsinline></video><button type="button" class="att-vid-load" aria-label="Play video"><span class="att-spin"></span></button>${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'audio') return audioPlayerHTML(a);
  if (textPreviewable(a)) return textFileHTML(a);
  return `<a class="file-card" href="${esc(a.url)}" target="_blank" rel="noopener"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span><span class="fname">${esc(a.name)}</span><br/><span class="fsize">${fmtSize(a.size)}</span></span></a>`;
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
function markBottomState(box) {
  try { box.dataset.atBottom = (box.scrollHeight - box.scrollTop - box.clientHeight < 200) ? '1' : '0'; } catch {}
}
// Programmatic placement. Records where we put the box so the scroll listener
// can tell our own moves (bottom holds, anchor restores, jumps) apart from the
// reader's — only theirs may un-pin the view. `intent` states the resulting
// pin state outright instead of inferring it from a layout we're mid-way through.
function setScrollTop(box, v, intent) {
  try {
    box.scrollTop = v;
    box._autoTop = box.scrollTop; // the clamped value our own scroll event will report
    if (intent) box.dataset.atBottom = intent;
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
  const noteUser = () => { box._userScrollAt = Date.now(); };
  box.addEventListener('wheel', noteUser, { passive: true });
  box.addEventListener('touchstart', noteUser, { passive: true });
  box.addEventListener('touchmove', noteUser, { passive: true });
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
    if (box.dataset.atBottom === '1' && !userDrove()) {
      // Nobody asked for this — hold the bottom the reader never left.
      setScrollTop(box, box.scrollHeight, '1');
      try { if (typeof updatePill === 'function') updatePill(); } catch {}
      return;
    }
    markBottomState(box);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || box.dataset.atBottom !== '1') return;
    // Lazy media only started loading once we came back — re-pin the reader
    // who was at the bottom when we lost sight of them.
    setScrollTop(box, box.scrollHeight, '1');
    try { if (typeof updatePill === 'function') updatePill(); } catch {}
  });
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
// Count went up on an existing pill: roll the number like an odometer tick
// instead of swapping the digit under the reader's eye. Two stacked copies
// animate past each other, then collapse back to plain text.
function rollReactionCount(el, from, to) {
  try {
    if (!el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = String(to); return; }
    const wrap = document.createElement('span');
    wrap.className = 'rc-roll';
    const a = document.createElement('span'); a.className = 'rc-old'; a.textContent = String(from);
    const b = document.createElement('span'); b.className = 'rc-new'; b.textContent = String(to);
    wrap.append(a, b);
    el.replaceChildren(wrap);
    const settle = () => { if (el.isConnected) el.textContent = String(to); };
    wrap.addEventListener('animationend', settle, { once: true });
    setTimeout(settle, 500); // background tabs / interrupted animations never fire it
  } catch { try { el.textContent = String(to); } catch {} }
}
// ---------- text/code file previews (expandable + downloadable) ----------
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'py', 'pyw', 'rb', 'java', 'c', 'h', 'hpp', 'cpp', 'cc', 'cs', 'go', 'rs', 'php', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'diff', 'patch', 'vue', 'svelte', 'lua', 'dart']);
const TEXT_MIMES = new Set(['application/json', 'application/javascript', 'application/xml', 'application/x-sh']);
function textPreviewable(a) {
  if (!a || (a.size || 0) > 256 * 1024) return false;
  if (/^text\//.test(a.mime || '') || TEXT_MIMES.has(a.mime)) return true;
  const parts = String(a.name || '').split('.');
  return parts.length > 1 && TEXT_EXTS.has(parts.pop().toLowerCase());
}
const txtCache = new Map(); // url -> {status, text, preview, truncated}
function textFileHTML(a) {
  queueTextPreview(a.url);
  const c = txtCache.get(a.url);
  const prev = c && c.status === 'ready'
    ? (c.preview || '(empty file)')
    : (c && c.status === 'err' ? 'Preview unavailable — download to view.' : 'Loading preview…');
  return `<div class="txtfile" data-turl="${esc(a.url)}" data-tname="${esc(a.name)}">`
    + `<div class="txt-head"><span class="txt-ic">&lt;/&gt;</span><span class="txt-name">${esc(a.name)}</span><span class="txt-size">${fmtSize(a.size)}</span><span class="spacer"></span>${attDl(a)}</div>`
    + `<pre class="txt-prev">${esc(prev)}</pre>`
    + `<button type="button" class="mini" data-act="expand-file">Expand</button></div>`;
}
function queueTextPreview(url) {
  if (!url || txtCache.has(url)) { paintTextPreviews(url); return; }
  txtCache.set(url, { status: 'loading' });
  fetch(url).then((r) => { if (!r.ok) throw 0; return r.text(); }).then((t) => {
    const preview = t.split('\n').slice(0, 12).join('\n').slice(0, 1200);
    txtCache.set(url, { status: 'ready', text: t, preview, truncated: t.length > preview.length });
    paintTextPreviews(url);
  }).catch(() => { txtCache.set(url, { status: 'err' }); paintTextPreviews(url); });
}
function paintTextPreviews(url) {
  if (!url) return;
  const c = txtCache.get(url);
  document.querySelectorAll('.txtfile').forEach((card) => {
    if (card.dataset.turl !== url) return;
    // The fetch lands whenever it lands — possibly long after the render.
    // Swapping one line ("Loading preview…") for up to 12 lines grows the
    // card; when that happens at/above the viewport it would shove the
    // reader upward, so hold the view steady across the swap.
    let box = null, hBefore = 0, pin = false;
    try {
      box = card.closest ? card.closest('#messages,#thread-replies') : null;
      if (box && !box.classList.contains('hidden')) {
        const btop = box.getBoundingClientRect().top;
        if (card.getBoundingClientRect().top < btop + 1) { hBefore = card.offsetHeight; pin = true; }
      }
    } catch { box = null; }
    const el = card.querySelector('.txt-prev');
    if (!el) return;
    el.textContent = !c || c.status === 'loading' ? 'Loading preview…' : c.status === 'ready' ? (c.preview || '(empty file)') : 'Preview unavailable — download to view.';
    try {
      if (pin && box) {
        const dh = card.offsetHeight - hBefore;
        if (dh) setScrollTop(box, box.scrollTop + dh);
      }
    } catch {}
  });
}
async function expandTextFile(el) {
  const card = el.closest ? el.closest('.txtfile') : null;
  const url = card && card.dataset.turl, name = (card && card.dataset.tname) || 'file';
  if (!url) return;
  let c = txtCache.get(url);
  if (!c || c.status !== 'ready') {
    try {
      const r = await fetch(url);
      if (!r.ok) throw 0;
      c = { status: 'ready', text: await r.text(), preview: '', truncated: false };
      txtCache.set(url, c);
      paintTextPreviews(url);
    } catch { toast('Could not load file'); return; }
  }
  openModal(name, `<pre class="txt-full">${esc(c.text)}</pre><div class="row" style="margin-top:.6rem"><a class="btn small primary" href="${esc(url)}" download="${esc(name)}">Download</a><button type="button" class="btn small" id="m-copy-txt">Copy</button></div>`, 'Close', null, { wide: true });
  const cp = $('#m-copy-txt');
  if (cp) cp.onclick = () => { try { navigator.clipboard.writeText(c.text); toast('Copied'); } catch {} };
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
function audioPlayerHTML(a) {
  const tag = 'vp' + (++vpSeq).toString(36) + Date.now().toString(36).slice(-3);
  return `<div class="vplayer" data-vp="${tag}" data-url="${esc(a.url)}" data-size="${a.size || 0}">`
    + `<button type="button" class="vp-play" data-vp-toggle title="Play"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path class="vp-ic-play" d="M8 5v14l11-7z"/><path class="vp-ic-pause" d="M7 5h4v14H7zM13 5h4v14h-4z" style="display:none"/></svg></button>`
    + `<audio src="${esc(a.url)}" preload="metadata"></audio>`
    + `<div class="vp-body"><div class="vp-name" title="${esc(a.name)}">${esc(a.name)}</div><div class="vp-bars" data-vp-seek>${'<i></i>'.repeat(VP_BARS)}</div>`
    + `<div class="vp-meta"><span data-vp-cur>0:00</span><span class="vp-dur">…</span></div></div>`
    + `<div class="vp-vol"><button type="button" class="vp-volbtn" data-vp-volbtn title="Volume">${vpVolIcon()}</button>`
    + `<span class="vp-volpop"><input type="range" class="vp-volslider" data-vp-vol min="0" max="1" step="0.01" value="${vpVol}" style="--fill:${Math.round(vpVol * 100)}%" aria-label="Preview volume" /></span></div>`
    + attDl(a) + `</div>`;
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
function messageEl(m, opts = {}) {
  const div = document.createElement('div');
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
    inner += '<div class="msg-atts">' + m.attachments.map(attachmentHTML).join('') + '</div>';
  }
  if (m.viewOnce && typeof voCardHTML === 'function') inner += voCardHTML(m);
  if (m.poll) inner += pollHTML(m);
  inner += reactionsHTML(m);
  if (!opts.inThread && !m.threadRoot && m.threadCount > 0) {
    inner += `<button class="thread-link" data-act="thread">${m.threadCount} ${m.threadCount === 1 ? 'reply' : 'replies'} →</button>`;
  }
  inner += '</div>';
  // hover bar: most-used emoji + more + reply + overflow menu
  let bar = topReactions().map((e) => {
    const em = S.emojiAll[e.slice(1, -1)];
    const label = (e.startsWith(':') && e.endsWith(':') && em)
      ? `<img class="cemoi" src="${em.url}" alt="${esc(e)}">` : esc(e);
    return `<button data-act="react" data-emoji="${esc(e)}" title="${esc(e)}">${label}</button>`;
  }).join('');
  bar += `<button data-act="more" title="More reactions">➕</button><button data-act="reply" title="Reply">↩</button><button data-act="menu" title="More actions">⋯</button>`;
  inner += '<div class="msg-actions">' + bar + '</div>';
  div.innerHTML = inner;
  if (!grouped) paintAvatar(div.querySelector('.avatar'), au);
  try {
    div.querySelectorAll('video.att-vid').forEach((v) => { ensureVideoPoster(v); observeStick(v); });
    // Images grow 0 -> full height on load and shove bottom-pinned readers
    // upward; load/error listeners can miss instant (cached) loads, but the
    // resize itself is always observable — follow it while near the bottom.
    div.querySelectorAll('img.att-img').forEach((img) => observeStick(img));
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
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
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
// A thread reply changes only its root's reply-count link — patch that one
// button in place instead of rebuilding the whole list (a full rebuild
// re-creates every avatar/media node and used to visibly jump the scroll).
function paintThreadCount(rootId) {
  try {
    const el = document.querySelector('#messages [data-mid="' + CSS.escape(rootId) + '"]');
    const root = (S.messages.get(S.channelId) || []).find((x) => x.id === rootId);
    const n = root ? (root.threadCount || 0) : 0;
    const link = el && el.querySelector('.thread-link');
    if (link) {
      if (n > 0) link.textContent = n + ' ' + (n === 1 ? 'reply' : 'replies') + ' →';
      else link.remove();
    } else if (el && n > 0) renderMessages();
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
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  const html = reactionsHTML(m);
  const cur = body.querySelector(':scope > .reactions');
  // Snapshot the counts first: the pill is rebuilt below, so "did this one go
  // up?" can only be answered against the DOM we're about to replace.
  const before = new Map();
  if (cur) {
    for (const b of cur.querySelectorAll('.reaction')) {
      const n = parseInt((b.querySelector('.rcount') || {}).textContent || '', 10);
      before.set(b.dataset.emoji, Number.isFinite(n) ? n : 0);
    }
  }
  if (!html) {
    if (cur) cur.remove();
  } else {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const next = tmp.firstElementChild;
    if (cur) cur.replaceWith(next);
    else {
      // Reactions sit after attachments/poll and before the thread link.
      const after = body.querySelector(':scope > .thread-link');
      body.insertBefore(next, after || null);
    }
    // Existing pill that gained a count → roll its number.
    for (const b of next.querySelectorAll('.reaction')) {
      const was = before.get(b.dataset.emoji);
      const el = b.querySelector('.rcount');
      const now = parseInt((el || {}).textContent || '', 10);
      if (was == null || !el || !Number.isFinite(now) || now <= was) continue;
      rollReactionCount(el, was, now);
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
  // and a switch must still restore its own anchor.
  const pinned = box.dataset.ctx === ctx && box.dataset.atBottom === '1';
  // A different conversation than the one on screen: fade the list in so the
  // swap reads as one surface changing rather than two pages cutting. Checked
  // before the stamp below overwrites the old value.
  if (box.dataset.ctx && box.dataset.ctx !== ctx) convoSwapPulse();
  box.dataset.ctx = ctx;
  const nearBottom = pinned || box.scrollHeight - box.scrollTop - box.clientHeight < 200;
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
    // if late growth already drifted the geometry out of the near-bottom band.
    const nearBottom = box.dataset.atBottom === '1' || box.scrollHeight - box.scrollTop - box.clientHeight < 200;
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
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
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
function replyPreviewOf(m) {
  const t = String(m?.content || '').trim().slice(0, 60);
  if (t) return t;
  if (m?.attachments?.length) return 'an attachment';
  if (m?.poll) return 'a poll';
  return '';
}
// ---------- composer chip thumbnails ----------
// A chat file stays unservable behind /uploads until the scan verdict lands,
// so the picked bytes themselves are the only preview available while an
// attachment waits in the composer: a blob: URL of the File for images, a
// frame grabbed off it for videos (kept as a small JPEG data URL). Entries
// are keyed by the attachment URL and pruned on every composer render, so a
// sent/removed/cleared attachment can never leak its blob.
const attPreviews = new Map(); // att.url -> { src, blob }
function attPreviewSrc(a) {
  if (!a || !a.url) return '';
  const hit = attPreviews.get(a.url);
  if (hit) return hit.src;
  return (a.kind === 'image' && a.scan !== 'pending' && a.scan !== 'infected') ? a.url : '';
}
function setAttPreview(url, src, blob) {
  if (!url || !src) return false;
  const old = attPreviews.get(url);
  if (old && old.blob && old.src !== src) { try { URL.revokeObjectURL(old.src); } catch {} }
  attPreviews.set(url, { src, blob: !!blob });
  return true;
}
function releaseAttPreview(url) {
  const hit = attPreviews.get(url);
  if (!hit) return;
  attPreviews.delete(url);
  if (hit.blob) { try { URL.revokeObjectURL(hit.src); } catch {} }
}
function pruneAttPreviews() {
  if (!attPreviews.size) return;
  const live = new Set((S.pendingAtts || []).map((a) => a.url));
  for (const url of [...attPreviews.keys()]) if (!live.has(url)) releaseAttPreview(url);
}
const CHIP_IMG_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
const CHIP_VID_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="16" rx="3"/><path d="M16 10l6-3v10l-6-3z"/></svg>';
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
    + `<span class="chip-sub">${fmtSize(a.size)}${a.spoiler ? ' · Spoiler' : ''}</span></span>`;
}
function renderComposerMeta() {
  const box = $('#attach-preview');
  box.innerHTML = '';
  const hasReply = !!S.replyTo, hasAtts = S.pendingAtts.length > 0;
  box.classList.toggle('hidden', !hasReply && !hasAtts);
  if (hasReply) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    const rau = msgAuthor(S.replyTo);
    chip.innerHTML = `<span>Replying to <b>${esc(rau ? rau.display_name : '?')}</b>: ${esc(replyPreviewOf(S.replyTo))}</span>`;
    const x = document.createElement('button'); x.className = 'mini'; x.textContent = '✕';
    x.onclick = () => { S.replyTo = null; renderComposerMeta(); };
    chip.appendChild(x); box.appendChild(chip);
  }
  pruneAttPreviews();
  S.pendingAtts.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'att-chip' + (a.scan === 'pending' ? ' scanning' : '');
    chip.innerHTML = attChipHTML(a);
    const x = document.createElement('button'); x.className = 'mini'; x.type = 'button'; x.textContent = '✕';
    x.onclick = () => { S.pendingAtts.splice(i, 1); renderComposerMeta(); };
    if (a.kind === 'image' || a.kind === 'video') {
      const sp = document.createElement('button');
      sp.type = 'button'; sp.className = 'mini' + (a.spoiler ? ' on' : ''); sp.textContent = 'Spoiler'; sp.title = 'Mark as spoiler';
      sp.onclick = () => { a.spoiler = !a.spoiler; renderComposerMeta(); };
      chip.appendChild(sp);
    }
    chip.appendChild(x); box.appendChild(chip);
  });
  syncComposerRender();
  try { paintComposerSend(); } catch {}
}
// Reply chip for the thread composer (mirrors the main-composer reply meta).
function renderThreadComposerMeta() {
  const box = $('#thread-reply-meta');
  if (!box) return;
  box.innerHTML = '';
  box.classList.toggle('hidden', !S.threadReplyTo);
  if (!S.threadReplyTo) return;
  const chip = document.createElement('div');
  chip.className = 'att-chip';
  const trau = msgAuthor(S.threadReplyTo);
  chip.innerHTML = `<span>Replying to <b>${esc(trau ? trau.display_name : '?')}</b>: ${esc(replyPreviewOf(S.threadReplyTo))}</span>`;
  const x = document.createElement('button'); x.className = 'mini'; x.textContent = '✕'; x.type = 'button';
  x.onclick = () => { S.threadReplyTo = null; renderThreadComposerMeta(); };
  chip.appendChild(x); box.appendChild(chip);
}
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
// ---------- composer uploads: progress cards above the message box ----------
// Each in-flight file gets a card in #upload-list with a live progress bar, %
// readout, spinner, and cancel. XHR (not fetch) so we get upload progress
// events. Finished files move into S.pendingAtts; failures stay on the card
// with a Retry button instead of vanishing into a toast.
let uploadSeq = 0;
function activeUploadCount() { return (S.uploads || []).filter((u) => u.state === 'uploading').length; }
function uploadCardEl(id) { const box = $('#upload-list'); return box ? box.querySelector('[data-up="' + id + '"]') : null; }
function renderUploads() {
  const box = $('#upload-list');
  if (!box) return;
  box.classList.toggle('hidden', !(S.uploads || []).length);
  const seen = new Set();
  (S.uploads || []).forEach((u) => {
    seen.add(String(u.id));
    let el = uploadCardEl(u.id);
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
    const p = u.total > 0 ? Math.min(99, Math.round((u.loaded / u.total) * 100)) : 0;
    pct.textContent = u.indet ? '…' : p + '%';
    if (u.indet) fill.classList.add('indet');
    else { fill.classList.remove('indet'); fill.style.width = p + '%'; }
    sub.textContent = fmtSize(u.size) + ' · Uploading…';
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
function uploadAndAttach(file) {
  if (!file) return;
  const maxBytes = maxUploadBytes();
  if (file.size > maxBytes) { toast('File too big (max ' + Math.round(maxBytes / 1048576) + 'MB)'); return; }
  if (S.pendingAtts.length + activeUploadCount() >= 5) { toast('Max 5 attachments per message'); return; }
  S.uploads = S.uploads || [];
  const entry = {
    id: ++uploadSeq, file, name: file.name || 'file',
    size: file.size || 0, loaded: 0, total: file.size || 0,
    indet: false, state: 'uploading', err: '', xhr: null, thumb: '', att: null,
  };
  const mime = String(file.type || '');
  if (mime.startsWith('image/')) {
    try { entry.thumb = URL.createObjectURL(file); } catch {}
  } else if (mime.startsWith('video/')) {
    // Videos have no <img>-able bytes: grab a frame for both the upload card
    // and the composer chip, then drop the blob before it holds a large file.
    let src = '';
    try { src = URL.createObjectURL(file); } catch {}
    if (src) {
      entry.vthumbSrc = src;
      whenVideoPoster(src, (shot) => {
        try {
          if (shot) { entry.thumb = shot; paintUploadIcon(entry); }
          if ((S.uploads || []).includes(entry)) renderUploads();
          if (shot && entry.att) { setAttPreview(entry.att.url, shot, false); renderComposerMeta(); }
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
function startUpload(u) {
  u.state = 'uploading'; u.loaded = 0; u.indet = false; u.err = '';
  renderUploads();
  const fd = new FormData();
  fd.append('file', u.file);
  const xhr = new XMLHttpRequest();
  u.xhr = xhr;
  xhr.open('POST', '/api/upload');
  if (store.token) xhr.setRequestHeader('Authorization', 'Bearer ' + store.token);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable && e.total > 0) { u.loaded = e.loaded; u.total = e.total; u.indet = false; }
    else u.indet = true;
    patchUploadProgress(u);
  };
  xhr.onload = () => {
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300 && data) {
      u.state = 'done'; u.loaded = u.total || u.size;
      S.pendingAtts.push(data);
      u.att = data;
      // Thumbnail for the composer chip (see attPreviews). The image's own
      // object URL is a fresh registration, independent of the upload card's
      // `u.thumb` so either side can revoke without breaking the other.
      if (data.kind === 'image' && u.file && !attPreviews.has(data.url)) {
        try { setAttPreview(data.url, URL.createObjectURL(u.file), true); } catch {}
      } else if (data.kind === 'video' && u.thumb && !attPreviews.has(data.url)) {
        setAttPreview(data.url, u.thumb, false);
      }
      renderComposerMeta();
      patchUploadProgress(u);
      setTimeout(() => removeUpload(u.id), 650);
    } else failUpload(u, (data && data.error) || ('http_' + xhr.status));
  };
  xhr.onerror = () => failUpload(u, 'network_error');
  try { xhr.send(fd); } catch (err) { failUpload(u, err && err.message); }
}
function failUpload(u, errMsg) {
  if (!u || u.state !== 'uploading') return;
  try { u.err = prettyError(errMsg || 'upload_failed'); } catch { u.err = String(errMsg || 'upload failed'); }
  u.state = 'failed';
  renderUploads();
  toast('Upload failed: ' + u.err);
}
function cancelUpload(id) {
  const u = (S.uploads || []).find((x) => x.id === id);
  if (!u) return;
  try { if (u.xhr && u.state === 'uploading') u.xhr.abort(); } catch {}
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
  if (u && u.thumb && u.thumb.startsWith('blob:')) { try { URL.revokeObjectURL(u.thumb); } catch {} }
  if (u && u.vthumbSrc) { try { URL.revokeObjectURL(u.vthumbSrc); } catch {} }
  renderUploads();
}

$('#btn-attach').onclick = () => $('#in-attach').click();
$('#in-attach').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  uploadAndAttach(f);
  // File picker steals focus — hand it back so Enter sends right away.
  try { $('#in-message').focus({ preventScroll: true }); } catch { $('#in-message')?.focus(); }
});
// Dialog dismissed without picking: focus was still lost to the picker,
// so restore it for the same Enter-to-send flow.
$('#in-attach').addEventListener('cancel', () => {
  try { $('#in-message').focus({ preventScroll: true }); } catch { $('#in-message')?.focus(); }
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
let dropDepth = 0;
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
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
  if (!dragHasFiles(e)) return;
  if (--dropDepth <= 0) { dropDepth = 0; $('#chat').classList.remove('dropping'); }
});
document.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dropDepth = 0;
  $('#chat').classList.remove('dropping');
  const files = [...(e.dataTransfer.files || [])];
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

