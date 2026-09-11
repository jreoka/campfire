'use strict';
/* ============ view-once messages (one view + one replay) ============
   Media is sent to each selected friend as its own 1:1 DM. The bytes stay
   locked behind a signed ticket until the recipient opens it, the first close
   leaves one replay, and the second one deletes the media for good. Unopened
   items never expire. The composer lives in stories.js (viewOnce mode) so the
   camera, gallery and caption pipeline is shared. */

let voState = null; // { msg, url, kind, mime, caption, replay, consumed }

function voCardHTML(m) {
  const vo = m && m.viewOnce;
  if (!vo) return '';
  const mine = !!(m.user && S.me && m.user.id === S.me.id);
  const state = vo.state || 'unopened';
  const isVid = vo.kind === 'video';
  const what = isVid ? 'video' : 'photo';
  if (state === 'consumed') {
    return `<div class="vo-card vo-done"><span class="vo-ico">${isVid ? voIcon('video') : voIcon('image')}</span>`
      + `<span class="vo-main"><span class="vo-title">View-once ${what}</span>`
      + `<span class="vo-sub">${mine ? 'Opened by them' : 'Opened'}</span></span></div>`;
  }
  const replay = state === 'replayable';
  const sub = mine
    ? (replay ? 'They can replay it once' : 'Waiting to be opened · one view, one replay')
    : (replay ? 'Tap to use your replay — then it is gone' : 'Tap to open · one view, one replay');
  return `<button type="button" class="vo-card${replay ? ' vo-replay' : ''}${mine ? ' vo-mine' : ''}" data-vo="${esc(m.id)}"${mine ? ' disabled' : ''}>`
    + `<span class="vo-ico">${isVid ? voIcon('video') : voIcon('image')}</span>`
    + `<span class="vo-main"><span class="vo-title">View-once ${what}${replay ? ' · replay ready' : ''}</span>`
    + `<span class="vo-sub">${esc(sub)}</span></span>`
    + (mine ? '' : '<span class="vo-go">Open</span>')
    + '</button>';
}
function voIcon(kind) {
  return kind === 'video'
    ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2.5"/><path d="M15 10.5l6-3.5v10l-6-3.5"/></svg>'
    : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5-6 6"/></svg>';
}
// Delegated: cards render inside chat rows that rebuild often.
document.addEventListener('click', (e) => {
  const card = e.target.closest && e.target.closest('[data-vo]');
  if (!card || card.disabled) return;
  e.preventDefault();
  openViewOnce(card.dataset.vo);
});

async function openViewOnce(mid) {
  if (voState) return;
  let info;
  try {
    info = await api('/api/dm/' + encodeURIComponent(mid) + '/viewonce/open', { method: 'POST' });
  } catch (err) {
    toast(err.message === 'already_opened' ? 'That view-once was already opened'
      : err.message === 'media_gone' ? 'That media is gone'
        : 'Could not open it: ' + prettyError(err.message));
    refreshDms().catch(() => {});
    return;
  }
  const el = $('#vo-view');
  if (!el) return;
  const stage = $('#vo-stage');
  stage.querySelectorAll(':scope > img, :scope > video').forEach((n) => n.remove());
  voState = { mid, replay: info.state === 'replayable', consumed: false, info };
  const cap = $('#vo-cap');
  cap.textContent = info.caption || '';
  cap.classList.toggle('hidden', !info.caption);
  $('#vo-sub').textContent = info.state === 'replayable' ? 'Replay · this one closes for good' : 'One view · you can replay once';
  el.classList.remove('hidden');
  document.body.classList.add('story-open');
  const img = $('#vo-img') || document.createElement('img');
  if (info.kind === 'video') {
    const v = document.createElement('video');
    v.id = 'vo-vid';
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.autoplay = true;
    v.controls = false;
    v.src = info.url;
    v.onerror = () => toast('That media could not be played');
    // One-shot: when the video finishes, close and consume it (the toast
    // already told them if a replay is left).
    v.onended = () => setTimeout(() => { if (voState) closeViewOnce(); }, 500);
    stage.appendChild(v);
    const p = v.play();
    if (p && p.catch) p.catch(() => { v.muted = true; v.play().catch(() => {}); });
    voState.video = v;
    v.addEventListener('loadeddata', () => voPaintOverlays(info), { once: true });
  } else {
    img.id = 'vo-img';
    img.alt = '';
    img.src = info.url;
    stage.appendChild(img);
    if (img.complete && img.naturalWidth) voPaintOverlays(info);
    else img.addEventListener('load', () => voPaintOverlays(info), { once: true });
  }
  clearTimeout(voState.timer);
  const closeHint = $('#vo-hint');
  closeHint.textContent = info.kind === 'video' ? 'The video plays once — tap anywhere to close' : 'Tap anywhere to close';
}
// Markup on a view-once copy: a story sent to an individual friend carries its
// overlays too (the server copies them alongside the bytes), so the one-shot
// player shows the same thing the tray did. Same normalised coordinates, same
// renderer — it just has to wait for the media to have a box.
function voPaintOverlays(info) {
  const layer = $('#vo-ov');
  const stage = $('#vo-stage');
  if (!layer || !stage || !voState) return;
  const ovs = ovParse(info && info.overlays);
  if (!ovs.length) { layer.textContent = ''; layer.classList.add('hidden'); return; }
  const media = stage.querySelector(':scope > video, :scope > img');
  if (!media) return;
  if (!ovFitLayer(layer, stage, media)) return;
  ovPaintLayer(layer, ovs, { editable: false });
}
function voRefitOverlays() {
  if (!voState || !voState.info) return;
  voPaintOverlays(voState.info);
}
async function closeViewOnce() {
  if (!voState) return;
  const st = voState;
  voState = null;
  clearTimeout(st.timer);
  try { if (st.video) { st.video.pause(); st.video.removeAttribute('src'); } } catch {}
  const el = $('#vo-view');
  if (el) el.classList.add('hidden');
  document.body.classList.remove('story-open');
  const stage = $('#vo-stage');
  if (stage) stage.querySelectorAll(':scope > img, :scope > video').forEach((n) => n.remove());
  const ov = $('#vo-ov');
  if (ov) { ov.textContent = ''; ov.classList.add('hidden'); }
  try {
    const r = await api('/api/dm/' + encodeURIComponent(st.mid) + '/viewonce/consume', { method: 'POST' });
    if (r.state === 'replayable') toast('You have one replay left');
    else toast('View-once closed for good');
    applyViewOnceUpdate(r.message);
  } catch { refreshDms().catch(() => {}); }
}
// Patch the message in every cache the client keeps (open DM + thread list).
function applyViewOnceUpdate(msg) {
  if (!msg || !msg.id) return;
  updateMsgInCaches(msg.id, (old) => Object.assign(old, msg));
  if (S.view === 'home' && S.dmThreadId === msg.threadId) {
    // Full rebuild: the card itself changes shape (unopened → replay → opened).
    try { renderDmMessages(); } catch {}
  }
  refreshDms().catch(() => {});
}
// Called by the composer when the user sends a view-once item.
async function sendViewOnce(payload) {
  return api('/api/dm/viewonce', { method: 'POST', body: JSON.stringify(payload) });
}
// ---------- wiring ----------
$('#vo-close').onclick = () => closeViewOnce();
$('#vo-stage').onclick = () => closeViewOnce();
$('#vo-hint').onclick = () => closeViewOnce();
document.addEventListener('keydown', (e) => { if (voState && e.key === 'Escape') { e.preventDefault(); closeViewOnce(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden && voState) closeViewOnce(); });
