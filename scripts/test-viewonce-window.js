// The view-once replay WINDOW, on the card itself.
//
// The rule: the recipient gets one view, then one replay that has to be started
// within 30 seconds of it — the server runs that clock (VIEWONCE_REPLAY_MS, the
// byte sweep, and a read-time mask that reports a lapsed window as consumed),
// and scripts/test-viewonce.js covers that half against a live server. This is
// the other half: the card the reader is actually looking at counts the window
// down in place and takes its own tap away the second it closes, without waiting
// for a refetch or a push.
//
// Offline for the source checks; then the REAL voCardHTML/voTick (sliced out of
// public/js/viewonce.js) are driven against the REAL stylesheet in headless
// Chrome, skipping without Chrome.
//
// Usage: node scripts/test-viewonce-window.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public/js/viewonce.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
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
function slice(from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block in public/js/viewonce.js'); process.exit(1); }
  return src.slice(a, b);
}

console.log('\n[1] the card is on the clock the server set');
// The window is a server-owned number: the card must read replayUntil (and the
// window length) rather than assume 30 seconds of its own.
check(/data-vo-until="\$\{Number\(vo\.replayUntil\) \|\| 0\}"/.test(src), 'the countdown is anchored to the server\'s replayUntil');
check(/function voLiveState\(vo\)[\s\S]{0,220}replayUntil\) <= Date\.now\(\)\) return 'consumed'/.test(src),
  'a lapsed window paints as opened without another fetch', null);
check(/function voTick\(\)[\s\S]{0,900}card\.disabled = true/.test(src), 'and the ticker disables the card it expires', null);
check(/voWindowSecs\(info\)/.test(src) && /info\.replayWindowMs/.test(src),
  'the player\'s copy quotes the server\'s window length', null);
check(/replay_expired/.test(src), 'a late replay is told apart from an already-opened one', null);
check(/id="vo-view"/.test(html) && /id="vo-sub"/.test(html), 'the one-shot player is still in the shell', null);

// ---------- the card itself, in a browser ----------
const cardSrc = slice('function voLiveState(vo) {', '// Delegated: cards render');

