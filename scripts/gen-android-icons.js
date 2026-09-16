// Regenerates the Android APK launcher icons — zero dependencies.
//
// Adapted icon (the one modern launchers draw): a transparent foreground layer
// holding the BARE mark, on the theme background color. The launcher masks the
// 108dp layer to whatever shape the device uses, so the foreground has to keep
// the artwork inside the 72dp safe circle — `npx tauri icon` derives it from
// the full-bleed badge instead, which the mask then clips.
//
// Legacy + round icons are the badge itself (public/icons/campfire-badge.png:
// the mark already on the theme-colored circle), so an old launcher and a
// Pixel's themed icon agree.
//
// Re-run after every `npx tauri icon ...` (see app/README.md "Icons").
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG, resample } = require('./png-util');
const { compositeSquare } = require('./mark-render');

const root = path.join(__dirname, '..');
const markFile = path.join(root, 'public', 'icons', 'campfire-logo.png');
const badgeFile = path.join(root, 'public', 'icons', 'campfire-badge.png');
const { w: lw, h: lh, px: mark } = decodePNG(markFile);
const { w: bw, h: bh, px: badge } = decodePNG(badgeFile);
if (lw !== lh) throw new Error(`campfire-logo.png must be square, got ${lw}x${lh}`);
if (bw !== bh) throw new Error(`campfire-badge.png must be square, got ${bw}x${bh}`);

const THEME = [0x1a, 0x1d, 0x29]; // --bg / ic_launcher_background
const res = path.join(root, 'app', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

// Center an RGBA layer over transparency.
function placeTransparent(layer, box, size) {
  const out = Buffer.alloc(size * size * 4); // all zeros = transparent
  const off = Math.round((size - box) / 2);
  for (let y = 0; y < box; y++) {
    for (let x = 0; x < box; x++) {
      const s = (y * box + x) * 4;
      if (layer[s + 3] === 0) continue;
      const o = ((y + off) * size + (x + off)) * 4;
      out[o] = layer[s]; out[o + 1] = layer[s + 1]; out[o + 2] = layer[s + 2];
      out[o + 3] = layer[s + 3];
    }
  }
  return out;
}

const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

for (const [dpi, size] of Object.entries(FOREGROUND)) {
  // 58% of the 108dp layer ≈ a 63dp mark inside the 72dp safe circle.
  const box = Math.round(size * 0.58);
  const layer = resample(mark, lw, lh, box, box);
  fs.writeFileSync(
    path.join(res, `mipmap-${dpi}`, 'ic_launcher_foreground.png'),
    encodePNG(size, size, placeTransparent(layer, box, size))
  );
  console.log('foreground', dpi, `${box}/${size}`);
}
for (const [dpi, size] of Object.entries(LEGACY)) {
  // The badge at full size. The plain legacy icon is the badge flattened onto
  // the theme color (older launchers show the square as-is), the round one
  // keeps the badge's transparent corners for launchers that mask it.
  const layer = resample(badge, bw, bh, size, size);
  fs.writeFileSync(
    path.join(res, `mipmap-${dpi}`, 'ic_launcher.png'),
    encodePNG(size, size, compositeSquare(THEME, layer, size, size, size))
  );
  fs.writeFileSync(path.join(res, `mipmap-${dpi}`, 'ic_launcher_round.png'), encodePNG(size, size, layer));
  console.log('legacy', dpi, `${size}/${size} round ${size}/${size}`);
}
console.log('android launcher icons regenerated ->', res);
