// Group DM settings + the DM sidebar's mobile row menu (see AGENTS.md
// verification conventions).
//
// The requests:
//   - group DMs need settings (name + description) reachable from the row menu;
//   - a mobile long-press on a DM / group row must open the slide-up sheet, not
//     the desktop right-click popup;
//   - a long-press must never highlight the channel / DM name text;
//   - the server tag inside a DM sidebar row must not steal the tap into its
//     own server mini-panel (all platforms);
//   - removing someone from a group must be reachable from the member row's
//     right-click / long-press menu AND from the user card, both gated to the
//     group creator (groups are remove-only: no ban).
//
// Boots a real server against a throwaway database for the group settings API
// (name/description, membership + auth, 1:1 refusal, cap/trim, the
// dm-threads-changed push) and the member-remove route (creator-only, the
// removal push + system line), then slices the real client functions offline
// for the menu / card / tag / selection wiring. Skips (exit 0) when Postgres is
// down.
//
// Usage: node scripts/test-group-dm-settings.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_group_dm_test';
const PORT = parseInt(process.env.TEST_PORT || '3421', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

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

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: payload });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
  }
}
async function waitForHttp(p, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

// ---- offline slices of the real client code ----
function slice(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to);
  if (a < 0 || b < 0 || b <= a) return null;
  return src.slice(a, b);
}
function clientChecks() {
  const home = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
  const core = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
  const actions = fs.readFileSync(path.join(ROOT, 'public/js/actions.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const pick = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');

  console.log('\n[8] the row menu offers group settings (and only for groups)');
  const menuSrc = slice(home, 'function dmMenuItems(', '// Mobile long-press on a DM / group row');
  if (!menuSrc) { check(false, 'sliced dmMenuItems out of home.js'); return; }
  const S = { dms: [
    { id: 'g1', isGroup: true, pinned: false, members: [{}, {}] },
    { id: 'd1', isGroup: false, pinned: true, members: [{}] },
  ], me: { id: 'me' } };
  const dmMenuItems = new Function('S', menuSrc + '\nreturn dmMenuItems;')(S);
  const gl = dmMenuItems('g1').map((i) => i.label || '—');
  const dl = dmMenuItems('d1').map((i) => i.label || '—');
  check(gl.includes('Edit group chat'), 'a group row offers Edit group chat', gl);
  check(gl.includes('Add members…') && gl.includes('Leave chat'), 'and keeps add members / leave', gl);
  check(!dl.includes('Edit group chat') && dl.includes('Close DM'), 'a 1:1 row has no group settings, keeps Close DM', dl);
  check(gl[0] === 'Open' && dl[0] === 'Open', 'Open stays first in both', { gl: gl[0], dl: dl[0] });

  console.log('\n[9] the mobile long-press opens the sheet for DM rows');
  const holdSrc = slice(actions, 'const touch = e.touches[0];', 'if (ctxFor(t, x, y)) holdMenu = true;');
  check(!!holdSrc, 'found the long-press block in actions.js');
  check(/openDmSheet\(dmr\.dataset\.dmthread\)/.test(actions) && /dmr\s*&&\s*isCoarse\(\)/.test(actions),
    'a coarse-pointer DM/group hold opens openDmSheet (not the desktop popup)');
  check(/holdSheet = true; openDmSheet/.test(actions), 'and marks it as a sheet, so the lift-off click is swallowed');
  const sheetSrc = slice(home, 'function openDmSheet(', '// Group chat settings: name + description');
  check(!!sheetSrc && /openCtxSheet\(items, head\)/.test(sheetSrc), 'openDmSheet opens the slide-up sheet with the shared item list');

  console.log('\n[10] the server tag in a DM row is decorative');
  const tagSrc = slice(core, 'function tagHTML(', 'function avatarColorFor(');
  if (!tagSrc) { check(false, 'sliced tagHTML out of core.js'); return; }
  const tagHTML = new Function('activeTagFor', 'esc', tagSrc + '\nreturn tagHTML;')(() => 'TST', (s) => String(s == null ? '' : s));
  const live = tagHTML({ active_tag_server_id: 's1' });
  const plain = tagHTML({ active_tag_server_id: 's1' }, true);
  check(/data-tag-sid="s1"/.test(live) && /class="usertag clickable"/.test(live), 'a normal tag stays clickable', live);
  check(!/data-tag-sid/.test(plain) && !/clickable/.test(plain) && !/role="button"/.test(plain) && !/tabindex/.test(plain),
    'a plain tag has no click target at all', plain);
  check(/tagHTML\(av, true\)/.test(home), 'the DM sidebar row renders its peer tag as plain');

  console.log('\n[11] long-press cannot highlight the row text');
  check(/\.server-btn,\.chan,\.dmrow,\.member\{[^}]*user-select:none/.test(css),
    'sidebar rows opt out of text selection', (css.match(/\.server-btn,\.chan,\.dmrow,\.member\{[^}]*\}/) || [''])[0]);
  check(/\.server-btn,\.chan,\.dmrow,\.member\{[^}]*touch-callout:none/.test(css), 'and keep the callout suppression');

  console.log('\n[12] group removal: the row menu and the user card share one rule');
  const predSrc = slice(actions, 'function canRemoveGroupMember(', 'function modGroupItems(');
  const tabSrc = slice(pick, 'function groupRemoveTabHTML(', '// ---------- user card ----------');
  check(!!predSrc && !!tabSrc, 'sliced canRemoveGroupMember (actions.js) + groupRemoveTabHTML (pickers.js)');
  if (predSrc && tabSrc) {
    const tabs = [];
    const ucTab = (id, icon, label, mod = '') => { tabs.push({ id, icon, label, mod }); return `<button class="uc-tab${mod}" id="${id}"><svg data-i="${icon}"></svg><span>${label}</span></button>`; };
    const MS = { me: { id: 'me' } };
    const { canRemoveGroupMember, groupRemoveTabHTML } = new Function('S', 'ucTabHTML',
      predSrc + '\n' + tabSrc + '\nreturn { canRemoveGroupMember, groupRemoveTabHTML };')(MS, ucTab);
    const group = { id: 'g1', isGroup: true, created_by: 'me' };
    const tab = groupRemoveTabHTML(group, 'bob');
    check(/id="uc-remove"/.test(tab) && /class="uc-tab danger"/.test(tab) && />Remove</.test(tab),
      'the group creator gets a danger Remove tab on a member card', tab);
    check(tabs.length && tabs[0].icon === 'x-user', 'with the x-user icon', tabs[0]);
    check(groupRemoveTabHTML(group, 'me') === '', 'never on your own card');
    check(groupRemoveTabHTML({ id: 'd1', isGroup: false, created_by: 'me' }, 'bob') === '', 'never in a 1:1 DM');
    check(groupRemoveTabHTML(null, 'bob') === '', 'and never with no thread to remove from');
    MS.me.id = 'bob';
    check(groupRemoveTabHTML(group, 'carol') === '', 'a non-creator member gets no Remove tab', groupRemoveTabHTML(group, 'carol'));
    check(canRemoveGroupMember(group, 'carol') === false, 'the predicate says the same');
    MS.me.id = 'me';
    check(canRemoveGroupMember(group, 'bob') === true, 'and clears the creator for a real member');
    check(/canRemoveGroupMember\(t, u && u\.id\)/.test(actions),
      'the row-menu item goes through the same predicate (no drifting rule)');
    check(/ucTabHTML\('uc-remove', 'x-user', 'Remove', ' danger'\)/.test(tabSrc),
      'the tab is a real danger tab row');
    const tabsLine = (/<div class="uc-tabs">[\s\S]*?<\/div>/.exec(pick) || [''])[0];
    check(/groupRemoveTabHTML\(dmThread, uid\)/.test(tabsLine),
      'and the card renders it in its action list (next to Kick/Ban)', tabsLine.slice(0, 200));
    check(/S\.view === 'home' \? \(S\.dms \|\| \[\]\)\.find\(\(t\) => t\.id === S\.dmThreadId\)/.test(pick),
      'and only looks the group up in home view');
    check(/const rmv = \$\('#uc-remove'\);\s*if \(rmv\) rmv\.onclick = \(\) => \{ closeUserCard\(\); modGroupMember\(dmThread, u\); \};/.test(pick),
      'the tab closes the card and calls the same modGroupMember the menu does');
  }
}

