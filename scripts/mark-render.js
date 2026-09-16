// The canonical Campfire mark, rasterized from the same vector paths as the
// in-app animated fire (auth card / boot splash / offline overlay / home
// button) — zero dependencies.
//
// Single source of truth for the artwork, consumed by:
//   render-logo.js       -> campfire-logo.png (transparent mark)
//                           campfire-badge.png (mark on the round badge)
//                           favicon-32.png + favicon.ico (from the badge)
//   gen-icons.js         -> PWA "any" / maskable / apple-touch icons
//   gen-android-icons.js -> APK launcher icons
//
// The mark is the static one: stones, crossed logs, both flames. (The floating
// embers only read well in motion, so the static mark leaves them out.) Paint
// order matches the SVG document order.
//
// Everything here is deterministic (no randomness, no clocks) and anti-aliased
// by supersampling, so re-running reproduces the committed files byte-for-byte
// on any platform. Keep it that way: a prettier edge is not worth a repo that
// renders differently on two machines.
'use strict';

const { encodePNG, resample } = require('./png-util');

// SVG viewBox window the mark lives in (with padding). Slightly
// bottom-weighted margins: the flame body is visually heavy low down, so
// optical centering wants a touch more air underneath the stones.
const VBX = -1.5, VBY = 0, VBS = 51;
// Center of that window in its own units — the point a square canvas puts at
// its center.
const VBCX = VBX + VBS / 2, VBCY = VBY + VBS / 2;

// The mark, in SVG document (paint) order. Flame paths are copied verbatim
// from the in-app animated fire so the static mark matches it exactly.
const SHAPES = [
  { t: 'e', cx: 10, cy: 38, rx: 5, ry: 4, c: [0x9a, 0xa0, 0xa6] },
  { t: 'e', cx: 20, cy: 41, rx: 5, ry: 4, c: [0x80, 0x86, 0x8b] },
  { t: 'e', cx: 30, cy: 41, rx: 5, ry: 4, c: [0x9a, 0xa0, 0xa6] },
  { t: 'e', cx: 39, cy: 38, rx: 5, ry: 4, c: [0x80, 0x86, 0x8b] },
  { t: 'r', x: 12, y: 32, w: 24, h: 6, r: 3, rot: 18, c: [0x6d, 0x4c, 0x41] },
  { t: 'p', d: 'M24 6c2 5 8 8 8 16a8 8 0 0 1-16 0c0-3.5 1.5-5.5 2.6-8 .5 1.5 1.6 1.5 1.7-.2.1-2.6.5-5.3 3.7-7.8z', c: [0xff, 0x70, 0x43] },
  { t: 'r', x: 12, y: 32, w: 24, h: 6, r: 3, rot: -18, c: [0x8d, 0x6e, 0x63] },
  { t: 'p', d: 'M24 17c1.2 2.8 4.6 4.4 4.6 8.6a4.6 4.6 0 0 1-9.2 0c0-2.3 1.1-3.5 1.8-5 .5 1.1 1.3 1.1 1.4-.2.1-1.4.4-2.4 1.4-3.4z', c: [0xff, 0xb3, 0x00] },
];

// The round badge every ICON carries behind the mark: --bg from the app's dark
// theme, so a browser tab, a taskbar or a launcher that cuts the icon to a
// circle still shows the mark on the app's own surface. The in-app mark itself
// (public/icons/campfire-logo.png, used by the Home rail button) stays
// transparent.
const THEME = [0x1a, 0x1d, 0x29];
// Just-lighter tonal edge — the "elevation is tonal steps" rule applied to a
// badge: a hairline ring so the circle reads as a deliberate mark rather than a
// dark blob on a dark taskbar. Purely a design choice; pass ring:null to drop.
const RING = [0x3a, 0x40, 0x58];

