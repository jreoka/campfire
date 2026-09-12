// The story viewer's header opens the poster's profile.
//
// Owner ask: "if you click in someone's story, their user at the top corner
// should open their profile page" — and the profile picture there is the story
// button again (see test-user-card-actions.js), so the two surfaces lead into
// each other.
//
// Offline: the real `#story-view` markup is checked to be one real <button>
// (picture + name + sub) instead of two loose spans, the real click wiring is
// sliced out of public/js/stories.js and checked for the order that matters
// (close the viewer, THEN open the profile — the profile sits under the viewer
// in the stack, and a story that keeps running behind it would close itself
// mid-look), `svShow` arms the button with the author, and `openProfileScreen`
// takes a fallback user for a poster who is no longer in any loaded roster.
//
// Headless Chrome (skips without it): the real markup + stylesheet, a phone
// viewport — the header is a button, the avatar's own pixels hit-test into it,
// clicking it opens that author's profile, the row fits beside the sound /
// more / close icons, and a header with no author does nothing at all.
//
// Usage: node scripts/test-story-viewer-profile.js

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
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

const head = index.slice(index.indexOf('<div class="sv-head">'), index.indexOf('<div class="sv-stage"'));
const wiringStart = stories.indexOf("$('#sv-close').onclick");
const wiringEnd = stories.indexOf("$('#sv-sound').onclick");
if (wiringStart < 0 || wiringEnd < 0 || wiringEnd < wiringStart) {
  console.error('[test] could not locate the story viewer header wiring in public/js/stories.js');
  process.exit(1);
}
const wiring = stories.slice(wiringStart, wiringEnd);

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
${index.slice(index.indexOf('<div id="story-view"'), index.indexOf('<!-- stories: composer'))}
<script>
window.$ = (s) => document.querySelector(s);
window.__calls = [];
window.sv = { whoId: 'author-1', whoUser: { id: 'author-1', display_name: 'Sam' } };
window.svClose = () => { window.__calls.push(['close', window.sv && window.sv.whoId]); };
window.openProfileScreen = (uid, u) => { window.__calls.push(['profile', uid, u && u.display_name]); };
${wiring}
const out = {};
const root = document.getElementById('story-view');
root.classList.remove('hidden');
document.body.classList.add('story-open');
const who = document.getElementById('sv-who');
const av = document.getElementById('sv-av');
out.tag = who.tagName;
out.type = who.getAttribute('type');
out.role = who.getAttribute('role');
const cs = getComputedStyle(who);
out.bg = cs.backgroundColor;
out.border = cs.borderTopWidth;
out.cursor = cs.cursor;
out.color = cs.color;
out.headContains = !!who.querySelector('#sv-av') && !!who.querySelector('#sv-name') && !!who.querySelector('#sv-sub');
out.nameTag = document.getElementById('sv-name').tagName;
// The picture's own pixels are a tap target for the header.
const r = av.getBoundingClientRect();
const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
out.hitAvatar = !!(document.elementFromPoint(cx, cy) || {}).closest
  && document.elementFromPoint(cx, cy).closest('#sv-who') === who;
