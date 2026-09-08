// Syncs app/src-tauri/icons/icon.ico with the web favicon (public/favicon.ico).
// The Windows app icon is intentionally the same campfire mark as the site
// favicon — one source of truth, no fill heuristics.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'public', 'favicon.ico');
const out = path.join(__dirname, '..', 'app', 'src-tauri', 'icons', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(src, out);
console.log(`icon.ico synced from ${path.basename(src)} (${fs.statSync(out).size} bytes)`);
