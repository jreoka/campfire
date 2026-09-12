// Story quick reactions — the viewer rail, in headless Chrome (see AGENTS.md
// verification conventions).
//
// The API half (test-story-reactions.js) proves the server side. This half
// drives the REAL rail out of stories.js (svRenderReactions / svReact /
// svFloatEmoji / svStartReactionBurst, sliced since there is no bundler)
// against the real `#story-view` markup and the real stylesheet, and pins the
// behaviour the feature is about:
//   - someone else's story gets a row of quick-pick buttons, none lit until you
//     tap one; the badge on a lit button is how many copies you sent,
//   - each tap ticks (haptic 12) and a copy of the emoji floats up out of that
//     button — a real `.sv-float` running the real keyframes, anchored at the
//     button — while the tap at the cap (which clears the set) floats nothing,
//   - the float lane never eats a tap (pointer-events:none) or the rail under it
//     would be dead, and a float removes itself when its rise ends,
//   - opening a story with reactions replays them (a staggered burst), and your
//     own story never replays at you,
//   - your own story shows read-only count chips instead of buttons, and hides
//     the row when nobody reacted,
//   - the rail fits a phone and sits between the stage and the footer.
//
// Skips without Chrome/Edge. Usage: node scripts/test-story-reactions-browser.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const stories = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const viewerMarkup = index.slice(index.indexOf('<div id="story-view"'), index.indexOf('<!-- stories: composer'));

