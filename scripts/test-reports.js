// Message reports (see AGENTS.md verification conventions).
//
// The feature: any member can Report a message from the right-click / long-press
// menu; the report keeps a snapshot so admins can still review it after the
// author deletes the message; site admins get a live push + an inbox entry and
// work the queue in Admin → Reports (dismiss / delete / disable / ban).
//
// This boots a real server against a throwaway database and asserts the whole
// loop: who may report (members only, never your own message, once while open),
// the snapshot, admin-only access, search + counts, the live 'report-new' and
// 'report-updated' pushes, dismissing closing every open report about the same
// message, re-reporting after a decision, the delete action, DM reports, and
// the ban / disable actions.
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when it isn't.
//
// Usage: node scripts/test-reports.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_reports_test';
const PORT = parseInt(process.env.TEST_PORT || '3414', 10);

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

// Sockets open one at a time so each push can be attributed to its cause.
let nextStart = 0;
async function connectWs(token) {
  const wait = nextStart - Date.now();
  if (wait > 0) await sleep(wait);
  nextStart = Date.now() + 300;
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    ws.on('error', reject);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => resolve({
      events,
      send: (obj) => ws.send(JSON.stringify(obj)),
      of: (t) => events.filter((e) => e.t === t),
      last: (t) => [...events].reverse().find((e) => e.t === t) || null,
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
  }
}
// Like waitFor(), but for pollers that await: `fn` returns a promise, which is
// always truthy, so the sync version would return the pending promise instead
// of polling.
async function waitForAsync(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
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

async function main() {
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-reports-'));
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
        JWT_SECRET: 'test-reports-secret',
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

    console.log('\n[1] accounts + one server');
    const adm = await api('POST', '/api/register', { body: { username: 'jreoka', displayName: 'Admin', password: 'passw0rd!x' } });
    const aRes = await api('POST', '/api/register', { body: { username: 'bruce', displayName: 'Bruce', password: 'passw0rd!x' } });
    const bRes = await api('POST', '/api/register', { body: { username: 'alice', displayName: 'Alice', password: 'passw0rd!x' } });
    const cRes = await api('POST', '/api/register', { body: { username: 'cara', displayName: 'Cara', password: 'passw0rd!x' } });
    const dRes = await api('POST', '/api/register', { body: { username: 'dino', displayName: 'Dino', password: 'passw0rd!x' } });
    const eRes = await api('POST', '/api/register', { body: { username: 'erin', displayName: 'Erin', password: 'passw0rd!x' } });
    check([adm, aRes, bRes, cRes, dRes, eRes].every((r) => r.status === 200 && r.data.token), 'registered six accounts');
    const tAdmin = adm.data.token, tA = aRes.data.token, tB = bRes.data.token, tC = cRes.data.token, tD = dRes.data.token, tE = eRes.data.token;

    // Owner username is auto-admin; everyone else is not.
    check((await api('GET', '/api/admin/reports', { token: tA })).status === 403, 'non-admins cannot read the report queue');

    const srv = await api('POST', '/api/servers', { token: tA, body: { name: 'Report Lab' } });
    check(srv.status === 200 && !!srv.data.invite?.code, 'author creates a server', srv.data);
    const sid = srv.data.server.id;
    const channelId = srv.data.server.channels.find((c) => c.type === 'text').id;
    for (const t of [tB, tC, tD, tE]) {
      const j = await api('POST', '/api/servers/join', { token: t, body: { inviteCode: srv.data.invite.code } });
      check(j.status === 200, 'member joins the server');
    }

    console.log('\n[2] report validation');
    const aWs = await connectWs(tA); conns.push(aWs);          // author
    const admWs = await connectWs(tAdmin); conns.push(admWs);   // site admin
    await waitFor(() => aWs.last('hello'), 5000);
    check(!!(await waitFor(() => admWs.last('hello'), 5000)), 'admin socket connected');
    aWs.send({ t: 'message', serverId: sid, channelId, content: 'Buy cheap crystals at spam.example', replyTo: null, threadRoot: null });
    const m1 = await waitForAsync(async () => {
      const r = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tB });
      return (r.data.messages || []).find((m) => m.content.includes('cheap crystals')) || null;
    }, 5000);
    check(!!m1, 'author posts a message');
    if (!m1) return fail('message never landed');

    const self = await api('POST', '/api/reports', { token: tA, body: { messageId: m1.id, kind: 'server', reason: 'spam' } });
    check(self.status === 400 && self.data.error === 'cannot_report_self', 'you cannot report your own message', self.data);

    const rep1 = await api('POST', '/api/reports', { token: tB, body: { messageId: m1.id, kind: 'server', reason: 'spam', details: 'Selling crystals in chat' } });
    check(rep1.status === 200 && !!rep1.data.id, 'a member reports the message', rep1.data);

    const dupe = await api('POST', '/api/reports', { token: tB, body: { messageId: m1.id, kind: 'server', reason: 'spam' } });
    check(dupe.status === 409 && dupe.data.error === 'already_reported', 'the same member cannot report it twice while open', dupe.data);

    const outsider = await api('POST', '/api/reports', { token: tAdmin, body: { messageId: 'nope', kind: 'server', reason: 'spam' } });
    check(outsider.status === 404, 'an unknown message is a 404', outsider.data);

    console.log('\n[3] the admin queue');
    const list = await api('GET', '/api/admin/reports?status=open', { token: tAdmin });
    const rep = list.data.reports?.[0];
    check(list.status === 200 && list.data.total === 1, 'the report shows up in the queue', { total: list.data.total });
    check(!!rep && rep.status === 'open' && rep.reason === 'spam' && rep.reasonLabel === 'Spam', 'reason + status survive the round trip', rep && { status: rep.status, reason: rep.reason });
    check(!!rep && rep.content.includes('cheap crystals'), 'the message text is in the report');
    check(!!rep && rep.author?.username === 'bruce' && rep.author.display_name === 'Bruce', 'the author is attached', rep && rep.author);
    check(!!rep && rep.reporter?.username === 'alice', 'the reporter is attached', rep && rep.reporter);
    check(!!rep && rep.snapshot?.where?.server?.name === 'Report Lab' && rep.snapshot?.where?.channel?.id === channelId, 'the snapshot records where it happened', rep && rep.snapshot?.where);
    check(!!rep && rep.details === 'Selling crystals in chat', 'the reporter note is kept', rep && rep.details);
    check(!!rep && rep.messageExists === true && rep.priorReports === 0, 'message still exists, no prior reports', rep && { exists: rep.messageExists, prior: rep.priorReports });
    check(list.data.counts.open === 1 && list.data.counts.resolved === 0 && list.data.counts.dismissed === 0, 'counts are reported', list.data.counts);

    const count = await api('GET', '/api/admin/reports/count', { token: tAdmin });
    check(count.data.open === 1, 'the badge count endpoint agrees', count.data);
    const stats = await api('GET', '/api/admin/stats', { token: tAdmin });
    check(stats.data.openReports === 1, 'Overview carries the open-report count', { openReports: stats.data.openReports });

    const searchHit = await api('GET', '/api/admin/reports?status=all&q=crystals', { token: tAdmin });
    check(searchHit.data.total === 1, 'search matches the message text', { total: searchHit.data.total });
    const searchReporter = await api('GET', '/api/admin/reports?status=all&q=alice', { token: tAdmin });
    check(searchReporter.data.total === 1, 'search matches the reporter', { total: searchReporter.data.total });
    const searchMiss = await api('GET', '/api/admin/reports?status=all&q=zzzznothing', { token: tAdmin });
    check(searchMiss.data.total === 0, 'search misses cleanly', { total: searchMiss.data.total });

    console.log('\n[4] admins are told live');
    // The admin socket was connected before the report: it must have been pushed.
    const pushed = await waitFor(() => admWs.last('report-new'), 5000);
    check(!!pushed && pushed.openReports === 1 && pushed.report?.author === 'Bruce', 'report-new pushed to the admin socket', pushed);
    // Non-admin sockets never see it.
    const bWs = await connectWs(tB); conns.push(bWs);
    await waitFor(() => bWs.last('hello'), 5000);
    const inbox = await api('GET', '/api/notifs/inbox', { token: tAdmin });
    const note = (inbox.data.items || []).find((n) => n.kind === 'report');
    check(!!note && note.report_id === rep1.data.id && note.title.includes('Spam'), 'the report lands in the admin inbox', note);
    check(bWs.of('report-new').length === 0, 'non-admins are never pushed report-new', bWs.of('report-new').length);
    const bInbox = await api('GET', '/api/notifs/inbox', { token: tB });
    check(!(bInbox.data.items || []).some((n) => n.kind === 'report'), 'the reporter does not get an inbox entry');

    console.log('\n[5] two reports, one decision');
    const rep2 = await api('POST', '/api/reports', { token: tC, body: { messageId: m1.id, kind: 'server', reason: 'harassment' } });
    check(rep2.status === 200, 'a second member reports the same message');
    const both = await api('GET', '/api/admin/reports?status=open', { token: tAdmin });
    check(both.data.total === 2 && both.data.reports[0].priorReports === 1, 'queue shows both, with a prior-report count', { total: both.data.total });

    const dis = await api('POST', `/api/admin/reports/${rep1.data.id}/resolve`, { token: tAdmin, body: { action: 'dismiss', note: 'looks fine' } });
    check(dis.status === 200 && dis.data.resolved === 2 && dis.data.openReports === 0, 'dismissing closes every open report on the message', dis.data);
    const afterDis = await api('GET', '/api/admin/reports?status=dismissed', { token: tAdmin });
    check(afterDis.data.total === 2, 'both rows are dismissed', { total: afterDis.data.total });
    check((afterDis.data.reports[0].resolved?.action) === 'dismiss' && afterDis.data.reports[0].resolved.note === 'looks fine', 'the outcome + note are stored', afterDis.data.reports[0].resolved);
    const pushedDown = await waitFor(() => admWs.of('report-updated').length ? [...admWs.of('report-updated')].pop() : null, 5000);
    check(!!pushedDown && pushedDown.openReports === 0, 'report-updated pushed with the new count', pushedDown);
    const inboxAfter = await api('GET', '/api/notifs/inbox', { token: tAdmin });
    check(!(inboxAfter.data.items || []).some((n) => n.kind === 'report'), 'worked reports leave the inbox');

    console.log('\n[6] re-report + delete action');
    const rep3 = await api('POST', '/api/reports', { token: tB, body: { messageId: m1.id, kind: 'server', reason: 'spam' } });
    check(rep3.status === 200, 'a member can report again after a decision', rep3.data);
    const del = await api('POST', `/api/admin/reports/${rep3.data.id}/resolve`, { token: tAdmin, body: { action: 'delete' } });
    check(del.status === 200 && del.data.messageDeleted === true, 'the delete action removes the message', del.data);
    const gone = await api('GET', '/api/messages/' + m1.id, { token: tAdmin });
    check(gone.status === 404, 'the message is really gone', gone.status);
    const delList = await api('GET', '/api/admin/reports?status=resolved', { token: tAdmin });
    const delRep = delList.data.reports.find((r) => r.id === rep3.data.id);
    check(!!delRep && delRep.status === 'resolved' && delRep.resolved.action === 'delete' && delRep.messageExists === false,
      'the report survives the message (snapshot still readable)', delRep && { status: delRep.status, action: delRep.resolved?.action, exists: delRep.messageExists });
    check(!!delRep && delRep.content.includes('cheap crystals'), 'the snapshot text is still there after deletion');

    console.log('\n[7] ban action (server report)');
    const dWs = await connectWs(tD); conns.push(dWs);
    await waitFor(() => dWs.last('hello'), 5000);
    dWs.send({ t: 'message', serverId: sid, channelId, content: 'go away everyone', replyTo: null, threadRoot: null });
    const hist2 = await waitForAsync(async () => {
      const r = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tB });
      const hit = (r.data.messages || []).find((m) => m.content.includes('go away'));
      return hit || null;
    }, 5000);
    if (!hist2) return fail('second message never landed');
    const rep4 = await api('POST', '/api/reports', { token: tC, body: { messageId: hist2.id, kind: 'server', reason: 'harassment' } });
    check(rep4.status === 200, 'third member reports the new message');
    const ban = await api('POST', `/api/admin/reports/${rep4.data.id}/resolve`, { token: tAdmin, body: { action: 'ban', note: 'bye' } });
    check(ban.status === 200, 'the ban action runs', ban.data);
    const dMember = await api('GET', `/api/servers/${sid}`, { token: tD });
    check(dMember.status === 403, 'the banned author is out of the server', dMember.status);
    const dRejoin = await api('POST', '/api/servers/join', { token: tD, body: { inviteCode: srv.data.invite.code } });
    check(dRejoin.status === 403 && dRejoin.data.error === 'banned', 'and cannot rejoin with an invite', dRejoin.data);
    const banRep = (await api('GET', '/api/admin/reports?status=resolved', { token: tAdmin })).data.reports.find((r) => r.id === rep4.data.id);
    check(!!banRep && banRep.resolved.action === 'ban' && banRep.resolved.note === 'bye', 'the ban outcome is recorded', banRep && banRep.resolved);

    console.log('\n[8] delete + disable action');
    const eWs = await connectWs(tE); conns.push(eWs);
    await waitFor(() => eWs.last('hello'), 5000);
    eWs.send({ t: 'message', serverId: sid, channelId, content: 'illegal things here', replyTo: null, threadRoot: null });
    const hist3 = await waitForAsync(async () => {
      const r = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tB });
      return (r.data.messages || []).find((m) => m.content.includes('illegal things')) || null;
    }, 5000);
    if (!hist3) return fail('third message never landed');
    const rep5 = await api('POST', '/api/reports', { token: tC, body: { messageId: hist3.id, kind: 'server', reason: 'illegal', details: 'this is not allowed' } });
    check(rep5.status === 200, 'an illegal-content report is accepted', rep5.data);
    const dd = await api('POST', `/api/admin/reports/${rep5.data.id}/resolve`, { token: tAdmin, body: { action: 'delete_disable', note: 'removed' } });
    check(dd.status === 200 && dd.data.messageDeleted === true, 'delete + disable removes the message', dd.data);
    const eGone = await api('GET', '/api/messages/' + hist3.id, { token: tAdmin });
    check(eGone.status === 404, 'the reported message is gone for everyone', eGone.status);
    const eLogin = await api('POST', '/api/login', { body: { username: 'erin', password: 'passw0rd!x' } });
    check(eLogin.status === 403 && eLogin.data.error === 'account_disabled', 'and the author is locked out', eLogin.data);
    const ddRep = (await api('GET', '/api/admin/reports?status=resolved', { token: tAdmin })).data.reports.find((r) => r.id === rep5.data.id);
    check(!!ddRep && ddRep.resolved.action === 'delete_disable' && ddRep.messageExists === false, 'the combined outcome is recorded', ddRep && ddRep.resolved);
    const illegalSearch = await api('GET', '/api/admin/reports?status=all&q=illegal%20content', { token: tAdmin });
    check(illegalSearch.data.total === 1 && illegalSearch.data.reports[0].reasonLabel === 'Illegal content', 'reason labels + search work for illegal content', { total: illegalSearch.data.total, label: illegalSearch.data.reports[0] && illegalSearch.data.reports[0].reasonLabel });

    console.log('\n[9] DM report + disable action');
    const dm = await api('POST', '/api/dms', { token: tB, body: { userId: aRes.data.user?.id } });
    let threadId = dm.data.thread?.id || dm.data.threadId;
    if (!threadId) {
      // Fall back to the thread list when the shape differs.
      const threads = await api('GET', '/api/dms', { token: tB });
      threadId = (threads.data.threads || []).find((t) => (t.members || []).some((u) => u.username === 'bruce'))?.id;
    }
    check(!!threadId, 'a DM thread opens', dm.data);
    aWs.send({ t: 'dm', threadId, content: 'nasty dm message', attachments: [], replyTo: null });
    const dmHist = await waitForAsync(async () => {
      const r = await api('GET', `/api/dms/${threadId}/messages`, { token: tB });
      const hit = (r.data.messages || []).find((m) => m.content.includes('nasty dm message'));
      return hit || null;
    }, 5000);
    if (!dmHist) return fail('DM message never landed');
    const dmRep = await api('POST', '/api/reports', { token: tB, body: { messageId: dmHist.id, kind: 'dm', reason: 'harassment', details: 'in DMs' } });
    check(dmRep.status === 200, 'a DM recipient can report the message', dmRep.data);
    const dmList = await api('GET', '/api/admin/reports?status=open', { token: tAdmin });
    const dmRow = dmList.data.reports.find((r) => r.id === dmRep.data.id);
    check(!!dmRow && dmRow.kind === 'dm' && dmRow.snapshot?.where?.thread?.id === threadId, 'the DM report carries its thread', dmRow && dmRow.snapshot?.where);
    check(!!dmRow && (dmRow.snapshot.where.thread.members || []).some((u) => u.username === 'alice'), 'the DM participants are in the snapshot');
    const dis2 = await api('POST', `/api/admin/reports/${dmRep.data.id}/resolve`, { token: tAdmin, body: { action: 'disable' } });
    check(dis2.status === 200, 'the disable action runs', dis2.data);
    const login = await api('POST', '/api/login', { body: { username: 'bruce', password: 'passw0rd!x' } });
    check(login.status === 403 && login.data.error === 'account_disabled', 'the author is locked out', login.data);
    const disRep = (await api('GET', '/api/admin/reports?status=resolved', { token: tAdmin })).data.reports.find((r) => r.id === dmRep.data.id);
    check(!!disRep && disRep.resolved.action === 'disable', 'the disable outcome is recorded', disRep && disRep.resolved);
    const stillThere = await api('GET', `/api/dms/${threadId}/messages`, { token: tB });
    check((stillThere.data.messages || []).some((m) => m.content.includes('nasty dm message')), 'disable does not delete the message');
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    if (child) { try { child.kill(); } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('[test] crashed:', (e && e.message) || e); process.exit(1); });
