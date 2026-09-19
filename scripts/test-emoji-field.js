// The emoji picker button inside a profile field (custom status, bio).
//
// The request: the "Custom status" dialog your own card opens should carry an
// emoji button INSIDE the input box, and so should the bio box in Settings →
// Profile. (Settings → Profile has no status field of its own — the status is
// set from your own user card, and its dialog is where the status is typed.)
//
// What that costs, and what this pins:
//
//   1. The button is chrome (an inline SVG smiley, never an emoji glyph) and it
//      rides the field's own box: the wrapper is the positioning context, the
//      field pays for it with trailing padding, a single-line field centres it
//      and a textarea puts it in the bottom-right corner where a taller box
//      expects it.
//   2. It opens the SAME picker, in a new `field` mode: the pick is inserted at
//      the caret of the field the button sits in and the caret is handed back to
//      it — not to a composer. The GIF tab (which posts into the conversation)
//      is not offered there, and there is no `/api/gifs` call.
//   3. The picker has to beat the dialog the field lives in. #picker is z-index
//      150 and the dialog layer reaches 175 (.over-pop), so without the
//      `.pk-over` lift the status editor's picker opened BEHIND the editor.
//   4. A status is escaped plain text (statusBubbleHTML), so its picker is held
//      to standard emoji; a bio renders through renderRich and takes both.
//   5. A profile field is NOT a composer: inserting must not file the field's
//      text as a chat draft (a bio would surface in the message box on the next
//      channel switch), and it must fire a real 'input' event so the bio counter
//      keeps up.
//
// Offline checks always run; the geometry/hit-test half drives the REAL
// styles.css, the REAL pickers.js, the REAL #picker block and the REAL bio box
// out of index.html in headless Chrome over CDP, skipping when Chrome/Edge is
// missing.
//
// Usage: node scripts/test-emoji-field.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE_MQ = '(max-width:700px), (max-height:560px) and (pointer:coarse)';
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
function connectWs(url) {
  const WS = globalThis.WebSocket || require('ws');
  const sock = new WS(url, { perMessageDeflate: false });
  const on = (ev, fn) => (typeof sock.addEventListener === 'function' ? sock.addEventListener(ev, fn) : sock.on(ev, fn));
  return { send: (d) => sock.send(d), on, close: () => { try { sock.close(); } catch {} } };
}

// ---------- the real markup, lifted out of index.html ----------
// The <label>…</label> holding a field id (neither of these nests a label).
function fieldBlock(index, id) {
  const at = index.indexOf('id="' + id + '"');
  if (at < 0) return null;
  const start = index.lastIndexOf('<label', at);
  const end = index.indexOf('</label>', at);
  if (start < 0 || end < 0) return null;
  return index.slice(start, end + '</label>'.length);
}
// The #picker block, walked by div nesting (a regex stops at the wrong </div>).
function pickerMarkup(index) {
  const start = index.indexOf('<div id="picker"');
  if (start < 0) return null;
  let depth = 0, i = start;
  for (; i < index.length; i++) {
    if (index.startsWith('<div', i)) { depth++; i += 3; }
    else if (index.startsWith('</div>', i)) { depth--; i += 5; if (depth === 0) return index.slice(start, i + 1); }
  }
  return null;
}
function modalMarkup(index) {
  const start = index.indexOf('<div id="modal-backdrop"');
  if (start < 0) return null;
  let depth = 0, i = start;
  for (; i < index.length; i++) {
    if (index.startsWith('<div', i)) { depth++; i += 3; }
    else if (index.startsWith('</div>', i)) { depth--; i += 5; if (depth === 0) return index.slice(start, i + 1); }
  }
  return null;
}

