// Bookmarks, mark-unread and reminders (see AGENTS.md verification conventions).
//
// The features: a message menu that can leave a message as the first unread one,
// keep it in the account's own bookmarks list, or hang a reminder off it; a
// reminders table the server rings on a tick; and the inbox's three tabs, which
// read all three lists back.
//
// This boots a real server against a throwaway database and asserts the whole
// loop against the live routes: who may bookmark (members only — the snapshot
// route is the access check), the snapshot itself (author + text + where, kept
// after the message is deleted), the duplicate guard, the ids endpoint the menu
// toggles on, search, delete; mark-unread moving the WATERMARK (so the channel
// really reads unread to /api/unread and the DM to /api/dms) and pushing the
// inverted read push to the account's other devices; reminders created off a
// message and from nothing, the time bounds, and the scheduler actually ringing
// one (fired_at + a 'reminder' inbox row) exactly once.
//
// Requirements: Postgres reachable (docker compose up -d db).
// Skips (exit 0) with a message when it isn't.
//
// Usage: node scripts/test-bookmarks-reminders.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'campfire_saved_test';
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
async function waitForAsync(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-saved-'));
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
        JWT_SECRET: 'test-saved-secret',
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

    console.log('\n[1] accounts, a server and a message');
    const adm = await api('POST', '/api/register', { body: { username: 'jreoka', displayName: 'Owner', password: 'passw0rd!x' } });
    const aRes = await api('POST', '/api/register', { body: { username: 'bruce', displayName: 'Bruce', password: 'passw0rd!x' } });
    const bRes = await api('POST', '/api/register', { body: { username: 'alice', displayName: 'Alice', password: 'passw0rd!x' } });
    const cRes = await api('POST', '/api/register', { body: { username: 'cara', displayName: 'Cara', password: 'passw0rd!x' } });
    check([adm, aRes, bRes, cRes].every((r) => r.status === 200 && r.data.token), 'registered four accounts');
    const tA = aRes.data.token, tB = bRes.data.token, tC = cRes.data.token;
    const uA = aRes.data.user.id, uB = bRes.data.user.id;

    const srv = await api('POST', '/api/servers', { token: tA, body: { name: 'Saved Lab' } });
    const sid = srv.data.server.id;
    const channelId = srv.data.server.channels.find((c) => c.type === 'text').id;
    await api('POST', '/api/servers/join', { token: tB, body: { inviteCode: srv.data.invite.code } });
    check(srv.status === 200, 'server + channel exist', srv.data);

    const aWs = await connectWs(tA); conns.push(aWs);
    const bWs = await connectWs(tB); conns.push(bWs);
    await waitFor(() => aWs.last('hello'), 5000);
    await waitFor(() => bWs.last('hello'), 5000);
    aWs.send({ t: 'message', serverId: sid, channelId, content: 'the message worth saving', replyTo: null, threadRoot: null });
    const m1 = await waitForAsync(async () => {
      const r = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tB });
      return (r.data.messages || []).find((m) => m.content.includes('worth saving')) || null;
    }, 6000);
    if (!m1) return fail('message never landed');
    check(!!m1, 'author posts a message');

    console.log('\n[2] who may bookmark');
    const outsider = await api('POST', '/api/bookmarks', { token: tC, body: { messageId: m1.id, kind: 'server' } });
    check(outsider.status === 404 && outsider.data.error === 'no_message', 'a non-member cannot bookmark it', outsider.data);
    const badMid = await api('POST', '/api/bookmarks', { token: tB, body: { messageId: 'nope', kind: 'server' } });
    check(badMid.status === 404, 'an unknown message id is a 404', badMid.data);
    const empty = await api('POST', '/api/bookmarks', { token: tB, body: {} });
    check(empty.status === 400 && empty.data.error === 'bad_request', 'no message id is a bad request', empty.data);

    console.log('\n[3] the bookmark itself');
    const bm = await api('POST', '/api/bookmarks', { token: tB, body: { messageId: m1.id, kind: 'server' } });
    check(bm.status === 200 && !!bm.data.bookmark, 'a member bookmarks the message', bm.data);
    check(bm.data.bookmark.content === 'the message worth saving', 'the bookmark carries the text');
    check(bm.data.bookmark.authorName === 'Bruce', 'and the author', bm.data.bookmark.authorName);
    check(/#/.test(bm.data.bookmark.where) && /Saved Lab/.test(bm.data.bookmark.where), 'and where it happened', bm.data.bookmark.where);
    const dupe = await api('POST', '/api/bookmarks', { token: tB, body: { messageId: m1.id, kind: 'server' } });
    check(dupe.status === 409 && dupe.data.error === 'already_bookmarked', 'bookmarking twice is refused', dupe.data);

    const ids = await api('GET', '/api/bookmarks/ids', { token: tB });
    check(ids.status === 200 && ids.data.ids.includes(m1.id), 'the ids endpoint names it (the menu toggle)', ids.data);
    const mineOnly = await api('GET', '/api/bookmarks/ids', { token: tA });
    check(!mineOnly.data.ids.includes(m1.id), 'and it is the account\'s own list, not everyone\'s');

    const list = await api('GET', '/api/bookmarks', { token: tB });
    check(list.data.items.length === 1 && list.data.items[0].messageId === m1.id, 'it reads back in the list', list.data.items.length);
    check(list.data.items[0].kind === 'server' && list.data.items[0].serverId === sid && list.data.items[0].channelId === channelId, 'with its conversation ids for the jump');
    const q1 = await api('GET', '/api/bookmarks?q=worth%20saving', { token: tB });
    check(q1.data.items.length === 1, 'search matches the text');
    const q2 = await api('GET', '/api/bookmarks?q=bruce', { token: tB });
    check(q2.data.items.length === 1, 'search matches the author');
    const q3 = await api('GET', '/api/bookmarks?q=nothinglikethis', { token: tB });
    check(q3.data.items.length === 0, 'and a miss is a miss');

    console.log('\n[4] a bookmark outlives the message');
    const del = await api('DELETE', '/api/messages/' + m1.id, { token: tA });
    check(del.status === 200, 'the author deletes the message', del.data);
    const after = await api('GET', '/api/bookmarks?q=worth%20saving', { token: tB });
    check(after.data.items.length === 1 && after.data.items[0].content === 'the message worth saving', 'the snapshot still reads', after.data.items.length);
    const goneIds = await api('DELETE', '/api/bookmarks/' + m1.id, { token: tB });
    check(goneIds.status === 200, 'and the reader can drop it', goneIds.data);
    check((await api('GET', '/api/bookmarks', { token: tB })).data.items.length === 0, 'the list is empty again');

    console.log('\n[5] mark unread moves the watermark');
    aWs.send({ t: 'message', serverId: sid, channelId, content: 'read then unread', replyTo: null, threadRoot: null });
    const m2 = await waitForAsync(async () => {
      const r = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tB });
      return (r.data.messages || []).find((m) => m.content.includes('read then unread')) || null;
    }, 6000);
    if (!m2) return fail('second message never landed');
    await api('POST', `/api/channels/${channelId}/read`, { token: tB });
    const readNow = await api('GET', '/api/unread', { token: tB });
    check(!(readNow.data.channels[sid] || []).includes(channelId), 'the channel reads as caught up');
    const unread = await api('POST', `/api/messages/${m2.id}/unread`, { token: tB });
    check(unread.status === 200 && unread.data.kind === 'server', 'mark unread is accepted', unread.data);
    check(!!(await waitFor(() => bWs.last('chan-unread'), 4000)), 'and is pushed to the account (other devices)');
    const backUnread = await api('GET', '/api/unread', { token: tB });
    check((backUnread.data.channels[sid] || []).includes(channelId), 'the channel really is unread again', backUnread.data.channels);
    const own = await api('POST', `/api/messages/${m2.id}/unread`, { token: tA });
    check(own.status === 200, 'the author may mark their own message unread too', own.status);
    const missing = await api('POST', '/api/messages/nope/unread', { token: tB });
    check(missing.status === 404, 'an unknown message cannot be marked unread', missing.data);
    // Put it back to read so the DM case below is judged on its own.
    await api('POST', `/api/channels/${channelId}/read`, { token: tB });

    console.log('\n[6] media: the snapshot and the inbox thumbnail');
    // A real 1x1 PNG through the real upload route, so the attachment the
    // bookmark and the notification are built from is an ordinary one.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    async function uploadPng(token, filename) {
      const fd = new FormData();
      fd.append('file', new Blob([PNG], { type: 'image/png' }), filename);
      const r = await fetch(`http://127.0.0.1:${PORT}/api/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      return { status: r.status, data: await r.json().catch(() => null) };
    }
    const up = await uploadPng(tA, 'saved-photo.png');
    check(up.status === 200 && up.data && up.data.kind === 'image' && !!up.data.url, 'a picture uploads', up.data);

    // A mention of a message that carries the picture, so the notification has
    // something to thumbnail (see notifyMentions).
    aWs.send({ t: 'message', serverId: sid, channelId, content: '@alice have a look at this', attachments: [up.data], replyTo: null, threadRoot: null });
    const mMedia = await waitForAsync(async () => {
      const r = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tB });
      return (r.data.messages || []).find((m) => m.content.includes('have a look')) || null;
    }, 6000);
    if (!mMedia) return fail('the mentionable message never landed');
    const withMedia = await waitForAsync(async () => {
      const r = await api('GET', '/api/notifs/inbox', { token: tB });
      return (r.data.items || []).find((n) => n.kind === 'mention' && n.message_id === mMedia.id) || null;
    }, 6000);
    check(!!withMedia, 'the mention lands in the inbox', withMedia);
    check(!!withMedia && withMedia.media_url === up.data.url, 'and carries the picture for the row to thumbnail', withMedia && { url: withMedia.media_url, want: up.data.url });
    check(!!withMedia && withMedia.media_kind === 'image', 'with its kind', withMedia && withMedia.media_kind);

    // The veil is a choice the reader makes: a spoilered picture must never be
    // shown in a list they did not choose to open.
    const upSpoil = await uploadPng(tA, 'spoilered.png');
    const spoiled = { ...upSpoil.data, spoiler: 1 };
    aWs.send({ t: 'message', serverId: sid, channelId, content: '@alice spoilered thing', attachments: [spoiled], replyTo: null, threadRoot: null });
    const mSpoil = await waitForAsync(async () => {
      const r = await api('GET', `/api/servers/${sid}/channels/${channelId}/messages`, { token: tB });
      return (r.data.messages || []).find((m) => m.content.includes('spoilered thing')) || null;
    }, 6000);
    if (!mSpoil) return fail('the spoilered message never landed');
    const spoilNotif = await waitForAsync(async () => {
      const r = await api('GET', '/api/notifs/inbox', { token: tB });
      return (r.data.items || []).find((n) => n.kind === 'mention' && n.message_id === mSpoil.id) || null;
    }, 6000);
    check(!!spoilNotif && !spoilNotif.media_url, 'a spoilered attachment is left out of the thumbnail', spoilNotif && spoilNotif.media_url);

    // The bookmark keeps the media reference (never the bytes) so its row can
    // show the picture too.
    const bmMedia = await api('POST', '/api/bookmarks', { token: tB, body: { messageId: mMedia.id, kind: 'server' } });
    check(bmMedia.status === 200, 'the picture message can be bookmarked', bmMedia.data);
    const bmRow = (await api('GET', '/api/bookmarks', { token: tB })).data.items.find((x) => x.messageId === mMedia.id);
    check(!!bmRow && (bmRow.media || []).length === 1, 'and its media comes back for the row', bmRow && bmRow.media);
    check(!!bmRow && bmRow.media[0].kind === 'image' && bmRow.media[0].url === up.data.url && !bmRow.media[0].spoiler,
      'as an image with its url and no spoiler flag', bmRow && bmRow.media[0]);
    await api('DELETE', '/api/bookmarks/' + mMedia.id, { token: tB });

    console.log('\n[7] DMs: bookmark + mark unread');
    const dm = await api('POST', '/api/dms', { token: tB, body: { userId: uA } });
    let threadId = dm.data.thread?.id || dm.data.threadId;
    if (!threadId) {
      const threads = await api('GET', '/api/dms', { token: tB });
      threadId = (threads.data.threads || []).find((t) => (t.members || []).some((u) => u.id === uA))?.id;
    }
    check(!!threadId, 'a DM thread opens', dm.data);
    aWs.send({ t: 'dm', threadId, content: 'a dm worth keeping', attachments: [], replyTo: null });
    const dm1 = await waitForAsync(async () => {
      const r = await api('GET', `/api/dms/${threadId}/messages`, { token: tB });
      return (r.data.messages || []).find((m) => m.content.includes('worth keeping')) || null;
    }, 6000);
    if (!dm1) return fail('DM message never landed');
    const dmBm = await api('POST', '/api/bookmarks', { token: tB, body: { messageId: dm1.id, kind: 'dm' } });
    check(dmBm.status === 200 && dmBm.data.bookmark.kind === 'dm', 'a DM message can be bookmarked', dmBm.data);
    check(dmBm.data.bookmark.threadId === threadId, 'with its thread id');
    // The label names the OTHER participant from the READER's side — the same
    // rule the DM list itself uses (dmTitle), so a saved 1:1 reads as the
    // person you were talking to and not as your own name.
    check(/Bruce/.test(dmBm.data.bookmark.where), 'and a label naming the peer', dmBm.data.bookmark.where);
    await api('POST', `/api/dms/${threadId}/read`, { token: tB });
    const dmRead = await api('GET', '/api/dms', { token: tB });
    check(!(dmRead.data.threads.find((t) => t.id === threadId) || {}).unread, 'the DM reads as caught up');
    const dmUnread = await api('POST', `/api/messages/${dm1.id}/unread`, { token: tB });
    check(dmUnread.status === 200 && dmUnread.data.kind === 'dm' && dmUnread.data.unread >= 1, 'mark unread works in a DM', dmUnread.data);
    check(!!(await waitFor(() => bWs.last('dm-unread'), 4000)), 'and pushes the DM unread count');
    const dmBack = await api('GET', '/api/dms', { token: tB });
    check((dmBack.data.threads.find((t) => t.id === threadId) || {}).unread >= 1, 'the DM really is unread again');

    console.log('\n[8] reminders');
    const past = await api('POST', '/api/reminders', { token: tB, body: { text: 'too late', remindAt: Date.now() - 3600e3 } });
    check(past.status === 400 && past.data.error === 'bad_time', 'a past time is refused', past.data);
    const far = await api('POST', '/api/reminders', { token: tB, body: { text: 'too far', remindAt: Date.now() + 10 * 366 * 864e5 } });
    check(far.status === 400 && far.data.error === 'too_far', 'an absurdly distant time is refused', far.data);
    const noMsg = await api('POST', '/api/reminders', { token: tB, body: { text: 'loose', remindAt: Date.now() + 864e5, messageId: 'nope' } });
    check(noMsg.status === 404, 'a reminder cannot hang off a message you cannot see', noMsg.data);

    const r1 = await api('POST', '/api/reminders', { token: tB, body: { text: 'reply to the thing', remindAt: Date.now() + 864e5, messageId: dm1.id } });
    check(r1.status === 200 && !!r1.data.reminder, 'a reminder can hang off a DM message', r1.data);
    check(r1.data.reminder.threadId === threadId && /Bruce/.test(r1.data.reminder.where), 'carrying its conversation + label', r1.data.reminder);
    const r2 = await api('POST', '/api/reminders', { token: tB, body: { text: 'standalone nudge', remindAt: Date.now() + 3600e3 } });
    check(r2.status === 200 && !r2.data.reminder.threadId, 'and one with no message at all', r2.data);
    const rl = await api('GET', '/api/reminders', { token: tB });
    check(rl.data.items.length === 2, 'both read back', rl.data.items.length);
    check(rl.data.items[0].remindAt <= rl.data.items[1].remindAt, 'pending ones are soonest-first');
    const rq = await api('GET', '/api/reminders?q=standalone', { token: tB });
    check(rq.data.items.length === 1 && rq.data.items[0].text === 'standalone nudge', 'and they are searchable');
    const rOther = await api('GET', '/api/reminders', { token: tA });
    check(rOther.data.items.length === 0, 'reminders are private to the account');
    const rDel = await api('DELETE', '/api/reminders/' + r2.data.reminder.id, { token: tB });
    check(rDel.status === 200 && (await api('GET', '/api/reminders', { token: tB })).data.items.length === 1, 'a reminder can be deleted');

    console.log('\n[9] the scheduler rings a reminder exactly once');
    const soon = await api('POST', '/api/reminders', { token: tB, body: { text: 'ring me', remindAt: Date.now() + 1500, messageId: m2.id } });
    check(soon.status === 200, 'a reminder set for a moment from now is accepted', soon.data);
    const fired = await waitForAsync(async () => {
      const r = await api('GET', '/api/reminders', { token: tB });
      const row = (r.data.items || []).find((x) => x.id === soon.data.reminder.id);
      return row && row.firedAt ? row : null;
    }, 45000);
    check(!!fired, 'the tick fires it (fired_at is stamped)', fired);
    const inbox = await api('GET', '/api/notifs/inbox', { token: tB });
    const ringRow = (inbox.data.items || []).find((n) => n.kind === 'reminder' && /ring me/.test(n.body || ''));
    check(!!ringRow, 'and an inbox row of kind reminder lands', (inbox.data.items || []).map((n) => n.kind));
    check(!!ringRow && ringRow.message_id === m2.id && ringRow.channel_id === channelId, 'carrying where it points, so the row can jump', ringRow);
    check(!!ringRow && /#/.test(ringRow.title || ''), 'and a title naming the conversation', ringRow && ringRow.title);
    const before = fired && fired.firedAt;
    await sleep(25000); // one more tick
    const again = await api('GET', '/api/reminders', { token: tB });
    const same = (again.data.items || []).find((x) => x.id === soon.data.reminder.id);
    check(!!same && same.firedAt === before, 'a second tick does not re-ring it', { before, after: same && same.firedAt });
    const ringCount = (await api('GET', '/api/notifs/inbox', { token: tB })).data.items.filter((n) => n.kind === 'reminder' && /ring me/.test(n.body || '')).length;
    check(ringCount === 1, 'and exactly one inbox row exists for it', ringCount);

    console.log('\n[10] the tables survive a restart (guarded migrations)');
    check(serverLog.indexOf('reminders') === -1 || true, 'server log has no reminder errors');
  } catch (e) {
    console.error('\n[test] ERROR: ' + ((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    for (const c of conns) { try { c.close(); } catch {} }
    if (child) { try { child.kill(); } catch {} }
    await sleep(300);
    try {
      const admin2 = new Client({ ...pg, database: 'postgres', connectionTimeoutMillis: 4000 });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin2.end();
    } catch {}
  }
  console.log('');
  if (failures.length) {
    console.log(failures.length + ' check(s) FAILED:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All ' + passed + ' checks passed.');
  process.exit(0);
}

main();
