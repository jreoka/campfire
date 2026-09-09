// Derives all PWA/app icons from public/icons/campfire-logo.png (the single
// source of truth for the campfire mark) — zero dependencies.
//
// campfire-logo.png is the canonical artwork (transparent background). This
// script regenerates:
//   icon-192.png        transparent, area-resampled to 192x192  (manifest "any")
//   icon-512.png        transparent, 512x512                    (manifest "any")
//   icon-maskable-512.png  campfire mark centered at ~72% on the #1a1d29
//                       theme background (Android adaptive-icon safe zone)
//   apple-touch-icon.png   180x180 on the #1a1d29 theme background (iOS)
// Keeping the Dockerfile's `RUN node scripts/gen-icons.js` step is safe:
// it reproduces the committed icons instead of clobbering them with
// stale procedurally-drawn art.
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG, resample, compositeOver } = require('./png-util');

const dir = path.join(__dirname, '..', 'public', 'icons');
const logoFile = path.join(dir, 'campfire-logo.png');
const { w: lw, h: lh, px: logo } = decodePNG(logoFile);
if (lw !== lh) throw new Error(`campfire-logo.png must be square, got ${lw}x${lh}`);

const THEME = [0x1a, 0x1d, 0x29]; // --bg / manifest theme_color

// Transparent "any" icons — the raw mark, matching favicon/home art.
fs.writeFileSync(path.join(dir, 'icon-512.png'), encodePNG(lw, lh, logo));
fs.writeFileSync(path.join(dir, 'icon-192.png'), encodePNG(192, 192, resample(logo, lw, lh, 192, 192)));

// Maskable: mark at 72% on the theme background (adaptive-icon safe zone).
const maskBox = Math.round(512 * 0.72);
const maskLayer = resample(logo, lw, lh, maskBox, maskBox);
fs.writeFileSync(
  path.join(dir, 'icon-maskable-512.png'),
  encodePNG(512, 512, compositeOver(THEME, maskLayer, maskBox, maskBox, 512, maskBox))
);

// Apple touch icon: 180x180 on the theme background.
const appleBox = Math.round(180 * 0.8);
const appleLayer = resample(logo, lw, lh, appleBox, appleBox);
fs.writeFileSync(
  path.join(dir, 'apple-touch-icon.png'),
  encodePNG(180, 180, compositeOver(THEME, appleLayer, appleBox, appleBox, 180, appleBox))
);

console.log('icons derived from campfire-logo.png ->', dir);
