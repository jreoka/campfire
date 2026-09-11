'use strict';
/* ============ story overlays: text, emoji stickers, freehand markup ========
   One model, three surfaces. The composer renders the overlay list live over
   the frozen shot while you drag/pinch/rotate it, the story viewer renders the
   same list over the photo or video, and the view-once player renders it for a
   story that was sent to an individual friend.

   Nothing is baked into the bytes: the list rides with the post
   (stories.overlays, and dm_messages.viewonce_overlays for the private copy),
   so text stays crisp at any size and a video keeps its markup for its whole
   play, scrubbed or paused.

   Coordinates are normalised to the MEDIA's content box — the rectangle the
   picture actually paints inside, after object-fit — never to the screen. The
   same numbers therefore land in the same place whether the shot is a 2 MP
   phone capture shown full-bleed or a letterboxed preview on a desktop.

   Item shapes:
     { t:'text',  x, y, r, s, text, color, bg }   x/y centre, r degrees, s scale
     { t:'emoji', x, y, r, s, e }                 e is a char or a :custom: name
     { t:'draw',  color, w, p:[[x,y], ...] }      w is a fraction of media width
*/
const OV_MAX = 60;             // items per story (server enforces the same cap)
const OV_TEXT_MAX = 200;
const OV_POINTS_MAX = 300;     // points per stroke
const OV_POINTS_TOTAL = 2400;  // points across every stroke on one story
// The markup travels in the post's JSON body, so it has a hard size budget:
// drawing is the cheap-to-lose part and the first thing trimmed (see
// ovTrimToBudget), because text and stickers are what people notice.
const OV_JSON_MAX = 24000;
const OV_TEXT_BASE = 0.085;    // s = 1 → 8.5% of the media height
const OV_EMOJI_BASE = 0.17;
// Swatches. User content, so real colours are fine — nothing here is chrome.
const OV_COLORS = ['#ffffff', '#0b0d12', '#ff4d6d', '#ff9f1c', '#ffe066', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6'];
const OV_STICKERS = [
  '😂', '😍', '😎', '🤔', '😭', '😡', '🥳', '🤯', '😴', '🤮', '🫠', '🤪',
  '❤️', '💔', '🔥', '✨', '💯', '🎉', '⭐', '🌈', '💀', '👀', '👻', '🤖',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '🫶', '✌️',
  '🍕', '🍔', '🍩', '☕', '🍺', '🎂', '🍿', '🥑',
  '🐱', '🐶', '🦄', '🐸', '🦋', '🌸', '🌊', '🏔️',
  '⚽', '🎮', '🎧', '🎸', '📸', '🚀', '💸', '🏆',
  '🌈', '☀️', '🌙', '⚡', '❄️', '🎈', '🎁', '🕶️',
  '✅', '❌', '❗', '❓', '💤', '🆗', '🔞', '⚠️',
];

function ovNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function ovColor(v, dflt = '#ffffff') {
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?$/i.test(String(v || '')) ? String(v) : dflt;
}
// Trim + validate an overlay list. Runs on the way out of the composer (so we
// never send junk) and again on the server (which trusts nothing).
function ovSanitize(list) {
  const out = [];
  const src = Array.isArray(list) ? list : [];
  let points = 0;
  for (const o of src) {
    if (out.length >= OV_MAX) break;
    if (!o || typeof o !== 'object') continue;
    const x = ovNum(o.x, -0.5, 1.5, 0.5);
    const y = ovNum(o.y, -0.5, 1.5, 0.5);
    const r = ovNum(o.r, -360, 360, 0);
    const s = ovNum(o.s, 0.05, 12, 1);
    if (o.t === 'text') {
      const text = String(o.text == null ? '' : o.text).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, OV_TEXT_MAX);
      if (!text.trim()) continue;
      out.push({ t: 'text', x, y, r, s, text, color: ovColor(o.color), bg: o.bg === 'pill' ? 'pill' : 'none' });
    } else if (o.t === 'emoji') {
      const e = String(o.e == null ? '' : o.e).slice(0, 32);
      if (!e.trim()) continue;
      out.push({ t: 'emoji', x, y, r, s, e });
    } else if (o.t === 'draw') {
      const room = OV_POINTS_TOTAL - points;
      if (room < 2) continue;
      const p = [];
      for (const pt of (Array.isArray(o.p) ? o.p : [])) {
        if (p.length >= Math.min(OV_POINTS_MAX, room)) break;
        if (!Array.isArray(pt) || pt.length < 2) continue;
        p.push([+ovNum(pt[0], -1, 2, 0).toFixed(4), +ovNum(pt[1], -1, 2, 0).toFixed(4)]);
      }
      if (!p.length) continue;
      points += p.length;
      out.push({ t: 'draw', color: ovColor(o.color), w: ovNum(o.w, 0.0008, 0.2, 0.007), p });
    }
  }
  return ovTrimToBudget(out);
}
// A stroke is a lot of bytes for the least information: when the list is over
// budget, strokes go before text and stickers do.
function ovTrimToBudget(list, max = OV_JSON_MAX) {
  const size = (a) => {
    try { return JSON.stringify(a).length; } catch { return 0; }
  };
  if (size(list) <= max) return list;
  let out = list.slice();
  for (let i = 0; i < out.length; i++) {
    if (size(out) <= max) break;
    if (out[i] && out[i].t === 'draw') out[i] = null;
  }
  out = out.filter(Boolean);
  while (out.length > 1 && size(out) > max) out.pop();
  return out;
}
// Anything the client is handed back (a story row, a WS push, a view-once
// open) may be a JSON string, a live array, or garbage from an old build.
function ovParse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return ovSanitize(raw);
  if (typeof raw === 'string') {
    try { return ovSanitize(JSON.parse(raw)); } catch { return []; }
  }
  return [];
}
function ovSerialize(list) {
  const clean = ovSanitize(list);
  return clean.length ? JSON.stringify(clean) : '';
}
function ovIsEmpty(list) {
  return !ovSanitize(list).length;
}