// It must not run under the icons on the right.
const sound = document.getElementById('sv-sound').getBoundingClientRect();
out.gap = Math.round(sound.left - who.getBoundingClientRect().right);
out.whoW = Math.round(who.getBoundingClientRect().width);
who.click();
out.click = window.__calls.slice();
// Enter/Space activation comes from being a real focusable <button> — a
// synthetic keydown proves nothing (untrusted events have no default action),
// so what this pins is that the element is focusable and tab-reachable.
window.__calls.length = 0;
who.focus();
out.focusable = document.activeElement === who;
out.tab = who.tabIndex;
// The header must not be a way into a profile it does not have.
window.__calls.length = 0;
window.sv.whoId = null;
window.sv.whoUser = null;
who.click();
out.noAuthor = window.__calls.slice();
document.title = JSON.stringify(out);
</script></body></html>`;
}

function main() {
  console.log('\n[1] the header is one button: picture + name');
  check(/<button[^>]*id="sv-who"/.test(head), 'the header is a real button (keyboard + hit target)', head.slice(0, 90));
  const btn = (/<button[^>]*id="sv-who"[\s\S]*?<\/button>/.exec(head) || [''])[0];
  check(!!btn && /id="sv-av"/.test(btn) && /id="sv-name"/.test(btn) && /id="sv-sub"/.test(btn), 'it wraps the avatar, the name and the sub line', btn);
  check((head.match(/id="sv-av"/g) || []).length === 1, 'there is no leftover avatar span beside it');
  check(!/<span class="sv-who">/.test(head), 'the old loose .sv-who span is gone');
  check(/\.sv-who\{[^}]*cursor:pointer/.test(css) && /\.sv-who\{[^}]*background:transparent/.test(css) && /\.sv-who\{[^}]*border:0/.test(css), 'the button styling is reset (.css)');
  check(/\.sv-who-txt\{[^}]*flex-direction:column/.test(css), 'the name/sub stay a stack inside it (.css)');
  check(/\.sv-who b\{[^}]*font-weight:750/.test(css), 'the name keeps its weight (.css)');
  check(/\.sv-who:not\(:disabled\):hover b\{text-decoration:underline\}/.test(css), 'hover underlines the name (it is a link to a person) (.css)');

  console.log('\n[2] svShow arms it, the click closes the viewer first');
  check(/sv\.whoId = aid;/.test(stories) && /sv\.whoUser = aid \? author : null;/.test(stories), 'the current item\'s author is remembered on the viewer', null);
  check(/who\.disabled = !aid;/.test(stories), 'and the header is disabled when the item has no author');
  check(/sv\.whoId = aid;[\s\S]{0,200}who\.disabled = !aid;/.test(stories), 'both happen together when the header is repainted');
  check(/\$\('#sv-who'\)\.onclick = \(\) => \{/.test(wiring), 'the header carries the handler');
  check(/const uid = sv && sv\.whoId;[\s\S]{0,120}if \(!uid\) return;/.test(wiring), 'with no author it does nothing');
  const closeAt = wiring.indexOf('svClose();');
  const openAt = wiring.indexOf('openProfileScreen(uid, u);');
  check(closeAt > 0 && openAt > closeAt, 'it closes the viewer before opening the profile (the profile sits under it in the stack)', { closeAt, openAt });
  check(/openProfileScreen\(uid, u\)/.test(wiring), 'and hands over the author it has, not just an id');

  console.log('\n[3] the profile screen accepts that hand-over');
  check(/function openProfileScreen\(uid, fallback\)/.test(pickers), 'openProfileScreen takes a fallback user');
  check(/memberById\(uid\) \|\| \(fallback && fallback\.id === uid \? fallback : null\)/.test(pickers), 'the roster still wins; the fallback only fills a gap');
  check(/paintStoryAvatar\(\$\('#pf-avatar'\), u, \{ ring: '3px'/.test(stories), 'and its picture is the story button (back into the story)');

  const chrome = findChrome();
  if (!chrome) {
    console.log('\n[test] SKIP browser half: no Chrome/Edge found (set CHROME_PATH)');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-sv-head-'));
    try {
      const htmlPath = path.join(dir, 'page.html');
      fs.writeFileSync(htmlPath, pageHtml());
      const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=420,760',
        '--virtual-time-budget=2500', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
      if (!m) {
        check(false, 'the header harness ran', { status: r.status });
      } else {
        const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        console.log('\n[4] the painted header (headless Chrome)');
        check(out.tag === 'BUTTON' && out.type === 'button', 'it really renders as a button', out.tag);
        check(out.bg === 'rgba(0, 0, 0, 0)' && out.border === '0px' && out.cursor === 'pointer', 'looking like plain header text, not a chip', { bg: out.bg, border: out.border });
        check(out.headContains && out.nameTag === 'B', 'the picture, name and sub all live inside it', { name: out.nameTag });
        check(out.hitAvatar, 'a tap on the picture itself lands on the header button');
        check(out.gap >= 0 && out.whoW > 100, 'the header stops before the sound/more/close icons', { gap: out.gap, w: out.whoW });
        check(out.click.length === 2 && out.click[0][0] === 'close' && out.click[1][0] === 'profile' && out.click[1][1] === 'author-1',
          'clicking opens that author\'s profile, after closing the viewer', out.click);
        check(out.focusable && out.tab === 0, 'keyboard-reachable (Enter/Space activate a real button natively)', { focus: out.focusable, tab: out.tab });
        check(out.noAuthor.length === 0, 'an item with no author opens nothing', out.noAuthor);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
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
