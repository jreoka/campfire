'use strict';
// ---------- messages ----------
function canMod(m) {
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
// Media downloads go through plain anchor navigation (works in every WebView),
// so confirm them with a toast — otherwise the file just lands in Downloads
// with no indication anything happened. Native behavior is untouched.
document.addEventListener('click', (e) => {
  const dl = e.target.closest ? e.target.closest('a.att-dl') : null;
  if (!dl) return;
  toast(`Downloading ${(dl.getAttribute('download') || 'file').slice(0, 60)}…`);
});
function attachmentHTML(a) {
  if (a.kind === 'image') return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" data-fb-name="${esc(a.name)}" data-fb-url="${esc(a.url)}" />${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'video') return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}"><video class="att-vid" src="${esc(a.url)}" controls preload="metadata" playsinline></video>${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'audio') return audioPlayerHTML(a);
  if (textPreviewable(a)) return textFileHTML(a);
  return `<a class="file-card" href="${esc(a.url)}" target="_blank" rel="noopener"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span><span class="fname">${esc(a.name)}</span><br/><span class="fsize">${fmtSize(a.size)}</span></span></a>`;
}
// ---------- video posters: desktop shows the first frame natively, but the
// Android WebView shows a black box + giant play button until playback
// starts. Capture a frame offscreen once per video URL and set it as the
// poster thumbnail so every platform previews the same. Same-origin
// uploads, so the canvas is never tainted.
const videoPosterCache = new Map(); // url -> {img, w, h}
const videoPosterWaiters = new Map();
// Lock the video's true dimensions via width/height attributes: without them
// the element sizes to the 320px poster until playback starts, then jumps to
// the video's intrinsic size (and back on re-render). Attributes reserve the
// same box in every state, so paused and playing sizes match.
function applyVideoPoster(v, p) {
  if (!v || !p) return;
  try { v.poster = p.img; } catch {}
  try { v.setAttribute('width', p.w); v.setAttribute('height', p.h); } catch {}
  v.dataset.posterOk = '1';
}
function ensureVideoPoster(v) {
  if (!v || v.dataset.posterOk) return;
  const url = v.currentSrc || v.src;
  if (!url) return;
  const hit = videoPosterCache.get(url);
  if (hit) { applyVideoPoster(v, hit); return; }
  if (videoPosterWaiters.has(url)) { videoPosterWaiters.get(url).push(v); return; }
  videoPosterWaiters.set(url, [v]);
  const tmp = document.createElement('video');
  tmp.muted = true; tmp.playsInline = true; tmp.preload = 'auto'; tmp.src = url;
  let done = false;
  const finish = (shot) => {
    if (done) return; done = true;
    try { tmp.pause(); tmp.removeAttribute('src'); tmp.load(); } catch {}
    const waiters = videoPosterWaiters.get(url) || [];
    videoPosterWaiters.delete(url);
    if (shot) {
      if (videoPosterCache.size > 60) { try { videoPosterCache.delete(videoPosterCache.keys().next().value); } catch {} }
      videoPosterCache.set(url, shot);
      waiters.forEach((el) => applyVideoPoster(el, shot));
    } else {
      waiters.forEach((el) => { el.dataset.posterOk = '1'; });
    }
  };
  tmp.addEventListener('loadeddata', () => {
    try { tmp.currentTime = Math.min(0.5, (tmp.duration || 1) / 3) || 0.1; }
    catch { finish(null); }
  }, { once: true });
  tmp.addEventListener('seeked', () => {
    try {
      if (!tmp.videoWidth) { finish(null); return; }
      const w = 320, h = Math.max(1, Math.round((w * tmp.videoHeight) / tmp.videoWidth));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(tmp, 0, 0, w, h);
      finish({ img: c.toDataURL('image/jpeg', 0.6), w: tmp.videoWidth, h: tmp.videoHeight });
    } catch { finish(null); }
  }, { once: true });
  tmp.addEventListener('error', () => finish(null), { once: true });
  setTimeout(() => finish(null), 8000);
}
// ---------- stick-to-bottom on media resize ----------
// A video can change size more than once: no intrinsic size until metadata
// loads, the poster-to-frame swap, and some WebViews relayout again when
// playback starts. If the user is sitting at the bottom, stay pinned
// through all of it instead of stranding the view mid-video.
let stickRO = null;
function observeStick(el) {
  if (!el || el.dataset.stickOn) return;
  el.dataset.stickOn = '1';
  try {
    if (!stickRO) {
      stickRO = new ResizeObserver((entries) => {
        for (const e of entries) {
          if (!e.target.isConnected) { try { stickRO.unobserve(e.target); } catch {} continue; }
          const box = e.target.closest ? e.target.closest('#messages,#thread-replies') : null;
          if (!box) continue;
          if (box.scrollHeight - box.scrollTop - box.clientHeight < 200) {
            box.scrollTop = box.scrollHeight;
          }
        }
      });
    }
    stickRO.observe(el);
  } catch {}
}
function reactionsHTML(m) {
  if (!m.reactions?.length) return '';
  return '<div class="reactions">' + m.reactions.map((r) => {
    const em = S.emojiAll[r.emoji.slice(1, -1)];
    const label = r.emoji.startsWith(':') && r.emoji.endsWith(':') && em
      ? `<img class="cemoi" src="${em.url}" alt="${esc(r.emoji)}" data-fb-emoji="${esc(r.emoji)}">`
      : esc(r.emoji);
    return `<button class="reaction${r.me ? ' me' : ''}" data-act="react" data-emoji="${esc(r.emoji)}" title="${r.count}">${label} ${r.count}</button>`;
  }).join('') + '</div>';
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
    const el = card.querySelector('.txt-prev');
    if (!el) return;
    el.textContent = !c || c.status === 'loading' ? 'Loading preview…' : c.status === 'ready' ? (c.preview || '(empty file)') : 'Preview unavailable — download to view.';
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
  const own = m.user && m.user.id === S.me.id;
  const lu = liveUserFor(m.user);
  let inner = grouped
    ? `<span class="avatar ghost" title="${esc(fmtTime(m.created_at))}"><span class="gts">${esc(fmtTime(m.created_at))}</span></span><div class="body">`
    : '<span class="avatar" data-uid="' + (m.user ? m.user.id : '') + '"></span><div class="body">';
  if (!grouped) {
    inner += `<div class="head"><span class="who" data-uid="${m.user ? m.user.id : ''}" style="${nameStyleFor(lu)}">${esc(lu ? lu.display_name : 'deleted')}</span><span class="when">${fmtTime(m.created_at)}</span>${m.edited ? '<span class="edited">(edited)</span>' : ''}</div>`;
  }
  if (m.fwdFrom) {
    inner += `<div class="fwd-tag">Forwarded from <b>${esc(m.fwdFrom)}</b></div>`;
  }
  if (m.replyTo) {
    if (m.replyTo.deleted || (m.replyTo.author === 'deleted' && !m.replyTo.snippet)) {
      inner += `<div class="reply-quote deleted"><span class="rq-text">Original message was deleted</span></div>`;
    } else {
      inner += `<div class="reply-quote" data-jump="${m.replyTo.id}"><span class="rq-author">${esc(m.replyTo.author)}</span><span class="rq-text">${esc(m.replyTo.snippet)}</span></div>`;
    }
  }
  if (S.editing === m.id) {
    inner += `<div class="edit-box"><textarea id="edit-area" maxlength="5000">${esc(m.content)}</textarea><div class="row"><button class="btn small primary" data-act="edit-save">Save</button><button class="btn small" data-act="edit-cancel">Cancel</button></div></div>`;
  } else if (m.content) {
    const big = isBigEmoji(m.content) && !m.attachments?.length;
    inner += `<div class="text${big ? ' bigemoji' : ''}">${renderRich(m.content)}${grouped && m.edited ? ' <span class="edited">(edited)</span>' : ''}</div>`;
    if (!big && typeof linkEmbedsHTML === 'function') inner += linkEmbedsHTML(m.content);
  }
  if (m.attachments?.length) {
    inner += '<div class="msg-atts">' + m.attachments.map(attachmentHTML).join('') + '</div>';
  }
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
  if (!grouped) paintAvatar(div.querySelector('.avatar'), lu);
  try { div.querySelectorAll('video.att-vid').forEach((v) => { ensureVideoPoster(v); observeStick(v); }); } catch {}
  return div;
}
// Discord-style grouping: consecutive messages from the same author collapse
// onto one header (5-minute window; day dividers, replies and forwards
// always start a new group).
const GROUP_MS = 5 * 60 * 1000;
function shouldGroup(prev, m) {
  if (!prev || !m || prev.sys || m.sys) return false;
  if ((prev.user?.id || null) !== (m.user?.id || null)) return false;
  if ((m.created_at - prev.created_at) > GROUP_MS) return false;
  if (m.replyTo || m.fwdFrom) return false;
  return true;
}
function anchorBottom(box) {
  // Lazy `loading` images have 0 height until they load, so the first scroll
  // lands above the true bottom and the content grows under us. Re-anchor on
  // each image settling (they load roughly together, so re-check after every
  // one) to reliably land on the bottom.
  box.scrollTop = box.scrollHeight;
  for (const img of box.querySelectorAll('img')) {
    if (img.complete) continue;
    const once = () => {
      img.removeEventListener('load', once); img.removeEventListener('error', once);
      box.scrollTop = box.scrollHeight;
    };
    img.addEventListener('load', once);
    img.addEventListener('error', once);
  }
  // Same problem for videos: a 720p attach has no intrinsic size until its
  // metadata loads, so the initial scroll strands the view mid-video once it
  // grows. Re-anchor when each video's dimensions settle.
  for (const v of box.querySelectorAll('video')) {
    if (v.readyState >= 1) continue;
    const once = () => {
      v.removeEventListener('loadedmetadata', once);
      v.removeEventListener('loadeddata', once);
      v.removeEventListener('error', once);
      box.scrollTop = box.scrollHeight;
    };
    v.addEventListener('loadedmetadata', once);
    v.addEventListener('loadeddata', once);
    v.addEventListener('error', once);
  }
}
function renderMessages(force = false) {
  const box = $('#messages');
  const msgs = S.messages.get(S.channelId) || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
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
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
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
function replyPreviewOf(m) {
  const t = String(m?.content || '').trim().slice(0, 60);
  if (t) return t;
  if (m?.attachments?.length) return 'an attachment';
  if (m?.poll) return 'a poll';
  return '';
}
function renderComposerMeta() {
  const box = $('#attach-preview');
  box.innerHTML = '';
  const hasReply = !!S.replyTo, hasAtts = S.pendingAtts.length > 0;
  box.classList.toggle('hidden', !hasReply && !hasAtts);
  if (hasReply) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    chip.innerHTML = `<span>Replying to <b>${esc(S.replyTo.user ? S.replyTo.user.display_name : '?')}</b>: ${esc(replyPreviewOf(S.replyTo))}</span>`;
    const x = document.createElement('button'); x.className = 'mini'; x.textContent = '✕';
    x.onclick = () => { S.replyTo = null; renderComposerMeta(); };
    chip.appendChild(x); box.appendChild(chip);
  }
  S.pendingAtts.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    const thumb = a.kind === 'image' ? `<img src="${esc(a.url)}" alt="" />` : '';
    chip.innerHTML = `${thumb}<span>${esc(a.name)} (${fmtSize(a.size)})</span>`;
    const x = document.createElement('button'); x.className = 'mini'; x.textContent = '✕';
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
  chip.innerHTML = `<span>Replying to <b>${esc(S.threadReplyTo.user ? S.threadReplyTo.user.display_name : '?')}</b>: ${esc(replyPreviewOf(S.threadReplyTo))}</span>`;
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
function uploadAndAttach(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) { toast('File too big (max 100MB)'); return; }
  if (S.pendingAtts.length + activeUploadCount() >= 5) { toast('Max 5 attachments per message'); return; }
  S.uploads = S.uploads || [];
  const entry = {
    id: ++uploadSeq, file, name: file.name || 'file',
    size: file.size || 0, loaded: 0, total: file.size || 0,
    indet: false, state: 'uploading', err: '', xhr: null, thumb: '',
  };
  if (String(file.type || '').startsWith('image/')) {
    try { entry.thumb = URL.createObjectURL(file); } catch {}
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
  if (u && u.thumb) { try { URL.revokeObjectURL(u.thumb); } catch {} }
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
  inp.value = '';
  hideMentionPop();
  if (S.view === 'home') {
    if ((!content && !S.pendingAtts.length) || !S.dmThreadId) { inp.value = content; return; }
    sendDm(content, { attachments: S.pendingAtts, replyTo: S.replyTo?.id || null });
  } else {
    if ((!content && !S.pendingAtts.length) || !S.serverId || !S.channelId) { inp.value = content; return; }
    sendChat(content, { attachments: S.pendingAtts, replyTo: S.replyTo?.id || null });
  }
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
    // (see appendLiveMessage) — just jump to the bottom now. A full render
    // here would rebuild every avatar and flash them in Safari.
    if (!opts.threadRoot) { try { const _b = $('#messages'); _b.scrollTop = _b.scrollHeight; updatePill(); } catch {} }
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
  const names = [...S.typingNames.values()].filter(Boolean);
  if (!names.length) { el.textContent = ''; if (bar) bar.classList.remove('show'); return; }
  if (names.length === 1) el.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) el.textContent = `${names[0]} and ${names[1]} are typing…`;
  else el.textContent = `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'} are typing…`;
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

