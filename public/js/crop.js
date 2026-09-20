'use strict';
// ---------- the profile-media crop stage ----------
// Setting an avatar, a banner or the member-list banner goes through here first.
//
// WHY a stage at all: every render site frames these pictures on its own —
// `background-size: cover` in a 300x88 card, a circle for an avatar, a
// right-anchored strip for a sidebar row — so a photo with the subject
// off-centre, or a Klipy GIF whose subject sits in one corner, is cropped by the
// stylesheet rather than by the person who chose it. The bytes are the only
// place the framing can be decided once, and this is where they are decided.
//
// WHY it is not a <canvas>: an animated GIF drawn into a canvas is its first
// frame, and half of what these three fields are for is animated GIFs. So the
// picture here is a BACKGROUND LAYER whose size and position this module
// rewrites — the browser keeps animating it while you frame it — and the encode
// itself is the server's (image-crop.js, ffmpeg), which is the only thing in the
// stack that can crop an animation and hand back an animation.
//
// The window IS the result. #crop-stage has the shape of the surface being set,
// the picture inside it is cover-fitted, and `cropViewRect()` turns what is
// visible into the source-pixel rectangle the server is asked for; the preview
// under the window wears the SAME transform scaled to its own box, so it shows
// the crop rather than a second look at the original.
//
// The arithmetic (cropViewInit / cropViewClamp / cropViewZoomAt / cropViewRect /
// cropBgStyle) is deliberately DOM-free and marked off below: it is the part
// that can be wrong in a way nobody sees, and scripts/test-image-crop.js drives
// it directly.
const CROP_KINDS = {
  // `aspect` is the WINDOW's width/height — the shape the surface really is, so
  // what you frame is what shows. avatar is the circle, banner is the 300x88
  // card (3:1), sidebar is a member row (~250x40, right-anchored, so ~6:1). The
  // byte cap for each lives in image-crop.js (CROP_KINDS.cap).
  avatar: { aspect: 1, title: 'Crop avatar', cls: 'k-avatar', prev: 76, hint: 'Square — an avatar is shown in a circle, so the corners go.' },
  banner: { aspect: 3, title: 'Crop banner', cls: '', prev: 228, hint: 'Shown across your profile card and your profile page.' },
  sidebar: { aspect: 6, title: 'Crop member list banner', cls: '', prev: 268, hint: 'Shown faded behind your name in the member list and the DM list.' },
};
// ---------- the crop transform (pure: no DOM, no globals) ----------
// Everything down to the end marker is arithmetic on plain objects — no element,
// no state, nothing from the rest of the file. It is the part that can be wrong
// in a way nobody SEES (a rectangle one pixel outside the picture, a zoom that
// drags the picture sideways), so it is fenced off and driven directly by
// scripts/test-image-crop.js.
const CROP_MAX_ZOOM = 4;
// The scale at which the picture exactly covers the window — the farthest out it
// may ever be pulled, because anything less would show bare stage.
function cropCoverScale(natW, natH, winW, winH) {
  return Math.max(winW / natW, winH / natH);
}
function cropViewInit(natW, natH, winW, winH) {
  const scale = cropCoverScale(natW, natH, winW, winH);
  return cropViewClamp({ natW, natH, winW, winH, scale, ox: (winW - natW * scale) / 2, oy: (winH - natH * scale) / 2 });
}
// Clamp into the two rules the window has: scale never below cover and never
// past CROP_MAX_ZOOM x it, and the picture never leaves a bare edge inside the
// window (a picture wider than the window slides between 0 and winW - dw).
function cropViewClamp(v) {
  const min = cropCoverScale(v.natW, v.natH, v.winW, v.winH);
  const max = min * CROP_MAX_ZOOM;
  const scale = Math.min(Math.max(Number(v.scale) || min, min), max);
  const dw = v.natW * scale, dh = v.natH * scale;
  const ox = Math.min(0, Math.max(v.winW - dw, Number(v.ox) || 0));
  const oy = Math.min(0, Math.max(v.winH - dh, Number(v.oy) || 0));
  return { natW: v.natW, natH: v.natH, winW: v.winW, winH: v.winH, scale, min, max, ox, oy };
}
// Zoom about a point IN THE WINDOW (its top-left is 0,0): the source pixel under
// that point stays under it, which is what makes a wheel or a pinch feel like it
// is pulling the picture rather than the frame.
function cropViewZoomAt(v, scale, px, py) {
  const sx = (px - v.ox) / v.scale, sy = (py - v.oy) / v.scale;
  return cropViewClamp({ ...v, scale, ox: px - sx * scale, oy: py - sy * scale });
}
// The rectangle of SOURCE pixels the window is showing: what the server crops.
function cropViewRect(v) {
  const x = Math.round(-v.ox / v.scale);
  const y = Math.round(-v.oy / v.scale);
  return {
    x, y,
    w: Math.max(1, Math.round(v.winW / v.scale)),
    h: Math.max(1, Math.round(v.winH / v.scale)),
  };
}
// The same view expressed as CSS for a box that is `k` times the window (the
// preview). Sizes and positions in px, never percentages: the clamping above is
// written for an image whose TOP-LEFT sits at (ox, oy), which is exactly what a
// percentage position would not mean.
function cropBgStyle(v, k) {
  const dw = v.natW * v.scale * k, dh = v.natH * v.scale * k;
  return { size: `${dw}px ${dh}px`, pos: `${v.ox * k}px ${v.oy * k}px` };
}
// ---------- end of the pure transform ----------

