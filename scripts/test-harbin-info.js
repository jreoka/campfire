// "Harbin info": the attachment rows in the message menu, and the panel behind
// them.
//
// The chat card can only ever say a file was blocked; the REASON lives in the
// scan record, and this is the only surface that shows it. So this drives the
// real page in headless Chrome against a real server (skips without Chrome or
// Postgres) and pins the whole path end to end:
//
//   - an attachment has no menu of its own any more: right-clicking a rendering
//     that carries an attachment identity — a picture, an audio player, a file
//     card, and the card that stands in for a file the scanner removed — opens
//     the MESSAGE's menu with that file's rows in it, "Harbin info" among them,
//     and a message with no media at all grows none of them;
//   - picking it fetches the stored verdict and paints the panel: the verdict
//     and score, the engine that made it, when it ran, and the findings;
//   - the panel is read-only: one way out, not two;
//   - a long-press on a touch device gets the same item in the phone's sheet.
//
// The engine is the stand-in (scripts/fake-harbin.js) so this needs no Rust
// toolchain: it refuses a file whose BYTES carry the malware marker, which is
// what makes "a renamed file is still caught" testable.
//
// Usage: node scripts/test-harbin-info.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_test_harbininfo';
const PORT = parseInt(process.env.TEST_PORT || '3431', 10);
const CDP_PORT = parseInt(process.env.TEST_CDP_PORT || '9431', 10);

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

// A file whose NAME is innocent and whose BYTES are the marker the stand-in
// engine refuses (see fake-harbin.js): the pipeline decides on content.
const MARKER = 'FAKE-HARBIN-MALWARE-MARKER';
// The middle band the stand-in has too: flagged, but under the block level.
const SUSPECT_MARKER = 'FAKE-HARBIN-SUSPECT-MARKER';

