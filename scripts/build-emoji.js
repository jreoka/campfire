// Builds public/emoji.json — a compact, searchable emoji dataset for the picker.
// Source: emojibase-data (devDependency, MIT). Run: npm run build:emoji
// Output shape: { groups: [ { name, items: [[char, searchText], ...] } ], shortcodes: { name: char } }
// shortcodes come from the CLDR annotation set, joined on hexcode.
// Commit the output so production Docker builds don't need the dataset.
const fs = require('fs');
const path = require('path');

const GROUP_NAMES = {
  0: 'Smileys',
  1: 'People',
  3: 'Nature',
  4: 'Food & Drink',
  5: 'Travel',
  6: 'Activities',
  7: 'Objects',
  8: 'Symbols',
  9: 'Flags',
};

const src = require('emojibase-data/en/compact.json');
const cldr = require('emojibase-data/en/shortcodes/cldr.json');
const groups = [];
for (const [gid, name] of Object.entries(GROUP_NAMES)) {
  const items = src
    .filter((e) => e.group === Number(gid) && e.unicode)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((e) => [e.unicode, [e.label, ...((e.tags || [])), e.emoticon || ''].join(' ').toLowerCase()]);
  if (items.length) groups.push({ name, items });
}

const out = path.join(__dirname, '..', 'public', 'emoji.json');
const byHex = new Map(src.map((e) => [e.hexcode, e.unicode]));
const shortcodes = {};
for (const [hex, name] of Object.entries(cldr)) {
  if (typeof name !== 'string' || !/^[a-z0-9_+-]{2,32}$/.test(name)) continue;
  if (shortcodes[name] || !byHex.get(hex)) continue;
  shortcodes[name] = byHex.get(hex);
}
fs.writeFileSync(out, JSON.stringify({ groups, shortcodes }));
const total = groups.reduce((n, g) => n + g.items.length, 0);
console.log(`emoji.json: ${total} emoji in ${groups.length} groups, ${Object.keys(shortcodes).length} shortcodes, ${(fs.statSync(out).size / 1024).toFixed(0)}KB -> ${out}`);
