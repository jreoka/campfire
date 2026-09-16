// Writes the canonical Campfire artwork, all from the same vector paths as the
// in-app animated fire (see scripts/mark-render.js for the renderer):
//
//   public/icons/campfire-logo.png   the bare mark, transparent (512)
//                                    — the in-app Home rail button's image,
//                                      and the source art for anything that
//                                      draws its own background
//   public/icons/campfire-badge.png  the mark on the round theme-colored badge
//                                    (512) — THE icon artwork: favicons, PWA
//                                      icons, the Windows tray/taskbar icon and
//                                      every launcher icon derive from it
//   public/favicon-32.png            the badge at 32
//   public/favicon.ico               the badge at 16/32/48
//
// Pipeline (single source of truth for the mark):
//   1. node scripts/render-logo.js        -> the two 512s + the favicons
//   2. node scripts/gen-icons.js          -> icon-192/512, maskable, apple-touch
//   3. npx tauri icon                     -> app/src-tauri/icons/* (desktop),
//      public/icons/campfire-badge.png      icns/ico/store logos included
//   4. node scripts/gen-ico.js            -> app icon.ico synced from favicon.ico
//   5. node scripts/gen-android-icons.js  -> APK launcher icons
//
// The renderer is deterministic (no randomness/clocks), so re-running it
// reproduces the committed files byte-for-byte on any platform.
'use strict';
const fs = require('fs');
const path = require('path');
const { renderMark, renderBadge, encodeICO, encodePNG, resample } = require('./mark-render');

const SIZE = 512;
const iconsDir = path.join(__dirname, '..', 'public', 'icons');
const pubDir = path.join(__dirname, '..', 'public');

// The mark itself, full-bleed on transparency — unchanged artwork (this
// reproduces the pre-badge campfire-logo.png byte for byte). The in-app Home
// rail button renders it next to its animated SVG twin, so it stays
// background-free.
const logo = renderMark(SIZE);
fs.writeFileSync(path.join(iconsDir, 'campfire-logo.png'), encodePNG(SIZE, SIZE, logo));

// The badge: that same mark, at that same size, with a theme-colored circle
// added BEHIND it. Everything the OS cuts to a circle — the browser tab, the
// taskbar button, the tray icon, a launcher — uses this, and the mark inside
// is pixel-identical to the line above.
const badge = renderBadge(SIZE);
fs.writeFileSync(path.join(iconsDir, 'campfire-badge.png'), encodePNG(SIZE, SIZE, badge));

// Favicons from the badge.
fs.writeFileSync(path.join(pubDir, 'favicon-32.png'), encodePNG(32, 32, resample(badge, SIZE, SIZE, 32, 32)));
const ico = [];
for (const s of [16, 32, 48]) {
  ico.push({ size: s, png: encodePNG(s, s, resample(badge, SIZE, SIZE, s, s)) });
}
fs.writeFileSync(path.join(pubDir, 'favicon.ico'), encodeICO(ico));

console.log('campfire-logo.png + campfire-badge.png + favicons rendered');
