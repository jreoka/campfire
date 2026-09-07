// Builds public/emoji.json — a compact, searchable emoji dataset for the picker.
// Source: emojibase-data (devDependency, MIT). Run: npm run build:emoji
// Output shape: { groups: [ { name, items: [[char, searchText], ...] } ] }
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
const groups = [];
for (const [gid, name] of Object.entries(GROUP_NAMES)) {
  const items = src
    .filter((e) => e.group === Number(gid) && e.unicode)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((e) => [e.unicode, [e.label, ...((e.tags || [])), e.emoticon || ''].join(' ').toLowerCase()]);
  if (items.length) groups.push({ name, items });
}

const out = path.join(__dirname, '..', 'public', 'emoji.json');
fs.writeFileSync(out, JSON.stringify({ groups }));
const total = groups.reduce((n, g) => n + g.items.length, 0);
console.log(`emoji.json: ${total} emoji in ${groups.length} groups, ${(fs.statSync(out).size / 1024).toFixed(0)}KB -> ${out}`);