async function main() {
  // Offline wiring checks run first — they need no database.
  clientChecks();

  const envFile = readEnvFile();
  const pg = {
    host: process.env.PGHOST || envFile.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || envFile.POSTGRES_USER || 'campfire',
    password: process.env.PGPASSWORD || envFile.POSTGRES_PASSWORD || '',
  };
  const admin = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
  try { await admin.connect(); }
  catch (e) {
    console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
    if (failures.length) process.exit(1);
    return skip('Postgres unreachable (' + ((e && e.message) || e) + ') — the API half was skipped');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gdm-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  let child = null;
  const conns = [];
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
        JWT_SECRET: 'test-group-dm-secret',
        UPLOAD_DIR: uploads,
        UNFURL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const fail = (msg) => { throw new Error(msg + '\n--- server log ---\n' + serverLog.slice(-4000)); };
    if (!(await waitForHttp('/api/config', 30000))) return fail('server did not come up');

    console.log('\n[1] accounts + one group chat (A, B members; C a stranger)');
    const reg = async (n) => {
      const r = await api('POST', '/api/register', { body: { username: n, displayName: n.toUpperCase(), password: 'passw0rd!x' } });
      if (!(r.status === 200 && r.data.token)) throw new Error('register ' + n + ' failed: ' + JSON.stringify(r.data));
      return r.data;
    };
    const A = await reg('gdma'), B = await reg('gdmb'), C = await reg('gdmc');
    const meId = async (t) => (await api('GET', '/api/me', { token: t })).data.user.id;
    const idA = await meId(A.token), idB = await meId(B.token), idC = await meId(C.token);
    const f1 = await api('POST', '/api/friends', { token: A.token, body: { username: 'gdmb' } });
    const f2 = await api('POST', `/api/friends/${idA}/accept`, { token: B.token });
    check(f1.status === 200 && f2.status === 200, 'A and B are friends', { f1: f1.status, f2: f2.status });

    let r = await api('POST', '/api/dms/group', { token: A.token, body: { name: 'Original name', userIds: [idB] } });
    const gid = r.data.thread && r.data.thread.id;
    check(r.status === 200 && !!gid, 'group created', r.data);
    check(r.data.thread && r.data.thread.description === '', 'a fresh group has an empty description', r.data.thread);

    console.log('\n[2] a member renames and describes the group');
    r = await api('PATCH', `/api/dms/${gid}`, { token: A.token, body: { name: 'Weekend squad', description: 'Saturday plans' } });
    check(r.status === 200 && r.data.thread.name === 'Weekend squad' && r.data.thread.description === 'Saturday plans', 'PATCH saves both fields', r.data);

    r = await api('GET', '/api/dms', { token: B.token });
    const seen = (r.data.threads || []).find((t) => t.id === gid);
    check(!!seen && seen.name === 'Weekend squad' && seen.description === 'Saturday plans', 'the other member sees both on their next fetch', seen && { name: seen.name, description: seen.description });

    console.log('\n[3] validation + access');
    r = await api('PATCH', `/api/dms/${gid}`, { token: C.token, body: { name: 'hijack' } });
    check(r.status === 404 && r.data.error === 'no_thread', 'a non-member cannot edit it', { status: r.status, error: r.data && r.data.error });
    r = await api('PATCH', `/api/dms/${gid}`, { token: A.token, body: {} });
    check(r.status === 400 && r.data.error === 'nothing_to_update', 'an empty body is rejected', { status: r.status, error: r.data && r.data.error });
    r = await api('PATCH', `/api/dms/${gid}`, { body: { name: 'x' } });
    check(r.status === 401, 'auth is required', r.status);

    r = await api('PATCH', `/api/dms/${gid}`, { token: A.token, body: { name: '   ' } });
    check(r.status === 200 && r.data.thread.name === 'Group chat', 'a blank name falls back to "Group chat"', r.data.thread && r.data.thread.name);
    r = await api('PATCH', `/api/dms/${gid}`, { token: A.token, body: { name: 'n'.repeat(80), description: '  padded  ' } });
    check(r.data.thread.name.length === 40, 'the name is capped at 40', r.data.thread.name.length);
    check(r.data.thread.description === 'padded', 'the description is trimmed', JSON.stringify(r.data.thread.description));
    r = await api('PATCH', `/api/dms/${gid}`, { token: A.token, body: { description: 'd'.repeat(500) } });
    check(r.data.thread.description.length === 300, 'and capped at 300', r.data.thread.description.length);
    r = await api('PATCH', `/api/dms/${gid}`, { token: A.token, body: { description: 'one\n\n\n\ntwo' } });
    check(r.data.thread.description === 'one\n\ntwo', 'blank-line spam is squashed', JSON.stringify(r.data.thread.description));

    console.log('\n[4] a 1:1 DM has no settings');
    r = await api('POST', '/api/dms', { token: A.token, body: { userId: idB } });
    // A and B already share a group, so this creates the 1:1 as well.
    const oneId = r.data.thread && r.data.thread.id;
    check(!!oneId, 'the 1:1 DM exists', r.data);
    r = await api('PATCH', `/api/dms/${oneId}`, { token: A.token, body: { name: 'nope' } });
    check(r.status === 400 && r.data.error === 'not_group', 'editing a 1:1 DM is refused', { status: r.status, error: r.data && r.data.error });

    console.log('\n[5] the change is pushed to the other member live');
    const bsock = await new Promise((resolve, reject) => {
      const events = [];
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(B.token)}`);
      ws.on('error', reject);
      ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'subscribe' })); resolve({ events, close: () => { try { ws.close(); } catch {} } }); });
    });
    conns.push(bsock);
    await sleep(400);
    await api('PATCH', `/api/dms/${gid}`, { token: A.token, body: { name: 'Renamed live' } });
    const pushed = await waitFor(() => bsock.events.some((e) => e.t === 'dm-threads-changed'), 5000);
    check(!!pushed, 'B receives dm-threads-changed', bsock.events.map((e) => e.t));

    console.log('\n[6] the creator removes a member (row menu + card action)');
    r = await api('POST', `/api/dms/${gid}/members/${idB}/remove`, { body: {} });
    check(r.status === 401, 'auth is required', r.status);
    r = await api('POST', `/api/dms/${gid}/members/${idB}/remove`, { token: B.token });
    check(r.status === 403 && r.data.error === 'creator_only', 'a non-creator member cannot remove anyone', { status: r.status, error: r.data && r.data.error });
    r = await api('POST', `/api/dms/${gid}/members/${idA}/remove`, { token: A.token });
    check(r.status === 400 && r.data.error === 'cannot_remove', 'the creator cannot remove themselves', { status: r.status, error: r.data && r.data.error });
    r = await api('POST', `/api/dms/${gid}/members/${idC}/remove`, { token: A.token });
    check(r.status === 404 && r.data.error === 'not_member', 'a stranger is not a member to remove', { status: r.status, error: r.data && r.data.error });
    r = await api('POST', `/api/dms/${oneId}/members/${idB}/remove`, { token: A.token });
    check(r.status === 400 && r.data.error === 'not_group', 'a 1:1 DM has nobody to remove', { status: r.status, error: r.data && r.data.error });

    r = await api('POST', `/api/dms/${gid}/members/${idB}/remove`, { token: A.token });
    check(r.status === 200, 'the creator removes a member', { status: r.status, error: r.data && r.data.error });
    const told = await waitFor(() => bsock.events.find((e) => e.t === 'removed-from-dm'), 5000);
    check(!!told && told.threadId === gid, 'the removed member is told live (removed-from-dm)', bsock.events.map((e) => e.t));
    r = await api('GET', '/api/dms', { token: B.token });
    check(!(r.data.threads || []).some((t) => t.id === gid), 'the group is gone from their list');
    r = await api('GET', `/api/dms/${gid}/messages?limit=5`, { token: A.token });
    check((r.data.messages || []).some((m) => /was removed/.test(m.content || '')), 'a system line records it in the chat', (r.data.messages || []).map((m) => m.content).slice(-3));
    r = await api('POST', `/api/dms/${gid}/members/${idB}/remove`, { token: A.token });
    check(r.status === 404 && r.data.error === 'not_member', 'removing them twice is a 404', { status: r.status, error: r.data && r.data.error });
  } catch (e) {
    console.error('[test] ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    try { child && child.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')' : 'all ' + passed + ' checks passed'));
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('[test] ' + (e && e.stack || e)); process.exit(1); });