function pageHtml() {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/public/styles.css"></head><body>
<script>
window.S = { me: { id: 'me' } };
// The page's own escaper, cut to the same contract the app's has.
window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
${cardSrc}
(async () => {
  const out = {};
  const paint = (msg) => {
    const d = document.createElement('div');
    d.innerHTML = voCardHTML(msg);
    document.body.appendChild(d);
    return d.firstElementChild;
  };
  const snap = () => {
    const card = document.querySelector('.vo-card');
    const count = card && card.querySelector('.vo-count');
    const cs = card ? getComputedStyle(card) : null;
    const ccs = count ? getComputedStyle(count) : null;
    return {
      tag: card ? card.tagName : '',
      classes: card ? card.className : '',
      disabled: !!(card && card.disabled),
      title: (card && card.querySelector('.vo-title') || {}).textContent || '',
      sub: (card && card.querySelector('.vo-sub') || {}).textContent || '',
      count: count ? count.textContent : '',
      until: count ? Number(count.dataset.voUntil) || 0 : 0,
      go: (card && card.querySelector('.vo-go') || {}).textContent || '',
      flag: !!(card && card.querySelector('.vo-flag')),
      dataVo: !!(card && card.getAttribute('data-vo')),
      border: cs ? cs.borderTopWidth : '',
      figures: ccs ? ccs.fontVariantNumeric : '',
    };
  };
  const msg = (id, who, vo) => ({ id, user: { id: who }, viewOnce: vo });
  const t0 = Date.now();
  out.t0 = t0;

  // A locked item: one tap, no clock yet.
  let card = paint(msg('m1', 'u2', { state: 'unopened', kind: 'image', replaysLeft: 1, replayUntil: 0, replayWindowMs: 30000 }));
  out.unopened = snap();
  card.remove();

  // The first view is over: the window is counting.
  card = paint(msg('m2', 'u2', { state: 'replayable', kind: 'image', replaysLeft: 0, replayUntil: t0 + 30000, replayWindowMs: 30000 }));
  out.replay = snap();
  await new Promise((r) => setTimeout(r, 1300));
  out.ticked = snap();
  // Force the deadline instead of waiting 30s of virtual time out: this is the
  // exact attribute the server's replayUntil paints.
  card.querySelector('.vo-count').dataset.voUntil = String(Date.now() + 300);
  await new Promise((r) => setTimeout(r, 1700));
  out.expired = snap();
  card.remove();

  // The sender's copy of the same window.
  card = paint(msg('m3', 'me', { state: 'replayable', kind: 'video', replaysLeft: 0, replayUntil: Date.now() + 30000, replayWindowMs: 30000 }));
  out.mine = snap();
  card.querySelector('.vo-count').dataset.voUntil = String(Date.now() + 300);
  await new Promise((r) => setTimeout(r, 1700));
  out.mineExpired = snap();
  card.remove();

  // A window the server already reports as lapsed (masked at read time) never
  // paints a countdown at all.
  card = paint(msg('m4', 'u2', { state: 'replayable', kind: 'image', replaysLeft: 0, replayUntil: Date.now() - 1000, replayWindowMs: 30000 }));
  out.lapsed = snap();
  card.remove();

  document.title = JSON.stringify(out);
})().catch((e) => { document.title = JSON.stringify({ error: String((e && e.message) || e) }); });
</script></body></html>`;
}

function runChrome() {
  const chrome = findChrome();
  if (!chrome) return { skip: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vo-window-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, pageHtml());
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'prof'), '--window-size=520,900',
      '--virtual-time-budget=9000', '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    const m = /<title>([\s\S]*?)<\/title>/.exec(r.stdout || '');
    if (!m) return { error: 'harness produced no title (status ' + r.status + ')' };
    return { out: JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

if (!findChrome()) {
  console.log('\n[test] SKIP browser half: no Chrome/Edge found (set CHROME_PATH)');
} else {
  console.log('\n[2] the card itself (headless Chrome)');
  const res = runChrome();
  if (res.skip) {
    console.log('[test] SKIP: no Chrome');
  } else if (res.error || !res.out || res.out.error) {
    check(false, 'the card harness ran', res.error || (res.out && res.out.error));
  } else {
    const o = res.out;
    // A locked item.
    check(o.unopened.sub === 'Tap to open · one view, one replay' && o.unopened.go === 'Open' && !o.unopened.disabled,
      'an unopened card is one tap, with no clock on it', o.unopened);
    check(o.unopened.count === '' && !o.unopened.classes.includes('vo-replay') && o.unopened.border === '0px',
      'and carries no countdown and no replay border', o.unopened);

    // The live window.
    check(/^\d+s left to replay$/.test(o.replay.count), 'the replay card counts the window down', o.replay);
    check(o.replay.until - o.t0 > 28000 && o.replay.until - o.t0 <= 30000,
      'against the deadline the server set (30s), not one of its own', o.replay.until - o.t0);
    check(o.replay.go === 'Replay' && o.replay.flag && o.replay.classes.includes('vo-replay') && !o.replay.disabled,
      'with a Replay chip, the accent border and a live tap', o.replay);
    check(o.replay.border === '1px', 'the replay border is the stylesheet\'s, not the test\'s', o.replay.border);
    check(/^\d+s left to replay$/.test(o.ticked.count) && parseInt(o.ticked.count, 10) < parseInt(o.replay.count, 10),
      'and the number ticks itself down in place', [o.replay.count, o.ticked.count]);
    check(o.replay.figures === 'tabular-nums', 'in tabular figures, so the countdown does not wobble', o.replay.figures);

    // The window running out takes the tap with it.
    check(o.expired.disabled === true && o.expired.classes.includes('vo-expired') && !o.expired.classes.includes('vo-replay'),
      'when it runs out the card stops being tappable', o.expired);
    check(o.expired.sub === 'Replay window closed' && o.expired.go === '' && !o.expired.flag,
      'reads as closed, with the Replay chip gone', o.expired);

    // The sender watches the same clock.
    check(/^They can replay · \d+s left$/.test(o.mine.count), 'the sender\'s card runs the same countdown', o.mine);
    check(o.mine.title === 'View-once video · replay ready' && o.mine.disabled === true && o.mine.go === '',
      'as their own disabled card (never a tap of their own)', o.mine);
    check(o.mineExpired.sub === 'Opened by them' && o.mineExpired.classes.includes('vo-expired'),
      'and reads as opened when the window closes', o.mineExpired);

    // A lapsed window the server already masked.
    check(o.lapsed.tag === 'DIV' && o.lapsed.classes.includes('vo-done') && o.lapsed.sub === 'Opened' && !o.lapsed.dataVo,
      'a window the server reports as lapsed paints the tombstone outright', o.lapsed);
  }
}

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
process.exit(failures.length ? 1 : 0);