// The open stage, if any. One at a time: a second open replaces the first.
let cropState = null;

function cropOpen() { return !!cropState; }

function cropStageEl() { return $('#crop-stage'); }

// Size the window and the preview from the panel's real width. The window is as
// wide as the panel allows and as tall as the shape wants, capped so an avatar
// (1:1) cannot take the whole screen on a phone.
function cropSizeStage() {
  const st = cropState;
  if (!st || !st.natW) return;
  const body = cropStageEl().parentElement;
  const availW = Math.max(120, Math.min(body.clientWidth || 320, 520));
  const availH = Math.max(88, Math.min((window.innerHeight || 700) * 0.44, 380));
  let w = availW, h = w / st.spec.aspect;
  if (h > availH) { h = availH; w = h * st.spec.aspect; }
  st.winW = Math.round(w);
  st.winH = Math.round(h);
  const stage = cropStageEl();
  stage.style.width = st.winW + 'px';
  stage.style.height = st.winH + 'px';
  // A resize (rotation, a window drag) re-fits the picture to the new window
  // instead of leaving it wherever the old geometry put it.
  st.view = cropViewInit(st.natW, st.natH, st.winW, st.winH);
  const prev = $('#crop-preview');
  st.prevW = Math.max(48, Math.min(st.spec.prev, availW));
  prev.style.width = st.prevW + 'px';
  prev.style.height = Math.round(st.prevW / (st.winW / st.winH)) + 'px';
}

// Paint the window and the preview from the current view.
function cropPaint() {
  const st = cropState;
  if (!st || !st.view) return;
  const v = st.view;
  const stage = cropStageEl();
  stage.style.backgroundSize = `${v.natW * v.scale}px ${v.natH * v.scale}px`;
  stage.style.backgroundPosition = `${v.ox}px ${v.oy}px`;
  const k = st.prevW / v.winW;
  const bg = cropBgStyle(v, k);
  const prev = $('#crop-preview');
  prev.style.backgroundSize = bg.size;
  prev.style.backgroundPosition = bg.pos;
  const z = $('#crop-zoom');
  if (z) z.value = String(v.scale / v.min);
}

function cropApply(next) {
  cropState.view = next;
  cropPaint();
}

