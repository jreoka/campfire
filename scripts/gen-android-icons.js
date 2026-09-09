// Regenerates the Android APK launcher icons from public/icons/campfire-logo.png
// (the single source of truth) — zero dependencies.
//
// Why this exists: `npx tauri icon <png>` derives the mipmap foregrounds from
// the full-bleed mark, so the adaptive-icon circle mask clips the logs/embers.
// This script re-derives them with the mark zoomed out to fit the safe zone:
//   ic_launcher_foreground.png  mark at 58% on transparency (108dp viewport,
//                               72dp safe-zone circle — full mark + margin)
//   ic_launcher.png             mark at 72% on the #1a1d29 theme background
//   ic_launcher_round.png       mark at 60% on a full-bleed theme circle
// Re-run after every `npx tauri icon ...` (see app/README.md "Icons").
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG, resample, compositeOver } = require('./png-util');

const root = path.join(__dirname, '..');
const logoFile = path.join(root, 'public', 'icons', 'campfire-logo.png');
const { w: lw, h: lh, px: logo } = decodePNG(logoFile);
if (lw !== lh) throw new Error(`campfire-logo.png must be square, got ${lw}x${lh}`);

const THEME = [0x1a, 0x1d, 0x29]; // --bg / ic_launcher_background
const res = path.join(root, 'app', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

// Center an RGBA layer over transparency.
function placeTransparent(layer, box, size) {
  const out = Buffer.alloc(size * size * 4); // all zeros = transparent
  const off = Math.round((size - box) / 2);
  for (let y = 0; y < box; y++) {
    for (let x = 0; x < box; x++) {
      const s = (y * box + x) * 4;
      const sa = layer[s + 3] / 255;
      if (sa <= 0) continue;
      const o = ((y + off) * size + (x + off)) * 4;
      out[o] = layer[s]; out[o + 1] = layer[s + 1]; out[o + 2] = layer[s + 2];
      out[o + 3] = layer[s + 3];
    }
  }
  return out;
}

// Theme circle on transparency, layer centered on top.
function placeOnCircle(layer, box, size) {
  const out = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const o = (y * size + x) * 4;
      if (dx * dx + dy * dy <= r * r) {
        out[o] = THEME[0]; out[o + 1] = THEME[1]; out[o + 2] = THEME[2]; out[o + 3] = 255;
      }
    }
  }
  const off = Math.round((size - box) / 2);
  for (let y = 0; y < box; y++) {
    for (let x = 0; x < box; x++) {
      const s = (y * box + x) * 4;
      const sa = layer[s + 3] / 255;
      if (sa <= 0) continue;
      const o = ((y + off) * size + (x + off)) * 4;
      out[o] = Math.round(layer[s] * sa + out[o] * (1 - sa));
      out[o + 1] = Math.round(layer[s + 1] * sa + out[o + 1] * (1 - sa));
      out[o + 2] = Math.round(layer[s + 2] * sa + out[o + 2] * (1 - sa));
      out[o + 3] = 255;
    }
  }
  return out;
}

const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

for (const [dpi, size] of Object.entries(FOREGROUND)) {
  const box = Math.round(size * 0.58);
  const layer = resample(logo, lw, lh, box, box);
  const file = path.join(res, `mipmap-${dpi}`, 'ic_launcher_foreground.png');
  fs.writeFileSync(file, encodePNG(size, size, placeTransparent(layer, box, size)));
  console.log('foreground', dpi, `${box}/${size}`);
}
for (const [dpi, size] of Object.entries(LEGACY)) {
  const box = Math.round(size * 0.72);
  const layer = resample(logo, lw, lh, box, box);
  fs.writeFileSync(
    path.join(res, `mipmap-${dpi}`, 'ic_launcher.png'),
    encodePNG(size, size, compositeOver(THEME, layer, box, box, size, box))
  );
  const rbox = Math.round(size * 0.6);
  const rlayer = resample(logo, lw, lh, rbox, rbox);
  fs.writeFileSync(
    path.join(res, `mipmap-${dpi}`, 'ic_launcher_round.png'),
    encodePNG(size, size, placeOnCircle(rlayer, rbox, size))
  );
  console.log('legacy', dpi, `${box}/${size} round ${rbox}/${size}`);
}
console.log('android launcher icons regenerated ->', res);
