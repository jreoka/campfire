// Derives all PWA/app icons from public/icons/campfire-badge.png (the mark on
// the round theme-colored badge — the single source of truth for ICONS; the
// transparent mark lives beside it as campfire-logo.png for in-app art) —
// zero dependencies.
//
// The badge already IS the icon: a circle on the app's own background with the
// mark inside its safe area, so every size here is the same artwork resampled
// and nothing needs a background glued on at this stage. That is the point of
// rendering it once in scripts/render-logo.js: a browser tab, a taskbar button
// and a launcher all get the identical mark-in-a-circle.
//
//   icon-192.png            the badge at 192   (manifest "any")
//   icon-512.png            the badge at 512   (manifest "any")
//   icon-maskable-512.png   the badge at 512   (manifest "maskable" — the
//                           mark sits well inside Android's 80% safe circle)
//   apple-touch-icon.png    the badge at 180   (iOS)
//
// Keeping the Dockerfile's `RUN node scripts/gen-icons.js` step is safe: it
// reproduces the committed icons instead of clobbering them with stale
// procedurally-drawn art.
const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG, resample } = require('./png-util');

const dir = path.join(__dirname, '..', 'public', 'icons');
const badgeFile = path.join(dir, 'campfire-badge.png');
const { w: bw, h: bh, px: badge } = decodePNG(badgeFile);
if (bw !== bh) throw new Error(`campfire-badge.png must be square, got ${bw}x${bh}`);

const at = (size) => encodePNG(size, size, resample(badge, bw, bh, size, size));

fs.writeFileSync(path.join(dir, 'icon-512.png'), at(512));
fs.writeFileSync(path.join(dir, 'icon-192.png'), at(192));
// Maskable: same artwork — the badge's own margin is the adaptive-icon safe
// zone, so the launcher's circle mask never clips the mark.
fs.writeFileSync(path.join(dir, 'icon-maskable-512.png'), at(512));
// Apple touch: iOS applies its own rounded-rect mask and wants no transparency,
// which the badge already satisfies.
fs.writeFileSync(path.join(dir, 'apple-touch-icon.png'), at(180));

console.log('icons derived from campfire-badge.png ->', dir);