// ---------- the page: a minimal shell around the real pieces ----------
function pageHtml(bioBlock, pickerBlock, modalBlock) {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${css}</style>
<style>
  :root{--composer-h:74px;--strip-h:1.2rem;--safe-t:0px;--safe-b:0px}
  html,body{margin:0;height:100%;overflow:clip}
  *,*::before,*::after{box-sizing:border-box}
  #app{height:var(--vvh,100dvh);display:flex;flex-direction:column;overflow:hidden}
  #messages{flex:1;min-height:0;overflow:auto}
  #typing-bar{flex:0 0 auto;height:var(--strip-h)}
  /* The two shells a profile field really lives in, trimmed to their layout. */
  .set-pane{padding:1rem}
  #settings-backdrop .settings{max-height:80vh;overflow:hidden}
</style>
</head><body>
<div id="app"><main id="chat">
  <div id="messages"></div>
  <div id="typing-bar"><span id="typing"></span></div>
  <form id="composer"><div id="composer-box"><textarea id="in-message" rows="1"></textarea></div>
  <button class="send-btn" type="submit">S</button></form>
</main></div>
<div id="settings-backdrop"><div class="settings"><div class="set-body">
  <div class="set-pane" id="set-profile">${bioBlock}</div>
</div></div></div>
${modalBlock}
<div id="toast" class="hidden"></div>
${pickerBlock}
<script>
/* ---- the app globals pickers.js touches, as the smallest honest stand-ins ---- */
window.__toasts = [];
window.__apiCalls = [];
window.__draftCalls = 0;
window.__bioInputs = 0;
window.S = {
  picker: null, pickerReturnFocus: null, gifPick: null, tagEmojiInput: null, tagEmojiDone: null,
  gifFavs: null, serverEmojis: [], servers: [], emojiAll: {}, me: { id: 'me' }, stdEmoji: {},
};
window.$ = (sel) => document.querySelector(sel);
window.$$ = (sel) => document.querySelectorAll(sel);
window.haptic = () => {};
window.toast = (m) => { window.__toasts.push(String(m)); };
window.cfEditable = (el) => {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !/^(button|checkbox|radio|file|submit|reset|range|color|image|hidden)$/i.test(el.type || 'text');
  return el.isContentEditable === true;
};
window.api = async (url) => { window.__apiCalls.push(String(url)); return { favorites: [], gifs: [] }; };
window.esc = (s) => String(s == null ? '' : s);
window.renderRich = (s) => s;
window.syncComposerRender = () => {};
window.syncThreadRender = () => {};
/* core.js's draft store: a profile field must never reach it. */
window.draftSoon = () => { window.__draftCalls++; };
window.draftCtxForEl = () => 's:1:2';
window.applyProfileUrl = () => {};
window.renderComposerMeta = () => {};
window.renderThreadComposerMeta = () => {};
window.threadComposerAnchor = () => null;
window.composerAnchor = () => null;
window.composerHasDraft = () => false;
window.gifComposerReady = () => false;
window.pickerVisibleThread = () => false;
window.setAttPreview = () => {};
window.postGif = () => {};
window.sendChat = () => {};
window.sendDm = () => {};
window.toggleReaction = () => {};
window.msgById = () => null;
window.chatGifFavFromBtn = () => null;
window.phoneLayout = () => matchMedia(${JSON.stringify(PHONE_MQ)}).matches;
/* The real bio counter's contract: it listens for 'input' on #set-bio. */
document.getElementById('set-bio').addEventListener('input', () => { window.__bioInputs++; });
</script>
<script>${pickers}</script>
<script>
/* The status editor's own field, built by the REAL helper (openStatusEditor),
   dropped into the modal shell lifted out of index.html — which ships hidden, so
   the dialog is put on screen the way openModal does. */
document.getElementById('modal-body').innerHTML =
  '<label>Status' + emojiFieldHTML('<input id="m-status-text" maxlength="64" placeholder="What\\'s up?" value="" />', { std: true }) + '</label>';
document.getElementById('modal-backdrop').classList.remove('hidden');
document.getElementById('modal-backdrop').classList.add('over-pop');

window.__boxOf = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
};
/* Is the button inside the field's own box, and where? */
window.__fieldGeom = (fieldId) => {
  const f = document.getElementById(fieldId);
  if (!f) return null;
  const wrap = f.closest('.emoji-field');
  const btn = wrap && wrap.querySelector('.emoji-field-btn');
  if (!btn) return { wrap: false };
  const fr = f.getBoundingClientRect(), br = btn.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const cs = getComputedStyle(f);
  return {
    wrap: true,
    area: wrap.classList.contains('area'),
    inside: br.left >= fr.left - 0.5 && br.right <= fr.right + 0.5 && br.top >= fr.top - 0.5 && br.bottom <= fr.bottom + 0.5,
    rightGap: +(fr.right - br.right).toFixed(1),
    topGap: +(br.top - fr.top).toFixed(1),
    bottomGap: +(fr.bottom - br.bottom).toFixed(1),
    centreOff: +(((br.top + br.height / 2) - (fr.top + fr.height / 2))).toFixed(1),
    fieldH: +fr.height.toFixed(1),
    wrapH: +wr.height.toFixed(1),
    wrapTopOff: +(fr.top - wr.top).toFixed(1),
    btnW: +br.width.toFixed(1), btnH: +br.height.toFixed(1),
    padRight: parseFloat(cs.paddingRight),
    svg: !!btn.querySelector('svg'),
  };
};
window.__state = () => {
  const pk = document.getElementById('picker');
  const gifTab = document.querySelector('#picker .pk-tab[data-ptab="gifs"]');
  return {
    open: !pk.classList.contains('hidden'),
    cls: pk.className,
    mode: window.S.picker && window.S.picker.mode,
    picker: window.__boxOf('#picker'),
    hit: (() => {
      const r = pk.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 22);
      return el ? (el.closest('#picker') ? 'picker' : (el.id || el.className || el.tagName)) : null;
    })(),
    activeId: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    statusValue: (document.getElementById('m-status-text') || {}).value,
    bioValue: (document.getElementById('set-bio') || {}).value,
    bioInputs: window.__bioInputs,
    draftCalls: window.__draftCalls,
    toasts: window.__toasts.slice(),
    gifTabHidden: !!(gifTab && gifTab.classList.contains('hidden')),
    api: window.__apiCalls.slice(),
  };
};
/* A real click on the field's own emoji button — the whole entry point. */
window.__clickBtn = (fieldId) => {
  const f = document.getElementById(fieldId);
  const btn = f && f.closest('.emoji-field').querySelector('.emoji-field-btn');
  if (!btn) return null;
  const focusedBefore = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null;
  btn.click();
  return { focusedBefore, ...window.__state() };
};
window.__pickEmoji = (ch) => { pickEmoji(ch); return window.__state(); };
window.__pickFirstTile = () => {
  const b = document.querySelector('#pk-emoji .pk-emoji-btn');
  if (!b) return { none: true };
  const ch = b.textContent;
  b.click();
  return { ch, ...window.__state() };
};
window.__closeFieldPicker = () => { closePicker(false); return window.__state(); };
/* The picker enters with cf-pop-in (a scale animation), so a rect read a few
   milliseconds after open is the animation's, not the settled box. */