// ---------- path parsing (M/L/C/A/Z + implicit repetition) ----------
function tokenize(d) {
  const toks = d.match(/[MmLlCcAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!toks) throw new Error('empty path');
  return toks;
}
function parsePath(d) {
  // Returns command list; coordinates stay in SVG units.
  const toks = tokenize(d);
  let i = 0, cx = 0, cy = 0, cmd = null;
  const cmds = [];
  const num = () => {
    const v = parseFloat(toks[i++]);
    if (!Number.isFinite(v)) throw new Error('bad path number in: ' + d);
    return v;
  };
  while (i < toks.length) {
    if (/^[MmLlCcAaZz]$/.test(toks[i])) cmd = toks[i++];
    if (!cmd) throw new Error('bad path: ' + d);
    const c = cmd;
    if (c === 'M' || c === 'm') {
      let x = num(), y = num();
      if (c === 'm') { x += cx; y += cy; }
      cx = x; cy = y;
      cmds.push({ t: 'M', x, y });
      cmd = c === 'M' ? 'L' : 'l';
    } else if (c === 'L' || c === 'l') {
      let x = num(), y = num();
      if (c === 'l') { x += cx; y += cy; }
      cx = x; cy = y;
      cmds.push({ t: 'L', x, y });
    } else if (c === 'C' || c === 'c') {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      if (c === 'c') { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      cmds.push({ t: 'C', x1, y1, x2, y2, x, y });
      cx = x; cy = y;
    } else if (c === 'A' || c === 'a') {
      const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
      let x = num(), y = num();
      if (c === 'a') { x += cx; y += cy; }
      cmds.push({ t: 'A', rx, ry, rot, large, sweep, x, y, x0: cx, y0: cy });
      cx = x; cy = y;
    } else if (c === 'Z' || c === 'z') {
      cmds.push({ t: 'Z' });
      cmd = null;
    }
  }
  return cmds;
}

// ---------- flattening to device-space polygons ----------
// SVG arc endpoint -> center (spec F.6.5), y-down coordinates.
function arcCenter(x1, y1, rx, ry, phi, large, sweep, x2, y2) {
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let f = den === 0 ? 0 : (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / den;
  f = f <= 0 ? 0 : Math.sqrt(f) * (large === sweep ? -1 : 1);
  const cxp = (f * rx * y1p) / ry, cyp = (-f * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  return { cx, cy, rx, ry, rad, th1, dth };
}

// A render pass fixes the SVG-units -> canvas-pixels mapping once; every
// flattener closes over it. The mark's window (VBS units) is fitted to the
// canvas' short edge scaled by `base`, so base=1 keeps the historical
// full-bleed framing at any output size; `box` shifts which window is mapped
// (the historical logo is not exactly centered in the viewBox, and the in-app
// Home button renders the raw SVG next to that PNG, so it stays as it was).
function makeMarkMapper(W, base, box) {
  const b = box || { x: VBCX, y: VBCY, s: VBS };
  const K = (W * base) / b.s;
  const CX = W / 2, CY = W / 2;
  const X = (x) => CX + (x - b.x) * K;
  const Y = (y) => CY + (y - b.y) * K;

  // Sample an elliptical arc (SVG-unit center/radii) into device-space points.
  function sampleArc(poly, cx, cy, rx, ry, rad, th1, dth, stepPx) {
    const approx = Math.abs(dth) * Math.max(rx, ry) * K;
    const n = Math.max(4, Math.min(512, Math.ceil(approx / (stepPx || 1.2))));
    const cos = Math.cos(rad), sin = Math.sin(rad);
    for (let k = 1; k <= n; k++) {
      const th = th1 + (dth * k) / n, c = Math.cos(th), s = Math.sin(th);
      poly.push([X(cx + rx * cos * c - ry * sin * s), Y(cy + rx * sin * c + ry * cos * s)]);
    }
  }
  function flattenCubic(poly, x0, y0, x1, y1, x2, y2, x3, y3) {
    const approx =
      (Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)) * K;
    const n = Math.max(4, Math.min(256, Math.ceil(approx / 1.2)));
    for (let k = 1; k <= n; k++) {
      const t = k / n, mt = 1 - t;
      poly.push([
        X(mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3),
        Y(mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3),
      ]);
    }
  }
  function flattenPath(d) {
    const cmds = parsePath(d);
    const polys = [];
    let cur = null, sx = 0, sy = 0;
    for (const m of cmds) {
      if (m.t === 'M') { cur = []; polys.push(cur); cur.push([X(m.x), Y(m.y)]); sx = m.x; sy = m.y; }
      else if (!cur) throw new Error('path command before moveto');
      else if (m.t === 'L') cur.push([X(m.x), Y(m.y)]);
      else if (m.t === 'C') {
        const last = cur[cur.length - 1];
        // unmap the last device point back to SVG units for the cubic math
        const x0 = (last[0] - CX) / K + VBCX, y0 = (last[1] - CY) / K + VBCY;
        flattenCubic(cur, x0, y0, m.x1, m.y1, m.x2, m.y2, m.x, m.y);
      } else if (m.t === 'A') {
        const a = arcCenter(m.x0, m.y0, m.rx, m.ry, m.rot, m.large, m.sweep, m.x, m.y);
        sampleArc(cur, a.cx, a.cy, a.rx, a.ry, a.rad, a.th1, a.dth);
      } else if (m.t === 'Z') cur.push([X(sx), Y(sy)]);
    }
    return polys;
  }
  function ellipsePoly(cx, cy, rx, ry, steps) {
    const n = steps || 160;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      pts.push([X(cx + rx * Math.cos(a)), Y(cy + ry * Math.sin(a))]);
    }
    return pts;
  }
  // A rounded rectangle, then ONE rotation about (rcx, rcy) — both in SVG
  // units, mapped to device space at the end. (The corner arcs are built in
  // unrotated SVG space on purpose: building them already rotated and then
  // rotating the whole outline again double-rotates the corners, which is what
  // pushed the crossed logs out to 1.5x their half-diagonal and buried the
  // fire under them.)
  function roundedRectPoly(x, y, w, h, r, rotDeg, rcx, rcy) {
    const pts = [];
    const corner = (ccx, ccy, a0, a1) => {
      const n = 24;
      for (let k = 0; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n;
        pts.push([ccx + r * Math.cos(a), ccy + r * Math.sin(a)]);
      }
    };
    pts.push([x + r, y]);
    pts.push([x + w - r, y]);
    corner(x + w - r, y + r, -Math.PI / 2, 0);
    pts.push([x + w, y + h - r]);
    corner(x + w - r, y + h - r, 0, Math.PI / 2);
    pts.push([x + r, y + h]);
    corner(x + r, y + h - r, Math.PI / 2, Math.PI);
    pts.push([x, y + r]);
    corner(x + r, y + r, Math.PI, Math.PI * 1.5);
    if (rotDeg) {
      // SVG rotate() in y-down space == the same matrix in device space.
      const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      for (const p of pts) {
        const dx = p[0] - rcx, dy = p[1] - rcy;
        p[0] = rcx + dx * c - dy * s;
        p[1] = rcy + dx * s + dy * c;
      }
    }
    return pts.map(([px, py]) => [X(px), Y(py)]);
  }
  return { K, CX, CY, X, Y, ellipsePoly, roundedRectPoly, flattenPath };
}

// A circle in raw device pixels — the badge's own geometry, which has nothing
// to do with the mark's SVG window. Plain center-inside test: the 4x
// supersample pass is what makes the edge smooth.
function fillCircle(px, W, cx, cy, r, rgb) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(W - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy > r2) continue;
      const o = (y * W + x) * 4;
      px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
    }
  }
}