// Open the stage on a File or a remote (Klipy) image URL. `opts.endpoint`
// defaults to the caller's own surface; `opts.onDone(data)` runs after a
// successful save, with the server's answer, once the stage is closed.
function openCropStage(opts) {
  const o = opts || {};
  const kind = String(o.kind || '');
  const spec = CROP_KINDS[kind];
  if (!spec) return;
  const file = o.file || null;
  const remote = o.url ? String(o.url) : '';
  if (!file && !remote) return;
  closeCropStage();
  const src = { file, url: remote, objectUrl: '' };
  // A picked file is shown from a blob URL — same origin as the page, so no
  // cross-origin taint and nothing is uploaded to preview it.
  if (file) { try { src.objectUrl = URL.createObjectURL(file); } catch { src.objectUrl = ''; } }
  const href = src.objectUrl || remote;
  if (!href) return;
  const st = {
    kind, spec, src, href,
    endpoint: o.endpoint || `/api/me/${kind}/crop`,
    onDone: typeof o.onDone === 'function' ? o.onDone : null,
    natW: 0, natH: 0, winW: 0, winH: 0, prevW: 0, view: null,
    pointers: new Map(), pinch: null, saving: false,
  };
  cropState = st;
  $('#crop-title').textContent = spec.title;
  $('#crop-hint').textContent = spec.hint || '';
  const prev = $('#crop-preview');
  prev.className = 'crop-preview' + (spec.cls ? ' ' + spec.cls : '');
  prev.style.backgroundImage = `url("${href}")`;
  const stage = cropStageEl();
  stage.style.backgroundImage = `url("${href}")`;
  stage.style.backgroundSize = '';
  stage.style.backgroundPosition = '';
  stage.classList.remove('grabbing');
  $('#crop-zoom').value = '1';
  const save = $('#crop-save');
  save.disabled = true;
  save.textContent = 'Save';
  $('#crop-backdrop').classList.remove('hidden');
  // Measure the natural size before anything can be framed: the window's shape
  // and the crop math both need it, and a file that will not decode has to fail
  // here rather than at Save.
  const probe = new Image();
  probe.onload = () => {
    if (cropState !== st) return;
    st.natW = probe.naturalWidth || 0;
    st.natH = probe.naturalHeight || 0;
    if (!st.natW || !st.natH) { closeCropStage(); toast('Could not read that image'); return; }
    cropSizeStage();
    cropPaint();
    save.disabled = false;
  };
  probe.onerror = () => {
    if (cropState !== st) return;
    closeCropStage();
    toast('Could not load that image');
  };
  probe.src = href;
}

function closeCropStage() {
  const st = cropState;
  if (!st) return;
  cropState = null;
  $('#crop-backdrop').classList.add('hidden');
  const stage = cropStageEl();
  stage.classList.remove('grabbing');
  stage.style.backgroundImage = '';
  stage.style.backgroundSize = '';
  stage.style.backgroundPosition = '';
  const prev = $('#crop-preview');
  prev.style.backgroundImage = '';
  prev.style.backgroundSize = '';
  prev.style.backgroundPosition = '';
  if (st.src.objectUrl) { try { URL.revokeObjectURL(st.src.objectUrl); } catch {} }
}

