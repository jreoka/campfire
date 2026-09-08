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
function attachmentHTML(a) {
  if (a.kind === 'image') return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" data-fb-name="${esc(a.name)}" data-fb-url="${esc(a.url)}" />${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'video') return `<span class="att-wrap${a.spoiler ? ' spoiler' : ''}"><video class="att-vid" src="${esc(a.url)}" controls preload="metadata"></video>${attDl(a)}${a.spoiler ? '<button type="button" class="spoiler-veil">Spoiler</button>' : ''}</span>`;
  if (a.kind === 'audio') return audioPlayerHTML(a);
  if (textPreviewable(a)) return textFileHTML(a);
  return `<a class="file-card" href="${esc(a.url)}" target="_blank" rel="noopener"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span><span class="fname">${esc(a.name)}</span><br/><span class="fsize">${fmtSize(a.size)}</span></span></a>`;
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
function audioPlayerHTML(a) {
  const tag = 'vp' + (++vpSeq).toString(36) + Date.now().toString(36).slice(-3);
  return `<div class="vplayer" data-vp="${tag}" data-url="${esc(a.url)}" data-size="${a.size || 0}">`
    + `<button type="button" class="vp-play" data-vp-toggle title="Play"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path class="vp-ic-play" d="M8 5v14l11-7z"/><path class="vp-ic-pause" d="M7 5h4v14H7zM13 5h4v14h-4z" style="display:none"/></svg></button>`
    + `<audio src="${esc(a.url)}" preload="metadata"></audio>`
    + `<div class="vp-body"><div class="vp-bars" data-vp-seek>${'<i></i>'.repeat(VP_BARS)}</div>`
    + `<div class="vp-meta"><span data-vp-cur>0:00</span><span class="vp-dur">…</span></div></div>`
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
  const de = root.querySelector('.vp-dur');
  if (de && isFinite(t.duration)) de.textContent = fmtClock(t.duration);
  vpPaint(root);
  paintPeaks(root, t);
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
  div.className = 'msg';
  div.dataset.mid = m.id;
  const own = m.user && m.user.id === S.me.id;
  const lu = liveUserFor(m.user);
  let inner = '<span class="avatar" data-uid="' + (m.user ? m.user.id : '') + '"></span><div class="body">';
  inner += `<div class="head"><span class="who" data-uid="${m.user ? m.user.id : ''}" style="${nameStyleFor(lu)}">${esc(lu ? lu.display_name : 'deleted')}</span><span class="when">${fmtTime(m.created_at)}</span>${m.edited ? '<span class="edited">(edited)</span>' : ''}</div>`;
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
    inner += `<div class="text${big ? ' bigemoji' : ''}">${renderRich(m.content)}</div>`;
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
  paintAvatar(div.querySelector('.avatar'), lu);
  return div;
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
}
function renderMessages(force = false) {
  const box = $('#messages');
  const msgs = S.messages.get(S.channelId) || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  box.innerHTML = '';
  let lastDay = '';
  for (const m of msgs) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { lastDay = day; const d = document.createElement('div'); d.className = 'day'; d.textContent = day; box.appendChild(d); }
    box.appendChild(messageEl(m));
  }
  if (!msgs.length) box.innerHTML += '<p class="muted" style="text-align:center">No messages yet — say hello.</p>';
  if (force || nearBottom) anchorBottom(box);
  updatePill();
}
function renderComposerMeta() {
  const box = $('#attach-preview');
  box.innerHTML = '';
  const hasReply = !!S.replyTo, hasAtts = S.pendingAtts.length > 0;
  box.classList.toggle('hidden', !hasReply && !hasAtts);
  if (hasReply) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    chip.innerHTML = `<span>Replying to <b>${esc(S.replyTo.user ? S.replyTo.user.display_name : '?')}</b>: ${esc(String(S.replyTo.content || '').slice(0, 60))}</span>`;
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
  chip.innerHTML = `<span>Replying to <b>${esc(S.threadReplyTo.user ? S.threadReplyTo.user.display_name : '?')}</b>: ${esc(String(S.threadReplyTo.content || '').slice(0, 60))}</span>`;
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
async function uploadAndAttach(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) { toast('File too big (max 100MB)'); return; }
  if (S.pendingAtts.length >= 5) { toast('Max 5 attachments per message'); return; }
  const fd = new FormData();
  fd.append('file', file);
  toast('Uploading…');
  try {
    const res = await fetch('/api/upload', { method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload_failed');
    S.pendingAtts.push(data);
    renderComposerMeta();
  } catch (err) { toast('Upload failed: ' + prettyError(err.message)); }
}
$('#btn-attach').onclick = () => $('#in-attach').click();
$('#in-attach').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  uploadAndAttach(f);
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
// drag-and-drop files anywhere over the chat → composer attachments
let dropDepth = 0;
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
$('#chat').addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dropDepth++;
  $('#chat').classList.add('dropping');
});
$('#chat').addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
$('#chat').addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  if (--dropDepth <= 0) { dropDepth = 0; $('#chat').classList.remove('dropping'); }
});
$('#chat').addEventListener('drop', (e) => {
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
});
function sendChat(content, opts = {}) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({
      t: 'message', serverId: S.serverId, channelId: S.channelId, content,
      attachments: opts.attachments || [], replyTo: opts.replyTo || null, threadRoot: opts.threadRoot || null,
    }));
    if (!opts.threadRoot) renderMessages(true);
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
function showTyping(userId, name) {
  if (userId === S.me.id) return;
  $('#typing').textContent = `${name} is typing…`;
  clearTimeout(S.typingTimers.get(userId));
  S.typingTimers.set(userId, setTimeout(() => { $('#typing').textContent = ''; }, 2500));
}