window.__settle = () => new Promise((r) => setTimeout(r, 300));
</script>
</body></html>`;
}

// ---------------- the checks ----------------
function staticChecks() {
  console.log('\n[1] every status field and the bio box carries the button');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
  const final = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  // Settings → Profile deliberately has NO status field: a status is typed in
  // the card's own "Custom status" dialog (openStatusEditor), so the settings
  // pane must not grow a second place to set one.
  check(!fieldBlock(index, 'set-statustext'),
    'Settings → Profile carries no custom-status field (the user card owns it)');
  const bio = fieldBlock(index, 'set-bio');
  check(!!bio && /class="emoji-field area"/.test(bio) && /class="emoji-field-btn"/.test(bio),
    'Settings → Bio has the button inside the box, in the corner a textarea expects', bio);
  check(!bio || !/data-emoji-std/.test(bio), 'the bio takes custom emoji too (renderRich)', bio);
  // The status EDITOR (your own card's bubble opens it) and the admin user editor.
  check(/const field = `<input id="m-status-text"/.test(pickers) && /emojiFieldHTML\(field, \{ std: true \}\)/.test(pickers),
    'the Custom status dialog builds its field through the same helper');
  check(/data-emoji-std="1"/.test(pickers), 'and marks it standard-emoji-only (a status is escaped text)');
  check(/emojiFieldHTML\('<textarea id="m-adm-bio"[\s\S]*?\{ area: true \}\)/.test(admin),
    'the admin user editor\'s bio box carries it too');

  console.log('\n[2] the picker has a field mode that cannot post a GIF');
  check(/function openFieldPicker\(field, btn, opts = \{\}\)/.test(pickers), 'openFieldPicker exists');
  check(/openPicker\('field', null, 'emoji', \{ x: r\.left \+ r\.width \/ 2, y: r\.top \}, field, \{ stdOnly: !!opts\.stdOnly \}\)/.test(pickers),
    'it carries the ELEMENT (not a composer bar name) and anchors to the button');
  check(/if \(S\.picker && S\.picker\.mode === 'field' && S\.picker\.input && S\.picker\.input\.isConnected\) return S\.picker\.input;/.test(pickers),
    'pickerInputEl resolves a field pick to that element');
  check(/gifTab\.classList\.toggle\('hidden', mode !== 'insert'\)/.test(pickers) && /if \(mode === 'insert'\) loadGifTrending\(\)/.test(pickers),
    'the GIF tab (and its API call) belong to a composer pick only');
  check(/toast\('Status supports standard emoji only'\)/.test(pickers), 'a status pick refuses a custom :name: out loud');

  console.log('\n[3] the picker beats the dialog holding the field');
  check(/PICKER_DIALOG_SEL = '#modal-backdrop,#settings-backdrop/.test(pickers), 'the dialog layers are named once');
  check(/pk\.classList\.toggle\('pk-over', !!\(input && input\.closest && input\.closest\(PICKER_DIALOG_SEL\)\)\)/.test(pickers),
    'a pick on a field inside a dialog lifts the picker');
  const z = /#picker\.pk-over\{z-index:(\d+)\}/.exec(css);
  const pop = /#modal-backdrop\.over-pop\{z-index:(\d+)\}/.exec(css);
  check(!!z && !!pop && +z[1] > +pop[1], 'the lift clears the dialog layer (and a dialog over a person card)', { picker: z && z[1], dialog: pop && pop[1] });
  check(/!e\.target\.closest\('\.emoji-field-btn'\)/.test(final),
    'the outside-click closer in final.js does not shut the picker it just opened');

  console.log('\n[4] a profile field is not a composer');
  check(/if \(!isComposerField\(input\)\) \{\s+try \{ input\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\); \} catch \{\}\s+return;\s+\}/.test(pickers),
    'an insert into a plain field fires a real input event and returns before the draft store');
  check(/function isComposerField\(el\) \{ return !!el && \(el\.id === 'in-message' \|\| el\.id === 'in-thread'\); \}/.test(pickers),
    'only the two composer bars are composer fields');
  check(/function syncRenderFor\(input\) \{\s+if \(!isComposerField\(input\)\) return;/.test(pickers),
    'and the backdrop painters leave a profile field alone');

  console.log('\n[5] the button rides the field\'s own box');
  check(/\.emoji-field\{position:relative;display:block;margin-top:\.35rem\}/.test(css), 'the wrapper is the positioning context');
  check(/\.emoji-field>input,\.emoji-field>textarea\{display:block;margin-top:0!important;padding-right:2\.4rem!important\}/.test(css),
    'the field is block-level inside it (so the wrapper IS the field\'s box) and pays for the button with trailing padding');
  check(/\.emoji-field\.area>\.emoji-field-btn\{top:auto;bottom:\.45rem;transform:none\}/.test(css),
    'a textarea puts it in the bottom-right corner');
  check(/\.emoji-field>\.emoji-field-btn\{position:absolute;right:\.35rem;top:50%;transform:translateY\(-50%\)/.test(css),
    'a single-line field centres it');
}

async function withChrome(fn) {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found — set CHROME_PATH');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const bio = fieldBlock(index, 'set-bio');
  const picker = pickerMarkup(index);
  const modal = modalMarkup(index);
  if (!bio || !picker || !modal) return skip('could not lift the real bio/picker/modal markup out of index.html');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-efield-'));
  const port = 9900 + Math.floor(Math.random() * 90);
  const htmlPath = path.join(tmp, 'field.html');
  fs.writeFileSync(htmlPath, pageHtml(bio, picker, modal));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(tmp, 'prof')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {}
    if (!ver) await sleep(250);
  }
  if (!ver) { try { chrome.kill(); } catch {} return skip('Chrome did not expose the DevTools port'); }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const { on, send, close } = connectWs(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { on('open', res); on('error', rej); });
  let msgId = 0;
  const pending = new Map();
  on('message', (evt) => {
    const m = JSON.parse(String(evt.data !== undefined ? evt.data : evt));
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    }
  });
  const rpc = (method, params = {}) => new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { res, rej });
    send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const device = async (w, h, { touch = true } = {}) => {
    await rpc('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await rpc('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: touch,
      screenWidth: w, screenHeight: h, screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    try { await rpc('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
    try { await rpc('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }); } catch {}
    await sleep(250);
  };
  try {
    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    await sleep(900);
    // FIELD_SHOT=<file.png> renders the current surface (see the calls below).
    const shoot = async (setup, file) => {
      await evaluate(setup);
      await sleep(350);
      const r = await rpc('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('  shot ' + file);
    };
    return await fn({ device, evaluate, rpc, shoot });
  } finally {
    try { close(); } catch {}
    try { chrome.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

const inside = (r, vw, vh, slack = 1) => r && r.l >= -slack && r.t >= -slack && r.r <= vw + slack && r.b <= vh + slack;

async function desktopChecks() {
  await withChrome(async ({ device, evaluate, shoot }) => {
    await device(1280, 900, { touch: false });
    if (process.env.FIELD_SHOT) {
      const base = process.env.FIELD_SHOT.replace(/\.png$/, '');
      await shoot('(() => { document.getElementById("modal-backdrop").classList.add("hidden"); return 1; })()', base + '-settings.png');
      await shoot('(() => { const m = document.getElementById("modal-backdrop"); m.classList.remove("hidden"); __clickBtn("m-status-text"); return 1; })()', base + '-status.png');
      // The shot above left the picker open; put the page back the way the
      // checks below expect to find it.
      await evaluate('__closeFieldPicker()');
    }

    console.log('\n[6] desktop, the Custom status dialog: the button rides the input');
    const g = await evaluate('__fieldGeom("m-status-text")');
    check(!!g && g.wrap && g.svg, 'the field carries the wrapper and an svg button', g);
    check(!!g && g.inside, 'the button sits INSIDE the input box', g);
    check(!!g && Math.abs(g.centreOff) <= 2, 'and is vertically centred on the single-line field', g);
    check(!!g && g.padRight >= g.btnW + 4, 'the field reserves room for it (a long value never runs under it)', g);
    check(!!g && g.rightGap > 0 && g.rightGap < 10, 'hugging the field\'s right edge', g);

    console.log('\n[7] clicking it opens the picker OVER the dialog it lives in');
    // Read the state SYNCHRONOUSLY off the click: the picker focuses its own
    // search field a tick later, which would hide whether the label forwarded
    // the tap into the field (it must not — a phone would raise the keyboard).
    const s0 = await evaluate('__clickBtn("m-status-text")');
    check(s0.activeId !== 'm-status-text', 'clicking the button did not push the caret into the field', { activeId: s0.activeId });
    await evaluate('__settle()');
    const s = await evaluate('__state()');
    check(s.open === true, 'the button opens the picker', s);
    check(s.mode === 'field', 'in the new field mode', s);
    check(s.cls.includes('pk-over'), 'with the className that lifts it over the dialog layer', s);
    check(s.hit === 'picker', 'and a hit test at its centre really lands on the picker, not the dialog', { hit: s.hit });
    check(s.gifTabHidden === true, 'the GIF tab (which posts to chat) is not offered', s);
    check(!s.api.some((u) => u.includes('/api/gifs')), 'and no GIF request is made', s.api);
    check(s.activeId === 'pk-search', 'the desktop still hands the search field the caret', { activeId: s.activeId });

    console.log('\n[8] a pick lands at the field\'s caret and hands the caret back');
    const pick = await evaluate('__pickFirstTile()');
    check(!!pick.ch && pick.statusValue === pick.ch, 'the emoji is inserted into the status field', { ch: pick.ch, value: pick.statusValue });
    check(pick.open === false, 'the picker closes on the pick');
    check(pick.activeId === 'm-status-text', 'and the caret comes back to the field it belongs to', { activeId: pick.activeId });
    check(pick.draftCalls === 0, 'a profile field is never filed as a chat draft', { draftCalls: pick.draftCalls });

    console.log('\n[9] a status is standard emoji only');
    await evaluate('__clickBtn("m-status-text")');
    const bad = await evaluate('__pickEmoji(":camp:")');
    check(bad.statusValue === pick.ch, 'a custom :name: is not inserted into a status', { value: bad.statusValue });
    check(bad.toasts.some((t) => /standard emoji only/.test(t)), 'and the refusal is said out loud', bad.toasts);
    check(bad.open === true, 'the picker stays up so another tile can be picked');
    const good = await evaluate('__pickEmoji("\u{1F525}")');
    check(good.statusValue === pick.ch + '\u{1F525}', 'a standard emoji still lands', { value: good.statusValue });
    await evaluate('__closeFieldPicker()');

    console.log('\n[10] clicking the same button again closes it (like the composer\'s own emoji key)');
    await evaluate('__clickBtn("m-status-text")');
    const tog = await evaluate('__clickBtn("m-status-text")');
    check(tog.open === false, 'the second click puts the picker away', tog);

    console.log('\n[11] the bio box: corner button, real input event, no draft');
    const gb = await evaluate('__fieldGeom("set-bio")');
    check(!!gb && gb.area === true && gb.inside, 'the bio button sits inside the textarea', gb);
    check(!!gb && gb.bottomGap >= 0 && gb.bottomGap < 16, 'in its bottom-right corner', gb);
    check(!!gb && gb.padRight >= gb.btnW + 4, 'with the textarea reserving room for it', gb);
    const bioPick = await (async () => {
      await evaluate('__clickBtn("set-bio")');
      return evaluate('__pickFirstTile()');
    })();
    check(!!bioPick.ch && bioPick.bioValue === bioPick.ch, 'an emoji lands in the bio', { value: bioPick.bioValue });
    check(bioPick.bioInputs >= 1, 'and fires a real input event (the counter keeps up)', { bioInputs: bioPick.bioInputs });
    check(bioPick.draftCalls === 0, 'and never reaches the draft store', { draftCalls: bioPick.draftCalls });

    console.log('\n[12] the settings backdrop is cleared too (it is a dialog as well)');
    let st = await evaluate('__clickBtn("set-bio")');
    st = await evaluate('__state()');
    check(st.open === true && st.mode === 'field', 'the settings bio field opens the picker', st);
    check(st.hit === 'picker', 'and it is on top of the settings dialog', { hit: st.hit });
    await evaluate('__closeFieldPicker()');

    console.log('\n[12b] the composer picker is untouched: its GIF tab is still there');
    const comp = await evaluate('(() => { closePicker(false); openPicker("insert", null, "emoji", null, null); return __state(); })()');
    check(comp.open === true && comp.mode === 'insert', 'the composer picker still opens in insert mode', comp);
    check(comp.gifTabHidden === false, 'and still offers the GIF tab', comp);
    check(comp.cls.includes('pk-over') === false, 'and is not carrying the dialog lift it does not need', comp);
    await evaluate('__closeFieldPicker()');
  });
}

async function phoneChecks() {
  await withChrome(async ({ device, evaluate }) => {
    await device(406, 911);
    console.log('\n[13] a phone gets the sheet, above the dialog, and it fits');
    let s = await evaluate('__clickBtn("m-status-text")');
    await evaluate('__settle()');
    s = await evaluate('__state()');
    check(s.open === true && s.mode === 'field', 'the field picker opens on a phone', s);
    check(s.cls.includes('pk-over'), 'with the dialog-lifting class', s);
    check(!!s.picker && Math.abs(s.picker.b - 911) <= 2, 'as a sheet pinned to the screen bottom', s.picker);
    check(inside(s.picker, 406, 911), 'fully on screen', s.picker);
    check(s.hit === 'picker', 'and the dialog behind it is not what a tap at its centre reaches', { hit: s.hit });
    const pick = await evaluate('__pickFirstTile()');
    check(!!pick.ch && pick.statusValue === pick.ch, 'a tile tap still lands in the field', { value: pick.statusValue });
    check(pick.open === false, 'and the sheet closes on the pick');
  });
}

(async () => {
  console.log('[test] emoji picker inside a profile field (status, bio)');
  staticChecks();
  await desktopChecks();
  await phoneChecks();
  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ' of ' + (passed + failures.length) : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