async function cropSave() {
  const st = cropState;
  if (!st || st.saving || !st.view) return;
  st.saving = true;
  const btn = $('#crop-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const rect = cropViewRect(st.view);
  try {
    // A picked file goes up as bytes (the server crops what it is given); a
    // Klipy URL goes up as a URL, and the SERVER fetches it — a canvas here
    // could not even read a cross-origin GIF back out, and cropping it would
    // flatten the animation besides.
    const data = st.src.file
      ? await uploadImage(st.endpoint, st.src.file, rect)
      : await api(st.endpoint, { method: 'POST', body: JSON.stringify({ url: st.src.url, ...rect }) });
    const done = st.onDone;
    closeCropStage();
    if (done) { try { await done(data); } catch {} }
  } catch (err) {
    st.saving = false;
    btn.disabled = false;
    btn.textContent = 'Save';
    toast('Crop failed: ' + prettyError(err.message));
  }
}

// ---------- the window's gestures ----------
// Pointer events only (mouse, touch and pen through one path). A phone drags
// with one finger and pinches with two; a desktop drags, scrolls to zoom, or
// uses the slider.
function cropPinchInfo() {
  const st = cropState;
  const pts = [...st.pointers.values()];
  const a = pts[0], b = pts[1];
  const box = cropStageEl().getBoundingClientRect();
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    mid: { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top },
  };
}
function cropPointerDown(e) {
  const st = cropState;
  if (!st || !st.view || st.saving) return;
  try { cropStageEl().setPointerCapture(e.pointerId); } catch {}
  st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (st.pointers.size === 2) st.pinch = cropPinchInfo();
  cropStageEl().classList.add('grabbing');
  e.preventDefault();
}
function cropPointerMove(e) {
  const st = cropState;
  if (!st || !st.view || st.saving) return;
  const p = st.pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (st.pointers.size >= 2 && st.pinch) {
    const now = cropPinchInfo();
    // Pan by the midpoint's travel first, then zoom about where it landed: the
    // fingers both move the picture and pull it apart.
    const moved = cropViewClamp({ ...st.view, ox: st.view.ox + (now.mid.x - st.pinch.mid.x), oy: st.view.oy + (now.mid.y - st.pinch.mid.y) });
    cropApply(cropViewZoomAt(moved, moved.scale * (now.dist / st.pinch.dist), now.mid.x, now.mid.y));
    st.pinch = now;
    return;
  }
  cropApply(cropViewClamp({ ...st.view, ox: st.view.ox + dx, oy: st.view.oy + dy }));
}
function cropPointerUp(e) {
  const st = cropState;
  if (!st) return;
  st.pointers.delete(e.pointerId);
  if (st.pointers.size < 2) st.pinch = null;
  if (!st.pointers.size) cropStageEl().classList.remove('grabbing');
}

if ($('#crop-stage')) {
  const stage = cropStageEl();
  stage.addEventListener('pointerdown', cropPointerDown);
  stage.addEventListener('pointermove', cropPointerMove);
  stage.addEventListener('pointerup', cropPointerUp);
  stage.addEventListener('pointercancel', cropPointerUp);
  stage.addEventListener('lostpointercapture', cropPointerUp);
  stage.addEventListener('wheel', (e) => {
    const st = cropState;
    if (!st || !st.view || st.saving) return;
    e.preventDefault();
    const box = stage.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    cropApply(cropViewZoomAt(st.view, st.view.scale * factor, e.clientX - box.left, e.clientY - box.top));
  }, { passive: false });
  // A double-click (or double-tap) resets the framing: the cheap way back from
  // an accidental zoom without hunting for the slider.
  stage.addEventListener('dblclick', () => { if (cropState && cropState.view) cropApply(cropViewInit(cropState.natW, cropState.natH, cropState.winW, cropState.winH)); });
  $('#crop-zoom').addEventListener('input', () => {
    const st = cropState;
    if (!st || !st.view) return;
    const k = Number($('#crop-zoom').value) || 1;
    cropApply(cropViewZoomAt(st.view, st.view.min * k, st.winW / 2, st.winH / 2));
  });
  $('#crop-save').onclick = () => cropSave();
  $('#crop-cancel').onclick = () => closeCropStage();
  $('#crop-x').onclick = () => closeCropStage();
  $('#crop-backdrop').addEventListener('click', (e) => { if (e.target.id === 'crop-backdrop') closeCropStage(); });
  // A rotation or a window resize re-measures the window; the view is re-fitted
  // to it (cropSizeStage), so the rectangle always describes what is on screen.
  window.addEventListener('resize', () => {
    if (!cropState || !cropState.natW || !$('#crop-backdrop') || $('#crop-backdrop').classList.contains('hidden')) return;
    cropSizeStage();
    cropPaint();
  });
}
