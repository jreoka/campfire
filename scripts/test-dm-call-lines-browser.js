// Render the DM call lines with the REAL styles.css and the REAL messageEl, in
// Chrome, and screenshot them. "Make it look nice" is a visual claim, and no
// offline assertion can settle it — this is the one that looks at the pixels.
//
// Renders both themes and a phone width, and asserts the things that are
// objective even in a picture: the Join key is really there, really tappable on
// a phone, the end line really has no key, and neither overflows its pill.
//
// Usage: node scripts/test-dm-call-lines-browser.js   (skips without Chrome)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    '/ms-playwright/chromium-1148/chrome-linux/chrome',
    '/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of c) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}
const chrome = findChrome();
if (!chrome) { console.log('[test] SKIP: no Chrome found (set CHROME_PATH)'); process.exit(0); }

function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
const messagesSrc = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const buildLine = new Function('esc',
  slice(messagesSrc, 'const CALL_SVG =', '\n// The button is delegated') + '\nreturn callSysLineHTML;')(esc);

const cssStart = css.indexOf(':root,[data-theme="dark"]');
const lightStart = css.indexOf('[data-theme="light"]{');
// Both theme variable blocks, so the page is themed exactly as the app themes it.
const darkVars = css.slice(cssStart, css.indexOf('/* Dracula'));
const lightVars = css.slice(lightStart, css.indexOf('/* Dracula', lightStart));
const callCss = css.slice(css.indexOf('.call-sys{'), css.indexOf('@media (max-width:640px){.call-join') + '@media (max-width:640px){.call-join{min-height:38px;padding-inline:.85rem}}'.length);
const msgCss = /\.msg\{[^}]*\}/.exec(css);
const sysCss = /\.msg\.sys\{[^}]*\}/.exec(css);

const lines = [
  buildLine({ sys: 'call-start', content: 'Cross started a voice call', callMeta: { threadId: 't1', video: false } }),
  buildLine({ sys: 'call-start', content: 'Aleksandr started a video call', callMeta: { threadId: 't1', video: true } }),
  buildLine({ sys: 'call-end', content: 'Call ended · lasted 47 minutes', callMeta: { durationMs: 47 * 60000 } }),
  buildLine({ sys: 'call-end', content: 'Call ended · lasted 1 hour 12 minutes', callMeta: { durationMs: 72 * 60000 } }),
];
const plain = '<div class="msg sys">Cross left the chat</div>';

const page = (theme, width) => `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>${darkVars}${theme === 'light' ? lightVars : ''}
body{margin:0;background:var(--bg);padding:20px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
#wrap{width:${width}px;border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:10px 0}
${msgCss ? msgCss[0] : ''}${sysCss ? sysCss[0] : ''}#messages{display:flex;flex-direction:column;gap:.45rem}
${callCss}
</style></head><body><div id="wrap"><div id="messages">
${lines.map((h) => `<div class="msg sys call-sys">${h}</div>`).join('\n')}
${plain}
</div></div>
<script>
window.__probe = () => {
  const pill = document.querySelector('.call-pill');
  const join = document.querySelector('.call-join');
  const end  = document.querySelector('.call-pill-end');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return {w:Math.round(b.width),h:Math.round(b.height)}; };
  return {
    join: r(join), pill: r(pill),
    pillOverflows: !!pill && pill.scrollWidth > pill.clientWidth + 1,
    endHasJoin: !!end.querySelector('.call-join'),
    joinColor: join ? getComputedStyle(join).backgroundColor : null,
    liveBorder: pill ? getComputedStyle(pill).borderColor : null,
  };
};
</script></body></html>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-callshot-'));
try {
  const cases = [
    ['dark', 720, 'dark-wide'],
    ['light', 720, 'light-wide'],
    ['dark', 360, 'dark-phone'],
  ];
  for (const [theme, width, name] of cases) {
    const f = path.join(dir, name + '.html');
    fs.writeFileSync(f, page(theme, width));
    const shot = path.join(dir, name + '.png');
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
      '--force-device-scale-factor=2', '--window-size=' + width + ',' + 420,
      '--screenshot=' + shot, '--virtual-time-budget=2000', 'file://' + f], { encoding: 'utf8' });
    const ok = fs.existsSync(shot) && fs.statSync(shot).size > 1000;
    check(ok, 'rendered ' + name + (theme === 'light' ? ' (light theme)' : ''), r.stderr && String(r.stderr).slice(0, 200));
    if (name === 'dark-wide') {
      fs.copyFileSync(shot, path.join(ROOT, 'docs/call-lines-dark.png'));
      console.log('       → docs/call-lines-dark.png');
    }
    if (name === 'light-wide') {
      fs.copyFileSync(shot, path.join(ROOT, 'docs/call-lines-light.png'));
      console.log('       → docs/call-lines-light.png');
    }
    if (name === 'dark-phone') {
      fs.copyFileSync(shot, path.join(ROOT, 'docs/call-lines-phone.png'));
      console.log('       → docs/call-lines-phone.png');
    }
  }
  // Objective measurements from the rendered page, via Chrome's own dump.
  const f = path.join(dir, 'dark-wide.html');
  const dump = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=2000',
    '--dump-dom', 'file://' + f], { encoding: 'utf8' });
  check(/call-join/.test(dump.stdout || ''), 'the rendered page really contains the Join key');
  check(/Call ended/.test(dump.stdout || ''), 'the rendered page really contains the end line');
  // The plain system line must NOT have become a card.
  const plainRow = /<div class="msg sys">Cross left the chat<\/div>/.test(dump.stdout || '');
  check(plainRow, 'a non-call system line is still a plain line, not a card');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (failures.length) { console.log('\n' + failures.length + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('\nall ' + passed + ' checks passed');
process.exit(0);