/* ---------- geometry: where the picture actually paints ---------- */
// The content box of an <img>/<video> that is object-fit:contain inside its own
// element box. The composer's shot fills the stage (box = stage, picture
// letterboxed inside it), while the viewer's media is clamped by max-width /
// max-height (box ≈ picture). Both give the rectangle the pixels really cover,
// which is the one the overlay coordinates are normalised to.
function ovContentRect(el) {
  const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  if (!r) return null;
  const nw = Number(el.naturalWidth || el.videoWidth || 0);
  const nh = Number(el.naturalHeight || el.videoHeight || 0);
  if (!nw || !nh || !r.width || !r.height) return { left: r.left, top: r.top, width: r.width, height: r.height };
  const k = Math.min(r.width / nw, r.height / nh);
  const w = nw * k, h = nh * k;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}
// Lay `layer` exactly over the media's content box inside `stage`, and hand it
// the pixel size as CSS vars so items can size themselves in em/percent.
function ovFitLayer(layer, stage, mediaEl) {
  if (!layer || !stage) return null;
  const sr = stage.getBoundingClientRect();
  const cr = ovContentRect(mediaEl);
  if (!cr || !cr.width || !cr.height) { layer.classList.add('hidden'); return null; }
  const x = cr.left - sr.left, y = cr.top - sr.top;
  layer.style.left = x + 'px';
  layer.style.top = y + 'px';
  layer.style.width = cr.width + 'px';
  layer.style.height = cr.height + 'px';
  layer.style.setProperty('--ov-w', cr.width + 'px');
  layer.style.setProperty('--ov-h', cr.height + 'px');
  layer.classList.remove('hidden');
  return { x, y, w: cr.width, h: cr.height };
}