// ---------- even-odd scanline fill (opaque shapes, document order) ----------
function fillPoly(px, W, pts, rgb) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(W - 1, Math.ceil(maxY));
  const n = pts.length;
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5, xs = [];
    for (let k = 0; k < n; k++) {
      const x0 = pts[k][0], y0 = pts[k][1], x1 = pts[(k + 1) % n][0], y1 = pts[(k + 1) % n][1];
      if ((y0 < yc && y1 >= yc) || (y1 < yc && y0 >= yc)) xs.push(x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) {
        const o = (y * W + x) * 4;
        px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
      }
    }
  }
}

// ---------- downsample (premultiplied, so edges stay clean) ----------
function downsample(src, SIZE, SS) {
  const W = SIZE * SS;
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const o = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          const sa = src[o + 3] / 255;
          r += src[o] * sa; g += src[o + 1] * sa; b += src[o + 2] * sa; a += sa;
        }
      }
      const n = SS * SS, o = (y * SIZE + x) * 4;
      if (a > 1e-6) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a); out[o + 3] = Math.round((a / n) * 255);
      } else { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
    }
  }
  return out;
}

// ---------- ICO (PNG-compressed entries; fine for browsers + Windows) ----------
function encodeICO(entries) {
  const n = entries.length;
  const header = Buffer.alloc(6 + 16 * n);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  let off = 6 + 16 * n;
  entries.forEach((e, k) => {
    const o = 6 + 16 * k;
    header[o] = e.size >= 256 ? 0 : e.size; header[o + 1] = e.size >= 256 ? 0 : e.size;
    header[o + 2] = 0; header[o + 3] = 0;
    header.writeUInt16LE(1, o + 4); header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(e.png.length, o + 8); header.writeUInt32LE(off, o + 12);
    off += e.png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

// Render the bare mark on transparency. `base` is the mark's size as a
// fraction of the canvas' short edge (1 = the historical full-bleed logo).
// `box` overrides which SVG window is mapped onto the canvas (defaults to the
// viewBox center; the historical logo keeps the renderer's own framing).
function renderMark(size, opts) {
  const o = opts || {};
  const SS = o.ss || 4;
  const base = o.base == null ? 1 : o.base;
  const W = size * SS;
  const buf = Buffer.alloc(W * W * 4); // transparent
  const m = makeMarkMapper(W, base, o.box);
  for (const s of SHAPES) {
    if (s.t === 'e') fillPoly(buf, W, m.ellipsePoly(s.cx, s.cy, s.rx, s.ry), s.c);
    else if (s.t === 'r') fillPoly(buf, W, m.roundedRectPoly(s.x, s.y, s.w, s.h, s.r, s.rot, 24, 35), s.c);
    else if (s.t === 'p') for (const poly of m.flattenPath(s.d)) fillPoly(buf, W, poly, s.c);
  }
  return downsample(buf, size, SS);
}

// The badge: the campfire mark with a theme-colored circle added behind it, the
// circle sized to ENCOMPASS the whole mark — stones, logs, flames and all —
// with an even margin, so the badge reads as one complete campfire on a round
// backdrop.
//
// The mark cannot stay at its full-bleed 512 size for that: it fills 392x390px
// of the canvas, so its corners sit 0.4745 of the canvas from the centre and
// even a circle at 0.49 would shave the outer stones (a circle can't hold a
// square). So the mark is scaled to BADGE_MARK (still the same artwork, same
// proportions, same centre) and the circle is sized from that: reach x BADGE_MARK
// = 0.4745 x 0.85 = 0.4034, leaving a 5.7% margin at the cardinals and the
// bbox corners exactly on the circle's inner edge.
//
// campfire-logo.png stays at 1.0 — it is the in-app Home art and must keep
// matching its animated SVG twin.
const BADGE_MARK = 0.85;
const BADGE_RADIUS = 0.46;

function renderBadge(size, opts) {
  const o = opts || {};
  const ss = o.ss || 4;
  const radius = o.radius == null ? BADGE_RADIUS : o.radius;
  const ring = o.ring === undefined ? RING : o.ring;
  const base = o.markFrac == null ? BADGE_MARK : o.markFrac;
  const W = size * ss;
  const buf = Buffer.alloc(W * W * 4); // transparent
  const c = W / 2;
  const r = radius * W;
  fillCircle(buf, W, c, c, r, THEME);
  if (ring) fillCircle(buf, W, c, c, r - 0.011 * W, ring);
  compositeOverLayer(buf, renderMark(W, { ss: 1, base }), W, W);
  return downsample(buf, size, ss);
}

// Composite an RGBA layer (same device size) over `dst`.
function compositeOverLayer(dst, layer, w, h) {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const sa = layer[o + 3] / 255;
    if (sa <= 0) continue;
    dst[o] = Math.round(layer[o] * sa + dst[o] * (1 - sa));
    dst[o + 1] = Math.round(layer[o + 1] * sa + dst[o + 1] * (1 - sa));
    dst[o + 2] = Math.round(layer[o + 2] * sa + dst[o + 2] * (1 - sa));
    dst[o + 3] = 255;
  }
}

// Composite an RGBA layer (source x source) into a `size` canvas over a solid
// background, centered in a `box`-wide slot. Source pixels are point-sampled,
// so pass a layer already resampled to `box`.
function compositeSquare(bg, layer, source, box, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255;
  }
  const off = Math.round((size - box) / 2);
  for (let y = 0; y < box; y++) {
    const sy = Math.min(source - 1, Math.floor((y / box) * source));
    for (let x = 0; x < box; x++) {
      const sx = Math.min(source - 1, Math.floor((x / box) * source));
      const s = (sy * source + sx) * 4;
      const sa = layer[s + 3] / 255;
      if (sa <= 0) continue;
      const di = ((y + off) * size + (x + off)) * 4;
      out[di] = Math.round(layer[s] * sa + out[di] * (1 - sa));
      out[di + 1] = Math.round(layer[s + 1] * sa + out[di + 1] * (1 - sa));
      out[di + 2] = Math.round(layer[s + 2] * sa + out[di + 2] * (1 - sa));
      out[di + 3] = 255;
    }
  }
  return out;
}

module.exports = {
  SHAPES,
  THEME,
  RING,
  renderMark,
  renderBadge,
  compositeSquare,
  encodeICO,
  encodePNG,
  resample,
};