// Slice a top-level function by balancing its braces. The reaction functions
// only ever put balanced `${…}` inside template literals, so this is exact —
// but scanning must start at the BODY brace, not the first `{` in the file
// (a default parameter like `opts = {}` would close it after two characters).
function sliceFn(name) {
  let at = stories.indexOf('function ' + name + '(');
  if (at < 0) return '';
  // Keep the `async ` prefix, or the sliced body's `await` is a syntax error.
  if (stories.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
  let i = stories.indexOf('(', at);
  let paren = 0;
  for (; i < stories.length; i++) {
    if (stories[i] === '(') paren++;
    else if (stories[i] === ')') { paren--; if (!paren) { i++; break; } }
  }
  i = stories.indexOf('{', i);
  let depth = 0;
  for (; i < stories.length; i++) {
    if (stories[i] === '{') depth++;
    else if (stories[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return stories.slice(at, i);
}
const fnSrc = ['svMyCount', 'svRenderReactions', 'svReact', 'svFloatEmoji', 'svStartReactionBurst'].map(sliceFn).join('\n');
const emojiLine = (stories.match(/^const SV_REACTIONS = \[.*\];/m) || [''])[0];
const maxLine = (stories.match(/^const SV_REACTION_MAX = .*;/m) || [''])[0];

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${viewerMarkup}
<script>
window.$ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.esc = esc;
window.__haptics = [];
window.haptic = (p) => __haptics.push(p);
window.__apiCalls = [];
window.__srv = { counts: [], mine: {} };
// The server rule: +1 per tap up to 4, then a tap clears that emoji's copies.
window.__serverReact = (emoji) => {
  const have = __srv.mine[emoji] || 0;
  const clearing = have >= 4;
  const next = clearing ? 0 : have + 1;
  const counts = new Map(__srv.counts);
  counts.set(emoji, Math.max(0, (counts.get(emoji) || 0) + (next - have)));
  __srv.counts = [...counts.entries()].filter(([, n]) => n > 0);
  if (next) __srv.mine[emoji] = next; else delete __srv.mine[emoji];
  return {
    ok: true, emoji, count: next, cleared: clearing, views: 1,
    reactions: __srv.counts.map(([e, n]) => ({ emoji: e, count: n })),
    myReactions: Object.entries(__srv.mine).map(([e, n]) => ({ emoji: e, count: n })),
  };
};
window.api = (p, opts) => {
  const emoji = JSON.parse(opts.body).emoji;
  __apiCalls.push({ path: p, emoji });
  return Promise.resolve(window.__serverReact(emoji));
};
window.toast = () => {};
window.prettyError = (e) => String(e);
window.S = { me: { id: 'me' } };
window.sv = { trays: [{ kind: 'user', id: 'other', items: [] }], ti: 0, gen: 1, burstT: [] };
window.__item = { id: 's1', reactions: [], myReactions: [], views: 3 };
window.__mine = false;
window.svCurrentItem = () => window.__item;
window.svItemIsMine = () => window.__mine;
window.__setStory = (opts) => {
  window.__item = Object.assign({ id: 's1', reactions: [], myReactions: [], views: 3 }, opts);
  window.__mine = !!opts.mine;
  window.__srv = {
    counts: (opts.reactions || []).map((r) => [r.emoji, r.count]),
    mine: Object.fromEntries((opts.myReactions || []).map((r) => [r.emoji, r.count])),
  };
  document.getElementById('sv-floats').textContent = '';
  svRenderReactions();
};
${emojiLine}
${maxLine}
${fnSrc}
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rail = document.getElementById('sv-react');
const lane = document.getElementById('sv-floats');
const foot = document.querySelector('.sv-foot');
const stage = document.getElementById('sv-stage');
const btn = (e) => [...rail.querySelectorAll('.sv-re')].find((b) => ((b.querySelector('.sv-re-e') || {}).textContent) === e);
const floats = () => [...lane.querySelectorAll('.sv-float')];

(async () => {
  document.getElementById('story-view').classList.remove('hidden');
  // --- someone else's story, nobody reacted yet ---
  __setStory({ reactions: [], myReactions: [] });
  out.buttons = [...rail.querySelectorAll('.sv-re')].map((b) => b.querySelector('.sv-re-e').textContent);
  out.lit = rail.querySelectorAll('.sv-re.on').length;
  out.badges = rail.querySelectorAll('.sv-re-n').length;
  out.railVisible = !rail.classList.contains('hidden');
  out.lanePointer = getComputedStyle(lane).pointerEvents;
  // The rail must not be under the float lane's hit area: a tap at the heart
  // has to land on the button.
  const hb = btn('❤️').getBoundingClientRect();
  out.railHit = (document.elementFromPoint(hb.left + hb.width / 2, hb.top + hb.height / 2) || {}).textContent;
  // Layout: between the stage and the footer, inside the viewport.
  const rr = rail.getBoundingClientRect();
  out.railBetween = rr.top >= stage.getBoundingClientRect().bottom - 1 && rr.bottom <= foot.getBoundingClientRect().top + 1;
  out.railInside = rr.left >= -1 && rr.right <= innerWidth + 1 && rr.bottom <= innerHeight + 1;
  const last = btn('👏');
  out.lastInsideRail = last.getBoundingClientRect().right <= rr.right + 1;

  // --- tap the heart once: lit, badged 1, haptic, a copy floats out ---
  btn('❤️').click();
  out.litAfter = rail.querySelectorAll('.sv-re.on').length;
  out.litEmoji = (rail.querySelector('.sv-re.on .sv-re-e') || {}).textContent;
  out.badgeAfter = (rail.querySelector('.sv-re.on .sv-re-n') || {}).textContent;
  out.hapticsAfter = __haptics.slice();
  const fl = floats();
  out.floatCount = fl.length;
  if (fl[0]) {
    out.floatText = fl[0].textContent;
    out.floatAnim = getComputedStyle(fl[0]).animationName;
    const fr = fl[0].getBoundingClientRect();
    out.floatNearButton = Math.abs((fr.left + fr.width / 2) - (hb.left + hb.width / 2)) < hb.width;
    // It starts ON the button (the rise is the keyframes' job, and virtual time
    // does not run them).
    out.floatAtButton = Math.abs(parseFloat(fl[0].style.top) - (hb.top + hb.height / 2)) < 2;
  }
  await sleep(0); // let the POST resolve
  out.apiCalls = __apiCalls.slice();
  out.mineAfter = svMyCount(__item, '❤️');
  // Virtual time does not fire CSS animation events, so deliver one by hand:
  // the float has to clear itself when its rise ends.
  if (fl[0]) fl[0].dispatchEvent(new Event('animationend'));
  out.laneCleared = floats().length;

  // --- mashing it: the 4th tap floats and the badge tracks the count ---
  __setStory({ reactions: [{ emoji: '❤️', count: 3 }], myReactions: [{ emoji: '❤️', count: 3 }] });
  out.badge3 = (rail.querySelector('.sv-re.on .sv-re-n') || {}).textContent;
  btn('❤️').click();
  out.mashFloats = floats().length;
  out.badge4 = (rail.querySelector('.sv-re.on .sv-re-n') || {}).textContent;
  await sleep(0);
  out.mashAgg = JSON.stringify(__item.reactions);
  out.mashMine = JSON.stringify(__item.myReactions);
  lane.textContent = ''; // section [5] starts from a clean lane

  // --- the fifth tap clears the set (the only undo, at the cap) ---
  btn('❤️').click();
  out.clearFloats = floats().length;
  out.clearLit = rail.querySelectorAll('.sv-re.on').length;
  out.clearBadges = rail.querySelectorAll('.sv-re-n').length;
  await sleep(0);
  out.clearAgg = JSON.stringify(__item.reactions);
  out.clearMine = JSON.stringify(__item.myReactions);
  out.clearCalls = __apiCalls.slice(-1);

  // --- opening a story replays what people left ---
  __setStory({ reactions: [{ emoji: '❤️', count: 2 }, { emoji: '😂', count: 1 }] });
  svStartReactionBurst(window.__item);
  await sleep(900);
  out.burstFloats = floats().length;
  out.burstTexts = floats().map((f) => f.textContent).sort().join('');
  await sleep(2600);

  // --- but never on your own story ---
  __setStory({ mine: true, reactions: [{ emoji: '🔥', count: 3 }] });
  svStartReactionBurst(window.__item);
  await sleep(900);
  out.ownBurst = floats().length;
  out.ownButtons = rail.querySelectorAll('.sv-re').length;
  out.ownChips = [...rail.querySelectorAll('.sv-rx-chip')].map((c) => c.textContent.replace(/\\s+/g, '')).join('|');
  out.ownRailVisible = !rail.classList.contains('hidden');

  // --- your own story with nobody reacting: the row goes away entirely ---
  __setStory({ mine: true, reactions: [] });
  out.ownEmptyHidden = rail.classList.contains('hidden');
  out.ownEmptyChips = rail.querySelectorAll('.sv-rx-chip').length;

  // --- someone else's story shows the running total beside the rail ---
  __setStory({ reactions: [{ emoji: '❤️', count: 2 }, { emoji: '😂', count: 1 }] });
  out.totalChip = (rail.querySelector('.sv-rx-chip') || {}).textContent;
  out.buttonCount = rail.querySelectorAll('.sv-re').length;

  document.title = JSON.stringify(out);
})().catch((e) => { document.title = JSON.stringify({ error: String((e && e.stack) || e) }); });
</script></body></html>`;
}

function main() {
  console.log('\n[1] the wiring is there');
  check(fnSrc.includes('function svMyCount') && fnSrc.includes('function svRenderReactions') && fnSrc.includes('function svReact') && fnSrc.includes('function svFloatEmoji') && fnSrc.includes('function svStartReactionBurst'), 'all five reaction helpers slice cleanly');
  check(/^const SV_REACTIONS = \[.*\];$/.test(emojiLine.trim()), 'the emoji rail constant is found', emojiLine.slice(0, 60));
  check(/^const SV_REACTION_MAX = \d+;/.test(maxLine.trim()), 'and its repeat cap', maxLine.trim());
  check(/if \(!clearing && btn\) svFloatEmoji\(emoji, btn\)/.test(stories), 'only taps that add a copy float one (clearing is a quiet undo)');
  check(/\.sv-floats\{[^}]*pointer-events:none/.test(fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')), 'the float lane never eats a tap');

  const chrome = findChrome();
  if (!chrome) return skip('no Chrome/Edge found — set CHROME_PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rx-ui-'));
  const keep = !!process.env.KEEP_RX_HTML;
  let out = null;
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    if (keep) console.log('  (page written to ' + htmlPath + ')');
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=390,780',
      '--virtual-time-budget=14000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) { check(false, 'the reaction harness ran', { status: r.status, err: (r.stderr || '').slice(-500), dom: (r.stdout || '').slice(-700) }); }
    else out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
    if (out && out.error) check(false, 'the reaction harness ran without throwing', out.error);
  } finally {
    if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }

  if (out) {
    console.log('\n[2] someone else\'s story gets a quick-pick rail');
    check(out.buttons && out.buttons.length >= 4, 'a row of reaction buttons is painted', out.buttons);
    check(out.buttons && new Set(out.buttons).size === out.buttons.length, 'each emoji appears once', out.buttons);
    check(out.lit === 0 && out.badges === 0 && out.railVisible === true, 'nothing is lit and nothing is counted before you tap', { lit: out.lit, badges: out.badges });
    check(out.railHit === '❤️', 'a tap at a button lands on the button, not the float lane', out.railHit);
    check(out.lanePointer === 'none', 'the float lane itself is pointer-events:none', out.lanePointer);
    check(out.railBetween === true, 'the rail sits between the stage and the footer');
    check(out.railInside === true && out.lastInsideRail === true, 'the whole rail fits a phone viewport', { inside: out.railInside, last: out.lastInsideRail });

    console.log('\n[3] tapping one reacts, ticks and floats a copy');
    check(out.litAfter === 1 && out.litEmoji === '❤️', 'the tapped emoji lights up', { lit: out.litAfter, emoji: out.litEmoji });
    check(out.badgeAfter === '1', 'with a badge showing the one copy you sent', out.badgeAfter);
    check(out.hapticsAfter && out.hapticsAfter.join() === '12', 'and a haptic tick', out.hapticsAfter);
    check(out.floatCount === 1 && out.floatText === '❤️', 'and exactly one copy of it starts floating', { n: out.floatCount, t: out.floatText });
    check(out.floatAnim === 'sv-float', 'the copy runs the real float-up keyframes', out.floatAnim);
    check(out.floatNearButton === true && out.floatAtButton === true, 'rising out of the button it came from', { near: out.floatNearButton, at: out.floatAtButton });
    check(out.apiCalls && out.apiCalls.length === 1 && /\/api\/stories\/s1\/react$/.test(out.apiCalls[0].path) && out.apiCalls[0].emoji === '❤️', 'the POST carries the story and the emoji', out.apiCalls);
    check(out.mineAfter === 1, 'the server response is applied', out.mineAfter);
    check(out.laneCleared === 0, 'the float removes itself when its rise ends');

    console.log('\n[4] the same emoji can be stacked up to four');
    check(out.badge3 === '3', 'a stored count of three renders on the button', out.badge3);
    check(out.mashFloats === 1, 'the fourth tap still floats a copy', out.mashFloats);
    check(out.badge4 === '4', 'and the badge reaches the cap', out.badge4);
    check(out.mashAgg === '[{"emoji":"❤️","count":4}]' && out.mashMine === '[{"emoji":"❤️","count":4}]', 'the tally and my count both move to four', { agg: out.mashAgg, mine: out.mashMine });

    console.log('\n[5] a tap at the cap clears the set (the only undo)');
    check(out.clearFloats === 0, 'clearing floats nothing', out.clearFloats);
    check(out.clearLit === 0 && out.clearBadges === 0, 'the button unlights and its badge goes', { lit: out.clearLit, badges: out.clearBadges });
    check(out.clearAgg === '[]' && out.clearMine === '[]', 'and every copy is taken back', { agg: out.clearAgg, mine: out.clearMine });
    check(out.clearCalls && out.clearCalls[0].emoji === '❤️', 'the request still went out', out.clearCalls);

    console.log('\n[6] opening a story replays the reactions');
    check(out.burstFloats === 3 && out.burstTexts === '❤️❤️😂', 'every reaction on the story floats up (2 hearts + 1 laugh)', { n: out.burstFloats, t: out.burstTexts });

    console.log('\n[7] your own story shows counts, never buttons');
    check(out.ownBurst === 0, 'your own story never replays reactions at you', out.ownBurst);
    check(out.ownButtons === 0, 'no react buttons on your own story', out.ownButtons);
    check(out.ownChips === '🔥3', 'the counts are shown instead', out.ownChips);
    check(out.ownRailVisible === true, 'the row stays up while there are counts');
    check(out.ownEmptyHidden === true && out.ownEmptyChips === 0, 'and disappears when nobody reacted', { hidden: out.ownEmptyHidden });
    check(out.totalChip === '3' && out.buttonCount >= 4, 'someone else\'s story shows the running total beside the buttons', { total: out.totalChip, buttons: out.buttonCount });
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
