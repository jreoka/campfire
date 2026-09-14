'use strict';
/* ============ view-once messages (one view + one timed replay) ============
   Media is sent to each selected friend as its own 1:1 DM. The bytes stay
   locked behind a signed ticket until the recipient opens it. The first close
   opens a short replay window (the server's VIEWONCE_REPLAY_MS, 30 seconds) and
   the replay has to be STARTED inside it — started, not finished, so it runs to
   the end of the media. After that, and after the replay itself, the item is
   gone. Unopened items never expire. The composer lives in stories.js
   (viewOnce mode) so the camera, gallery and caption pipeline is shared. */

let voState = null; // { msg, url, kind, mime, caption, replay, consumed }

// The window is a clock, and the server masks an expired one at READ time; the
// card does the same against the clock it is already holding, so the chip flips
// the second it closes instead of whenever the next fetch happens to land.
function voLiveState(vo) {
  const st = (vo && vo.state) || 'unopened';
  if (st === 'replayable' && Number(vo.replayUntil) > 0 && Number(vo.replayUntil) <= Date.now()) return 'consumed';
  return st;
}
function voLeftSecs(vo) {
  const until = Number(vo && vo.replayUntil) || 0;
  return until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
}
function voCardHTML(m) {
  const vo = m && m.viewOnce;
  if (!vo) return '';
  const mine = !!(m.user && S.me && m.user.id === S.me.id);
  const state = voLiveState(vo);
  const isVid = vo.kind === 'video';
  const what = isVid ? 'video' : 'photo';
  if (state === 'consumed') {
    return `<div class="vo-card vo-done"><span class="vo-ico">${isVid ? voIcon('video') : voIcon('image')}</span>`
      + `<span class="vo-main"><span class="vo-title">View-once ${what}</span>`
      + `<span class="vo-sub">${mine ? 'Opened by them' : 'Opened'}</span></span></div>`;
  }
  const replay = state === 'replayable';
  let sub;
  if (replay) {
    // A live window counts itself down in place (voTick) — the label carries
    // the copy for each tick and what to leave behind when it runs out.
    const label = (mine ? 'They can replay · ' : '') + '{n}s left' + (mine ? '' : ' to replay');
    const txt = (mine ? 'They can replay · ' : '') + voLeftSecs(vo) + 's left' + (mine ? '' : ' to replay');
    sub = `<span class="vo-count" data-vo-until="${Number(vo.replayUntil) || 0}" data-vo-label="${label}" data-vo-done="${mine ? 'Opened by them' : 'Replay window closed'}">${txt}</span>`;
    voTickStart();
  } else {
    sub = mine ? 'Waiting to be opened · one view, one replay' : 'Tap to open · one view, one replay';
  }
  return `<button type="button" class="vo-card${replay ? ' vo-replay' : ''}${mine ? ' vo-mine' : ''}" data-vo="${esc(m.id)}"${mine ? ' disabled' : ''}>`
    + `<span class="vo-ico">${isVid ? voIcon('video') : voIcon('image')}</span>`
    + `<span class="vo-main"><span class="vo-title">View-once ${what}${replay ? '<span class="vo-flag"> · replay ready</span>' : ''}</span>`
    + `<span class="vo-sub">${sub}</span></span>`
    + (mine ? '' : `<span class="vo-go">${replay ? 'Replay' : 'Open'}</span>`)
    + '</button>';
}
// One interval for the whole app, running only while a live window is on
// screen. The card ticks in place, so keeping a 30-second promise honest never
// costs a repaint of the message list (and survives one: a rebuild re-renders
// from the payload, which the server has already masked).
let voTickTimer = null;
function voTickStart() { if (!voTickTimer) voTickTimer = setInterval(voTick, 1000); }
function voTick() {
  const nodes = document.querySelectorAll('[data-vo-until]');
  if (!nodes.length) { clearInterval(voTickTimer); voTickTimer = null; return; }
  const now = Date.now();
  for (const n of nodes) {
    const left = Math.ceil((Number(n.dataset.voUntil) - now) / 1000);
    if (left > 0) { n.textContent = String(n.dataset.voLabel || '{n}s left').replace('{n}', left); continue; }
    // Closed: the item is spent (every read says so, and the sweeper's push
    // follows), so take the tap away in the same breath as the countdown.
    n.removeAttribute('data-vo-until');
    n.textContent = n.dataset.voDone || 'Replay window closed';
    const card = n.closest && n.closest('.vo-card');
    if (!card) continue;
    card.disabled = true;
    card.classList.add('vo-expired');
    card.classList.remove('vo-replay');
    const flag = card.querySelector('.vo-flag'); if (flag) flag.remove();
    const go = card.querySelector('.vo-go'); if (go) go.remove();
  }
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
      : err.message === 'replay_expired' ? 'Your replay window has closed'
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
  const capText = String(info.caption || '');
  // Same prose rule as the story viewer's caption: a URL in it is a real link
  // (no preview card here — the stage is one-shot and holds one picture).
  cap.innerHTML = capText && typeof linkifyHTML === 'function' ? linkifyHTML(capText) : esc(capText);
  cap.classList.toggle('hidden', !capText);
  // The window is for STARTING the replay, never for watching it: once the
  // replay is open it plays out, and closing it is what ends the item.
  const secs = voWindowSecs(info);
  $('#vo-sub').textContent = info.state === 'replayable'
    ? 'Replay · closing it ends the item for good'
    : `One view · replay for ${secs}s after you close`;
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
  ovPaintLayer(layer, ovs, { editable: false, links: true });
}
function voRefitOverlays() {
  if (!voState || !voState.info) return;
  voPaintOverlays(voState.info);
}
// The window length the server is actually running (it is a server-owned knob),
// used for the copy the client shows the recipient.
function voWindowSecs(info) {
  return Math.max(1, Math.round((Number(info && info.replayWindowMs) || 30000) / 1000));
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
    if (r.state === 'replayable') {
      // Count from the server's own deadline, not from "30s" — the close that
      // opened this window already cost a few of them.
      const ms = (Number(r.replayUntil) || 0) - Date.now();
      toast('Replay it within ' + Math.max(1, Math.round((ms > 0 ? ms : voWindowSecs(st.info) * 1000) / 1000)) + ' seconds');
    } else toast('View-once closed for good');
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
// A link in the caption or in the markup is the one thing a tap on the stage
// must NOT do: closing consumes the item (one view, then the replay window), so
// following a link would burn the view the reader came for.
$('#vo-stage').onclick = (e) => { if (e.target.closest && e.target.closest('a[href]')) return; closeViewOnce(); };
$('#vo-hint').onclick = () => closeViewOnce();
document.addEventListener('keydown', (e) => { if (voState && e.key === 'Escape') { e.preventDefault(); closeViewOnce(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden && voState) closeViewOnce(); });