/* ---------- rendering ---------- */
function ovEmojiHTML(e) {
  const s = String(e == null ? '' : e);
  const m = /^:([a-z0-9_+-]{1,32}):$/i.exec(s);
  if (m && typeof S !== 'undefined' && S && S.emojiAll) {
    const em = S.emojiAll[m[1]];
    if (em && em.url) return '<img class="ov-em" src="' + esc(em.url) + '" alt="' + esc(s) + '" draggable="false" />';
  }
  return '<span class="ov-emchar">' + esc(s) + '</span>';
}
// One stroke → a scaled canvas path. Strokes carry normalised points and a
// width that is a fraction of the media WIDTH (so a line keeps its weight
// relative to the picture rather than to the letterbox).
function ovPaintDraw(canvas, strokes, w, h) {
  if (!canvas) return;
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (!s || !Array.isArray(s.p) || !s.p.length) continue;
    ctx.strokeStyle = s.color || '#ffffff';
    ctx.fillStyle = s.color || '#ffffff';
    ctx.lineWidth = Math.max(1, (s.w || 0.007) * w);
    if (s.p.length === 1) {
      ctx.beginPath();
      ctx.arc(s.p[0][0] * w, s.p[0][1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s.p[0][0] * w, s.p[0][1] * h);
    for (let i = 1; i < s.p.length; i++) ctx.lineTo(s.p[i][0] * w, s.p[i][1] * h);
    ctx.stroke();
  }
}
// Paint a whole overlay list into `layer`. Draw strokes go on a canvas at the
// bottom (they are the markup under everything else, like a pen on the photo),
// text and emoji become absolutely positioned, transformed boxes above it.
// `list` must already be sanitized (ovParse/ovSanitize at the source): item
// order is the index the editor selects and re-orders by, so nothing here may
// silently drop an entry.
// opts: { editable, selected } — editable adds the hit-test/drag affordances.
function ovPaintLayer(layer, list, opts = {}) {
  if (!layer) return;
  const ovs = Array.isArray(list) ? list : [];
  // The size has to be read AFTER the visibility classes land: a layer that
  // was display:none a moment ago still measures 0, and a 0x0 pen canvas is
  // exactly why the first stroke on an empty shot painted nothing.
  layer.textContent = '';
  layer.classList.toggle('ov-editable', !!opts.editable);
  // An editable layer stays laid out even with nothing in it: the composer
  // draws straight onto it, and a tap on the picture has to land somewhere.
  layer.classList.toggle('ov-empty', !ovs.length && !opts.editable);
  const w = layer.clientWidth || 0, h = layer.clientHeight || 0;
  const draw = document.createElement('canvas');
  draw.className = 'ov-draw';
  layer.appendChild(draw);
  ovPaintDraw(draw, ovs.filter((o) => o && o.t === 'draw'), w, h);
  ovs.forEach((o, i) => {
    if (!o || o.t === 'draw') return;
    const el = document.createElement('div');
    el.className = 'ov-item ov-' + o.t + (opts.selected === i ? ' ov-sel' : '');
    el.dataset.i = String(i);
    el.style.left = (ovNum(o.x, -1, 2, 0.5) * 100).toFixed(3) + '%';
    el.style.top = (ovNum(o.y, -1, 2, 0.5) * 100).toFixed(3) + '%';
    el.style.transform = 'translate(-50%,-50%) rotate(' + ovNum(o.r, -360, 360, 0).toFixed(2)
      + 'deg) scale(' + ovNum(o.s, 0.05, 12, 1).toFixed(4) + ')';
    if (o.t === 'text') {
      el.style.color = ovColor(o.color);
      el.style.fontSize = 'calc(' + OV_TEXT_BASE + ' * var(--ov-h))';
      el.classList.toggle('ov-pill', o.bg === 'pill');
      el.textContent = String(o.text == null ? '' : o.text);
    } else {
      el.style.fontSize = 'calc(' + OV_EMOJI_BASE + ' * var(--ov-h))';
      el.innerHTML = ovEmojiHTML(o.e);
    }
    layer.appendChild(el);
  });
}

/* ---------- what is under the finger ---------- */
// Index of the overlay item under a point given in CLIENT coordinates (what a
// pointer event hands you). The browser already knows the transformed geometry
// of a rotated/scaled box, so its own rects are the hit test.
function ovHit(layer, clientX, clientY) {
  if (!layer) return -1;
  const items = layer.querySelectorAll('.ov-item');
  for (let i = items.length - 1; i >= 0; i--) {
    const el = items[i];
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return Number(el.dataset.i);
  }
  return -1;
}