async function main() {
  const chromePath = findChrome();
  if (!chromePath) return skip('no Chrome/Edge found (set CHROME_PATH)');

  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) { return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — docker compose up -d db'); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-hbinfo-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null, chrome = null, ws = null;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PGHOST: pg.host, PGPORT: String(pg.port), PGUSER: pg.user, PGPASSWORD: pg.password, PGDATABASE: TEST_DB,
        JWT_SECRET: 'test-harbin-info-secret',
        UPLOAD_DIR: uploads,
        VIRUS_SCAN: '1',
        MEDIA_COMPRESS: '0', // the pipeline is not what this test is about
        BUCKET_SCAN_FIRST_MS: '3600000',
        UNFURL: '0',
        HARBIN_BIN: path.join(__dirname, 'fake-harbin.js'),
        FAKE_HARBIN_DELAY_MS: '250',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-3000)); };
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch {}
      if (!up) await sleep(250);
    }
    if (!up) return fail('server did not come up');

    // ---- Chrome + CDP ----
    const profile = path.join(tmp, 'chrome');
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1200,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) return fail('Chrome did not expose the DevTools port');

    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await evaluate(`(() => { try { return ${expr} } catch (e) { return false } })()`); if (v) return v; } catch {}
        if (Date.now() - t0 > ms) return null;
        await sleep(200);
      }
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`location.href = 'http://127.0.0.1:${PORT}/'`);
    if (!(await waitFor(`typeof boot === 'function'`))) return fail('the app never loaded');

    console.log('\n[1] sign in, make a server, post an attachment of each shape');
    await evaluate(`(async () => {
      const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'hbinfo', displayName: 'HB Info', password: 'passw0rd!x' }) });
      const d = await r.json();
      store.token = d.token; store.sid = d.sid;
    })()`);
    await send('Page.reload');
    if (!(await waitFor(`S.me && S.me.username === 'hbinfo'`))) return fail('never booted signed in');
    const srv = await evaluate(`(async () => {
      const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'Info Lab' }) });
      await refreshServers(r.server.id);
      if (S.ws) S.ws.send(JSON.stringify({ t: 'subscribe' }));
      await selectServer(r.server.id);
      return { sid: r.server.id, cid: S.channelId };
    })()`);
    if (!srv || !srv.cid) return fail('no channel open');

    // Upload + post from inside the page, then wait for the verdict to land.
    const postFile = async (name, mime, body) => {
      const res = await evaluate(`(async () => {
        const fd = new FormData();
        fd.append('file', new Blob([${JSON.stringify(body)}], { type: ${JSON.stringify(mime)} }), ${JSON.stringify(name)});
        const up = await (await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + store.token }, body: fd })).json();
        S.ws.send(JSON.stringify({ t: 'message', serverId: S.serverId, channelId: S.channelId, content: '',
          attachments: [{ url: up.url, name: up.name, mime: up.mime, size: up.size, kind: up.kind }] }));
        return up;
      })()`);
      const settled = await waitFor(`(() => {
        const m = (S.messages.get(S.channelId) || []).find((x) => (x.attachments || []).some((a) => a.url === ${JSON.stringify(res.url)}));
        if (!m) return false;
        const a = m.attachments.find((x) => x.url === ${JSON.stringify(res.url)});
        return (a.scan === 'clean' || a.scan === 'infected') ? a.scan : false;
      })()`, 30000);
      if (!settled) fail('the upload for ' + name + ' never settled');
      return { up: res, scan: settled };
    };

    const clean = await postFile('holiday-notes.txt', 'text/plain', 'a harmless text file, nothing to see\n');
    check(clean.scan === 'clean', 'a benign file is judged clean', clean.scan);
    const cleanImg = await postFile('holiday.png', 'image/png', 'not really a png, but a picture by name\n');
    check(cleanImg.scan === 'clean', 'and so is an image (its own menu shape)', cleanImg.scan);
    // A binary that is neither media nor previewable text: the plain file card.
    const cleanZip = await postFile('holiday-archive.zip', 'application/zip', 'PK\u0003\u0004 not a real archive\n');
    check(cleanZip.scan === 'clean', 'and so is a plain file', cleanZip.scan);
    const bad = await postFile('holiday-photo-2019.txt', 'text/plain', 'innocent looking\n' + MARKER + '\nmore innocent looking text\n');
    check(bad.scan === 'infected', 'a file whose BYTES are flagged is blocked, whatever it is called', bad.scan);
    // Harbin's MIDDLE band: above its suspicious threshold, below the level this
    // server blocks. That file is served — and served silently was the wrong
    // half of the trade, so the message has to say so.
    const sus = await postFile('maybe-not-fine.txt', 'text/plain', 'looks harmless\n' + SUSPECT_MARKER + '\n');
    check(sus.scan === 'clean', 'a file in the suspicious band is SERVED, not gated', sus.scan);

    const attFor = async (url) => waitFor(`(() => {
      const m = (S.messages.get(S.channelId) || []).find((x) => (x.attachments || []).some((a) => a.url === ${JSON.stringify(url)}));
      const a = m && m.attachments.find((x) => x.url === ${JSON.stringify(url)});
      return a || false;
    })()`, 15000);

    console.log('\n[2] a suspicious file warns on the message itself');
    const susAtt = await attFor(sus.up.url);
    check(!!susAtt && susAtt.scanVerdict === 'suspicious', 'the message is told which band it landed in', susAtt);
    check(!!susAtt && susAtt.scan === 'clean', '...and that it is servable', susAtt && susAtt.scan);
    check(!!susAtt && !('scanVerdict' in (await attFor(clean.up.url) || {})), 'a clean file is told nothing of the sort');
    const warnEl = await evaluate(`(() => {
      const all = [...document.querySelectorAll('.att-warn')];
      const el = all[0];
      return { count: all.length, text: el ? el.textContent.trim() : '', id: el ? el.dataset.attId : '', icon: el ? !!el.querySelector('svg') : false,
        isButton: el ? el.tagName === 'BUTTON' : false };
    })()`);
    check(warnEl.count === 1, 'exactly one attachment carries the marker', warnEl);
    check(/Potentially malicious/.test(warnEl.text), 'and it says what it is', warnEl.text);
    check(warnEl.icon && warnEl.isButton, 'with a warning glyph on a real button (no emoji, keyboard-reachable)', warnEl);
    check(warnEl.id === (susAtt && susAtt.id), 'bound to its OWN attachment', warnEl.id);
    // Served, not blocked — the whole point of the band, and of warning about it.
    const susKey = sus.up.url.split('?')[0].replace('/uploads/', '');
    check(fs.existsSync(path.join(uploads, susKey)), 'the suspicious bytes are still on disk');
    check((await fetch(`http://127.0.0.1:${PORT}${sus.up.url}`)).status === 200, 'and the file is still servable');

    await evaluate(`(() => { document.querySelector('.att-warn').click(); return true; })()`);
    const susPanel = await waitFor(`(() => { const v = document.querySelector('#modal-body .hb-v'); return v ? v.textContent : false; })()`, 10000);
    check(/^Suspicious/.test(susPanel || ''), 'the marker opens the panel, reading the band', susPanel);
    check(/score 0\.\d{4}/.test(susPanel || ''), 'with the score behind it', susPanel);
    const susNote = await evaluate(`(() => { const n = document.querySelector('#modal-body .hb-note'); return n ? n.textContent : ''; })()`);
    check(/served/i.test(susNote), 'and why a flagged file was served at all', susNote);
    await evaluate(`(() => { document.querySelector('#modal-ok').click(); return true; })()`);
    await sleep(250);

    console.log('\n[3] the attachment rows are part of the message menu — and only for media');
    const menuFor = async (selector) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { missing: true };
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 240 }));
      const m = document.querySelector('#ctx-menu');
      return { open: !!m, labels: m ? [...m.querySelectorAll('.ctx-item span:last-child')].map((s) => s.textContent) : [] };
    })()`);
    const closeMenu = () => evaluate(`(() => { const b = document.querySelector('#ctx-menu'); if (b) b.remove(); return true; })()`);

    const zipMenu = await menuFor('.file-card[data-att-id]');
    check(zipMenu.open && zipMenu.labels.includes('Harbin info'), 'a plain file card offers it', zipMenu.labels);
    check(zipMenu.labels.includes('Copy text') && zipMenu.labels.includes('Bookmark message'),
      'from the message menu it now rides in', zipMenu.labels);
    await closeMenu();

    const txtMenu = await menuFor('.txtfile[data-att-id]');
    check(txtMenu.open && txtMenu.labels.includes('Harbin info'), 'a text preview offers it', txtMenu.labels);
    await closeMenu();

    const imgMenu = await menuFor('img.att-img[data-att-id], .att-wrap[data-att-id]');
    check(imgMenu.open && imgMenu.labels.includes('Harbin info'), 'a picture offers it (beside copy/save)', imgMenu.labels);
    check(imgMenu.labels.includes('Copy image') && imgMenu.labels.includes('Mark unread'),
      'with the picture\'s rows and the message\'s in ONE menu', imgMenu.labels);
    await closeMenu();

    const blockedMenu = await menuFor('.scan-block.infected[data-att-id]');
    check(blockedMenu.open && blockedMenu.labels.includes('Harbin info'), 'the card standing in for a removed file offers it', blockedMenu.labels);
    check(!blockedMenu.labels.some((l) => /^(?:Save |Copy link$|Copy (?:image|video) link|Open (?:image|video) link)/.test(l)),
      'and offers nothing that could not work — the bytes are gone', blockedMenu.labels);
    await closeMenu();

    // The message's own pixels (not the file card) open the same menu, with the
    // attachment's rows in it — that is the whole point of the merge.
    const msgMenu = await evaluate(`(() => {
      const msg = document.querySelector('.scan-block.infected[data-att-id]').closest('.msg[data-mid]');
      const r = msg.getBoundingClientRect();
      msg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + 4) }));
      const m = document.querySelector('#ctx-menu');
      return { open: !!m, labels: m ? [...m.querySelectorAll('.ctx-item span:last-child')].map((s) => s.textContent) : [] };
    })()`);
    check(msgMenu.open && msgMenu.labels.includes('Harbin info') && msgMenu.labels.includes('Copy text'),
      'a click on the message body gets the message menu, its attachment\'s rows in it', msgMenu.labels);
    await closeMenu();

    // ...and a message with NO attachment grows none of it: the rows are about
    // the media, not about messages.
    await evaluate(`(() => {
      S.ws.send(JSON.stringify({ t: 'message', serverId: S.serverId, channelId: S.channelId, content: 'nothing attached here' }));
      return true;
    })()`);
    const plainReady = await waitFor(`[...document.querySelectorAll('.msg[data-mid]')].some((m) => (m.textContent || '').includes('nothing attached here'))`, 15000);
    check(!!plainReady, 'a text-only message renders');
    const plainMenu = await evaluate(`(() => {
      const msg = [...document.querySelectorAll('.msg[data-mid]')].find((m) => (m.textContent || '').includes('nothing attached here'));
      msg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 240 }));
      const m = document.querySelector('#ctx-menu');
      return { open: !!m, labels: m ? [...m.querySelectorAll('.ctx-item span:last-child')].map((s) => s.textContent) : [] };
    })()`);
    check(plainMenu.open && plainMenu.labels.includes('Copy text'), 'its menu opens as usual', plainMenu.labels);
    check(!plainMenu.labels.some((l) => /Harbin info|Save |Copy image|Copy link|Open image/.test(l)),
      'with no attachment rows at all', plainMenu.labels);
    await closeMenu();

    console.log('\n[4] the panel shows the stored verdict, not a fresh guess');
    const openPanel = async (selector) => {
      await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 240 }));
        const m = document.querySelector('#ctx-menu');
        const b = [...m.querySelectorAll('.ctx-item')].find((x) => /Harbin info/.test(x.textContent));
        b.click();
      })()`);
      const ok = await waitFor(`(() => { const t = document.querySelector('#modal-title'); return t && t.textContent === 'Harbin info' && document.querySelector('#modal-body .hb-head'); })()`, 15000);
      if (!ok) return null;
      return evaluate(`(() => {
        const b = document.querySelector('#modal-body');
        const closeBtn = document.querySelector('#modal-close');
        return {
          text: b.innerText,
          verdict: (b.querySelector('.hb-v') || {}).textContent || '',
          tone: (b.querySelector('.hb-v') || {}).className || '',
          findings: [...b.querySelectorAll('.hb-find li')].map((li) => li.textContent),
          rows: [...b.querySelectorAll('.hb-row')].map((r) => r.innerText.replace(/\\n/g, ': ')),
          cancelButtons: [...document.querySelectorAll('#modal-backdrop button')].filter((x) => getComputedStyle(x).display !== 'none').length,
          closeHidden: getComputedStyle(closeBtn).display === 'none',
        };
      })()`);
    };

    // The blocked file's own card is the entry point (its bytes are gone).
    const blockedPanel = await openPanel('.scan-block.infected[data-att-id]');
    check(!!blockedPanel, 'the panel opens from the blocked card');
    if (blockedPanel) {
      check(/Malware detected/.test(blockedPanel.verdict), 'it names the verdict', blockedPanel.verdict);
      check(/score 0\.\d{4}/.test(blockedPanel.verdict), 'with the score the engine gave', blockedPanel.verdict);
      check(blockedPanel.tone.includes('bad'), 'tone matches the verdict', blockedPanel.tone);
      check(blockedPanel.findings.length >= 1, 'it lists the findings the verdict was based on', blockedPanel.findings);
      check(/removed|no longer/i.test(blockedPanel.text), 'and says the file was removed', blockedPanel.text.slice(0, 200));
      check(blockedPanel.text.includes('files/'), 'it names the stored object the verdict hangs off', blockedPanel.rows);
      check(!/not a stored upload/.test(blockedPanel.text), 'and never says the file is not a stored upload', blockedPanel.rows);
      check(!/trees|features/.test(blockedPanel.text), 'the panel carries no model trivia', blockedPanel.rows);
      check(blockedPanel.closeHidden && blockedPanel.cancelButtons === 1, 'the panel is read-only: one way out', { buttons: blockedPanel.cancelButtons });
    }
    await evaluate(`(() => { document.querySelector('#modal-ok').click(); return true; })()`);
    await sleep(200);

    const cleanPanel = await openPanel('.file-card[data-att-id]');
    check(!!cleanPanel, 'the panel opens from a plain file card too');
    if (cleanPanel) {
      check(/^Clean/.test(cleanPanel.verdict), 'a clean file reads as clean', cleanPanel.verdict);
      check(cleanPanel.tone.includes('ok'), 'with the clean tone', cleanPanel.tone);
      check(cleanPanel.closeHidden && cleanPanel.cancelButtons === 1, 'and it is read-only as well', { buttons: cleanPanel.cancelButtons });
      // A local upload must name its key. This is the check that would have
      // caught the response dropping `key` while the panel rendered it.
      check(/\bfiles\/[0-9a-f]{16,}\./.test(cleanPanel.text), 'it names the storage key', cleanPanel.rows);
      check(!/not a stored upload/.test(cleanPanel.text), 'and does not claim a local upload is not stored', cleanPanel.rows);
    }
    await evaluate(`(() => { document.querySelector('#modal-ok').click(); return true; })()`);
    await sleep(200);

    console.log('\n[5] a long-press on a touch device gets the same item in the sheet');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(300);
    check(await evaluate(`matchMedia('(pointer:coarse)').matches`), 'the page now sees a coarse pointer');
    const sheet = await evaluate(`(async () => {
      const el = document.querySelector('.scan-block.infected[data-att-id]');
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const t = (type) => new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
        targetTouches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
        changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })] });
      el.dispatchEvent(t('touchstart'));
      await new Promise((res) => setTimeout(res, 800));
      el.dispatchEvent(t('touchend'));
      const sh = document.querySelector('#sheet');
      return sh ? [...sh.querySelectorAll('.sheet-item, button')].map((b) => b.textContent.trim()).filter(Boolean) : null;
    })()`);
    check(!!sheet, 'the long-press opens the phone sheet', sheet);
    check(!!sheet && sheet.some((l) => /Harbin info/.test(l)), 'and it carries the same item', sheet);
    check(!!sheet && sheet.some((l) => /Copy text/.test(l)),
      'in the message sheet the hold opened — the attachment has no sheet of its own', sheet);
    await evaluate(`(() => { const b = document.querySelector('#sheet-backdrop'); if (b) b.click(); return true; })()`);

    check(pageErrors.length === 0, 'no uncaught page errors through the whole run', pageErrors.slice(0, 3));
  } catch (e) {
    console.error('\n[test] FAILED:', (e && e.stack) || e);
    failures.push('exception: ' + ((e && e.message) || e));
  } finally {
    try { if (ws) ws.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try {
      const drop = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await drop.end();
    } catch {}
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('Harbin info: OK');
}

main().catch((e) => { console.error('[test] FAILED:', (e && e.stack) || e); process.exit(1); });
