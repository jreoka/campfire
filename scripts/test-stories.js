// Stories E2E against a local dev server (see AGENTS.md verification conventions).
const PORT = process.env.PORT || 3210;
const BASE = 'http://localhost:' + PORT;
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

let fails = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { fails++; console.log('  ✗ ' + label + (extra ? '  ' + JSON.stringify(extra) : '')); }
}
async function req(method, p, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + p, { method, headers, body: payload });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const PngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8DAwMDAwMDEAAOM4xQATBQBAx0kZ2EAAAAASUVORK5CYII=',
  'base64'
);

async function uploadAndStory(token, extra = {}) {
  // The server has a 3s anti-flood gap between story posts.
  await new Promise((s) => setTimeout(s, 3200));
  const fd = new FormData();
  fd.append('file', new Blob([PngBytes], { type: 'image/png' }), 'story.png');
  const up = await req('POST', '/api/upload', { token, form: fd });
  if (up.status !== 200) return { error: up };
  const post = await req('POST', '/api/stories', {
    token,
    body: { url: up.data.url, mime: up.data.mime, kind: 'image', caption: extra.caption || 'hello', audience: extra.audience || 'friends', serverId: extra.serverId, durationMs: 5000 },
  });
  return { up: up.data, post };
}

(async () => {
  const tag = Date.now().toString(36).slice(-5);
  const A = { username: 'sa' + tag, displayName: 'StoryA ' + tag, password: 'passw0rd!x' };
  const B = { username: 'sb' + tag, displayName: 'StoryB ' + tag, password: 'passw0rd!x' };

  console.log('\n[1] accounts + friendship');
  let r = await req('POST', '/api/register', { body: { username: A.username, displayName: A.displayName, password: A.password } });
  ok(r.status === 200 && r.data.token, 'register A', r.data);
  const ta = r.data.token;
  r = await req('POST', '/api/register', { body: { username: B.username, displayName: B.displayName, password: B.password } });
  ok(r.status === 200 && r.data.token, 'register B', r.data);
  const tb = r.data.token;
  r = await req('POST', '/api/friends', { token: ta, body: { username: B.username } });
  ok(r.status === 200, 'A → friend request', r.data);
  r = await req('GET', '/api/friends', { token: tb });
  const bid = (r.data.friends && r.data.pendingIn && r.data.pendingIn[0]) ? r.data.pendingIn[0].id : null;
  ok(!!bid, 'B sees the request');
  r = await req('POST', '/api/friends/' + bid + '/accept', { token: tb });
  ok(r.status === 200, 'B accepts', r.data);

  console.log('\n[2] empty trays');
  r = await req('GET', '/api/stories', { token: tb });
  ok(r.status === 200 && r.data.mine === null && r.data.friends.length === 0 && r.data.servers.length === 0, 'B has nothing yet', r.data);

  console.log('\n[3] A posts a friends story');
  let made = await uploadAndStory(ta, { caption: 'first!' });
  ok(made.post && made.post.status === 200, 'story created', made.post && made.post.data);
  const story = made.post.data.story;
  ok(story && story.seen === true && story.views === 0, 'author view is marked seen');
  ok(story.caption === 'first!', 'caption stored');

  r = await req('GET', '/api/stories', { token: tb });
  const tray = (r.data.friends || []).find((t) => t.user && t.user.username === A.username);
  ok(!!tray && tray.items.length === 1, 'B sees A\'s tray', r.data);
  ok(tray && tray.unseen === 1 && tray.items[0].seen === false, 'unseen for B');
  ok(tray && tray.items[0].author && tray.items[0].author.username === A.username, 'item carries the author');
  r = await req('GET', '/api/stories', { token: ta });
  ok(r.data.mine && r.data.mine.items.length === 1 && r.data.friends.length === 0, 'A sees it under mine only', r.data);

  console.log('\n[4] views');
  r = await req('POST', '/api/stories/' + story.id + '/view', { token: tb });
  ok(r.status === 200 && r.data.views === 1, 'B watches it', r.data);
  r = await req('GET', '/api/stories', { token: tb });
  const tray2 = (r.data.friends || []).find((t) => t.user.username === A.username);
  ok(tray2 && tray2.items[0].seen === true && tray2.unseen === 0, 'now seen');
  r = await req('GET', '/api/stories/' + story.id + '/viewers', { token: ta });
  ok(r.status === 200 && r.data.viewers.length === 1 && r.data.viewers[0].username === B.username, 'A can list viewers', r.data);
  r = await req('GET', '/api/stories/' + story.id + '/viewers', { token: tb });
  ok(r.status === 404, 'B cannot list viewers');
  r = await req('GET', '/api/stories', { token: ta });
  ok(r.data.mine.viewers === 1, 'A sees the view count', r.data.mine);

  console.log('\n[5] audience: server');
  r = await req('POST', '/api/servers', { token: ta, body: { name: 'Storysrv ' + tag } });
  const srv = r.data.server, invite = r.data.invite;
  ok(!!srv && !!invite, 'server created');
  r = await req('POST', '/api/servers/join', { token: tb, body: { inviteCode: invite.code } });
  ok(r.status === 200, 'B joins');
  made = await uploadAndStory(ta, { caption: 'server only', audience: 'server', serverId: srv.id });
  ok(made.post && made.post.status === 200, 'server story created', made.post && made.post.data);
  const sStory = made.post.data.story;
  r = await req('GET', '/api/stories', { token: tb });
  const st = (r.data.servers || []).find((t) => t.server.id === srv.id);
  ok(!!st && st.items.length === 1 && st.unseen === 1, 'B sees the server tray', r.data.servers);
  ok(st && st.items[0].caption === 'server only', 'server caption');
  // non-member cannot see it
  r = await req('POST', '/api/register', { body: { username: 'sc' + tag, displayName: 'StoryC', password: 'passw0rd!x' } });
  const tc = r.data.token;
  r = await req('GET', '/api/stories', { token: tc });
  ok(r.data.servers.length === 0 && r.data.friends.length === 0, 'outsider sees nothing', r.data);
  r = await req('POST', '/api/stories/' + sStory.id + '/view', { token: tc });
  ok(r.status === 404, 'outsider cannot mark a view');

  console.log('\n[6] validation');
  r = await req('POST', '/api/stories', { token: ta, body: { url: '/uploads/files/nope.png', mime: 'image/png' } });
  ok(r.status === 429 || r.status === 400, 'rate limit / bad request', r.data);
  await new Promise((s) => setTimeout(s, 3100));
  r = await req('POST', '/api/stories', { token: ta, body: { url: 'https://example.com/x.png', mime: 'image/png' } });
  ok(r.status === 400, 'remote urls rejected', r.data);
  r = await req('POST', '/api/stories', { token: ta, body: { url: '/uploads/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf', mime: 'application/pdf' } });
  ok(r.status === 400, 'non-media rejected', r.data);
  r = await req('POST', '/api/stories', { token: tb, body: { url: '/uploads/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', mime: 'image/png', audience: 'server', serverId: srv.id } });
  ok(r.status === 200 || r.status === 429, 'B may post to a server they are in', r.data && r.data.error);

  console.log('\n[7] delete');
  r = await req('DELETE', '/api/stories/' + sStory.id, { token: tb });
  ok(r.status === 403, 'someone else cannot delete my story', r.data);
  r = await req('DELETE', '/api/stories/' + sStory.id, { token: ta });
  ok(r.status === 200, 'author can delete', r.data);
  r = await req('GET', '/api/stories', { token: tb });
  ok(!(r.data.servers || []).some((t) => t.items.some((i) => i.id === sStory.id)), 'deleted server story is gone');

  console.log('\n[8] expiry reaper (backdate + restart)');
  r = await req('GET', '/api/stories', { token: ta });
  const liveId = r.data.mine.items[0].id;
  const liveUrl = r.data.mine.items[0].url;
  const fileKey = 'files/' + liveUrl.split('?')[0].split('/').pop();
  const dbc = new Client({ host: 'localhost', user: 'campfire', password: 'localdevpass1234', database: 'campfire' });
  await dbc.connect();
  await dbc.query('UPDATE stories SET expires_at = $1 WHERE id = $2', [Date.now() - 1000, liveId]);
  await dbc.end();
  const localFile = path.join(__dirname, '..', 'data', 'uploads', fileKey);
  console.log('  (restarting the dev server to run the boot reaper)');
  const { spawnSync } = require('child_process');
  const killPort = (port) => {
    const out = spawnSync('sh', ['-c', `netstat -ano | grep ':${port}' | grep LISTENING | awk '{print $NF}'`], { encoding: 'utf8' }).stdout || '';
    for (const pid of new Set(out.split(/\s+/).filter(Boolean))) spawnSync('sh', ['-c', `taskkill //PID ${pid} //F`], { stdio: 'ignore' });
  };
  killPort(PORT);
  // Wait for the port to be free before spawning the replacement.
  for (let i = 0; i < 40; i++) {
    const busy = spawnSync('sh', ['-c', `netstat -ano | grep ':${PORT}' | grep -q LISTENING`]).status === 0;
    if (!busy) break;
    await new Promise((s) => setTimeout(s, 250));
  }
  spawnSync('sh', ['-c', `(JWT_SECRET=local-dev-secret-0123456789abcdef PGHOST=localhost PGUSER=campfire PGPASSWORD=localdevpass1234 PGDATABASE=campfire PORT=${PORT} VIRUS_SCAN=0 UNFURL=0 nohup node server.js > /tmp/cf-stories.log 2>&1 &)`], { stdio: 'ignore', cwd: path.join(__dirname, '..') });
  // Wait until it actually answers instead of guessing a fixed delay.
  for (let i = 0; i < 60; i++) {
    await new Promise((s) => setTimeout(s, 250));
    const up = await req('GET', '/api/version').then((x) => x.status === 200).catch(() => false);
    if (up) break;
  }
  await new Promise((s) => setTimeout(s, 1200)); // let boot tasks (reaper) finish
  const dbc2 = new Client({ host: 'localhost', user: 'campfire', password: 'localdevpass1234', database: 'campfire' });
  await dbc2.connect();
  const row = await dbc2.query('SELECT 1 FROM stories WHERE id = $1', [liveId]);
  await dbc2.end();
  ok(row.rowCount === 0, 'expired row reaped');
  ok(!fs.existsSync(localFile), 'expired bytes deleted', localFile);
  let log = '';
  for (const p of ['/tmp/cf-stories.log', path.join(process.env.TEMP || '/tmp', 'cf-stories.log')]) {
    try { log = fs.readFileSync(p, 'utf8'); break; } catch {}
  }
  ok(!log || /\[stories\] reaped 1 expired story/.test(log), 'reaper logged');
  r = await req('GET', '/api/stories', { token: ta });
  ok(r.status === 200, 'server healthy after restart', r.data);

  console.log('\n[9] audiences: everyone + multi-target');
  // A stranger: no friendship, no shared server — the case that started this.
  r = await req('POST', '/api/register', { body: { username: 'sd' + tag, displayName: 'StoryD', password: 'passw0rd!x' } });
  const td = r.data.token;
  await new Promise((s) => setTimeout(s, 3200));
  const up2 = new FormData();
  up2.append('file', new Blob([PngBytes], { type: 'image/png' }), 'pub.png');
  const upRes2 = await req('POST', '/api/upload', { token: ta, form: up2 });
  r = await req('POST', '/api/stories', { token: ta, body: { url: upRes2.data.url, mime: upRes2.data.mime, kind: 'image', caption: 'public', everyone: true } });
  ok(r.status === 200 && r.data.story.shared.everyone === true, 'everyone post is accepted', r.data);
  const pub = r.data.story;
  r = await req('GET', '/api/stories', { token: td });
  ok((r.data.everyone || []).some((t) => t.items.some((i) => i.id === pub.id)), 'a stranger (no friend, no shared server) sees the everyone story');
  ok(!(r.data.friends || []).some((t) => t.items.some((i) => i.caption === 'server only')), '…but not posts they cannot see');
  await new Promise((s) => setTimeout(s, 3200));
  const up3 = new FormData();
  up3.append('file', new Blob([PngBytes], { type: 'image/png' }), 'multi.png');
  const upRes3 = await req('POST', '/api/upload', { token: ta, form: up3 });
  r = await req('POST', '/api/stories', { token: ta, body: { url: upRes3.data.url, mime: upRes3.data.mime, kind: 'image', caption: 'multi', friends: true, servers: [srv.id] } });
  ok(r.status === 200, 'friends+server post accepted', r.data);
  const multiId = r.data.story.id;
  r = await req('GET', '/api/stories', { token: tb });
  ok((r.data.friends || []).some((t) => t.items.some((i) => i.id === multiId)), 'multi post is in the friend tray');
  ok((r.data.servers || []).some((t) => t.items.some((i) => i.id === multiId)), 'multi post is in the server tray');
  r = await req('GET', '/api/stories', { token: ta });
  const mineSrv = (r.data.servers || []).find((t) => t.server.id === srv.id);
  ok(!!mineSrv && mineSrv.items.some((i) => i.id === multiId) && mineSrv.mine >= 1, 'my post also shows in the server area (mine count)', mineSrv && { n: mineSrv.items.length, mine: mineSrv.mine });

  console.log('\n[10] story reply → DM with a durable preview');
  r = await req('GET', '/api/stories', { token: td });
  const pubView = ((r.data.everyone || [])[0] || { items: [] }).items[0];
  r = await req('POST', '/api/stories/' + pubView.id + '/reply', { token: td, body: { text: 'nice one' } });
  ok(r.status === 200 && !!r.data.threadId, 'stranger replies to a public story', r.data.error || r.data.ok);
  const replyMsg = r.data.message;
  ok(replyMsg.storyId === pubView.id && replyMsg.content === 'nice one', 'DM carries the text + story id', { s: replyMsg.storyId, c: replyMsg.content });
  ok(replyMsg.attachments.length === 1 && replyMsg.attachments[0].url !== pubView.url, 'preview is a copy of the story media', replyMsg.attachments);
  const previewUrl = replyMsg.attachments[0].url;
  ok((await fetch(BASE + previewUrl)).status === 200, 'preview bytes are servable now');
  // A friends-only post: a stranger must not be able to reply to it.
  const multiStory = (await req('GET', '/api/stories', { token: ta })).data.mine.items.find((i) => i.caption === 'multi');
  r = await req('POST', '/api/stories/' + multiStory.id + '/reply', { token: td, body: { text: 'nope' } });
  ok(r.status === 404, 'a stranger cannot reply to a post they cannot see', r.data);
  r = await req('POST', '/api/stories/' + multiStory.id + '/reply', { token: tb, body: { text: 'noticed it' } });
  ok(r.status === 200, 'a friend can reply to it', r.data.error || r.data.ok);
  r = await req('POST', '/api/stories/' + pubView.id + '/reply', { token: ta, body: { text: 'me' } });
  ok(r.status === 400 && r.data.error === 'own_story', 'no replies to your own story', r.data);
  r = await req('POST', '/api/stories/' + pubView.id + '/reply', { token: td, body: { text: '  ' } });
  ok(r.status === 400, 'empty replies rejected', r.data);
  r = await req('DELETE', '/api/stories/' + pubView.id, { token: ta });
  ok(r.status === 200, 'author deletes the replied-to story');
  ok((await fetch(BASE + previewUrl)).status === 200, 'the DM preview survives the story being deleted');

  console.log(fails ? `\nFAILURES: ${fails}\n` : '\nALL STORY TESTS PASSED\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
