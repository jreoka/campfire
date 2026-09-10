// End-to-end test for known-CSAM hash matching (csam-scan.js + server wiring).
//
// Exercises the whole consequence chain against a running server:
//   hash-list import -> upload -> match -> quarantine + account lock + review
//   -> admin clears (false positive) -> unlock + allowlist -> re-upload passes
//   -> admin exemption -> perceptual (PDQ) match on a *modified* re-upload
//
// Requires a running server and ffmpeg/ffprobe on PATH.
//
// Usage:
//   BASE=http://localhost:3000 node scripts/test-csam.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
let checks = 0;

function ok(name, cond, detail) {
  checks++;
  if (cond) console.log(`  ok    ${name}${detail ? '  (' + detail + ')' : ''}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

async function api(method, url, { token, body, raw, headers } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.Authorization = 'Bearer ' + token;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers: h, body: payload });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

function mimeFor(name) {
  const e = String(name).toLowerCase().replace(/.*\./, '');
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[e] || 'application/octet-stream';
}

function form(fields, fileField, filename, buf) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  // Type the blob: image uploaders filter on mimetype, so an untyped blob is
  // rejected as a bad image (the same reason a browser sets it from the file).
  fd.append(fileField, new Blob([buf], { type: mimeFor(filename) }), filename);
  return fd;
}

async function upload(token, filename, buf, field = 'file', url = '/api/upload') {
  const r = await fetch(BASE + url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form({}, field, filename, buf) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 30000, every = 500) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(every);
  }
}

async function main() {
  if (!fs.existsSync('/dev/null')) { /* windows ok */ }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csam-e2e-'));
  const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });

  // A distinctive, structured "illegal" image (synthetic — nothing real here)
  // plus a benign one that looks completely different.
  const bad = path.join(tmp, 'bad.png');
  const badMod = path.join(tmp, 'bad-modified.jpg');
  const good = path.join(tmp, 'good.png');
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=512x512:rate=1', '-frames:v', '1', bad]);
  // Same image, re-encoded + resized + slightly compressed: the classic
  // "re-upload of known material" case that only perceptual hashing catches.
  ff(['-i', bad, '-vf', 'scale=384:384:flags=area', '-q:v', '8', badMod]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=512x512:rate=1', '-frames:v', '1', good]);

  const badBuf = fs.readFileSync(bad);
  const badModBuf = fs.readFileSync(badMod);
  const goodBuf = fs.readFileSync(good);
  const badSha = sha256(badBuf);
  console.log(`\nfixtures: bad.png sha256=${badSha.slice(0, 16)}…  (modified copy re-encoded at q8, 384x384)`);

  // ---- accounts ----
  // Unique per run so the test is repeatable (a previous run may have left an
  // account locked, which is exactly what this test is supposed to produce).
  const run = crypto.randomBytes(3).toString('hex');
  const adminName = 'jreoka'; // seeded site admin
  const badName = 'csam_bad_' + run;
  const admin2Name = 'csam_adm_' + run;
  const mkUser = async (name) => {
    const r = await api('POST', '/api/register', { body: { username: name, password: 'testpass123', displayName: name } });
    if (r.status === 409) {
      const l = await api('POST', '/api/login', { body: { username: name, password: 'testpass123' } });
      return l.json.token;
    }
    return r.json.token;
  };
  const adminTok = await mkUser(adminName);
  const badTok = await mkUser(badName);
  const admin2Tok = await mkUser(admin2Name);

  // The second account is only an admin if promoted; promote via the seeded admin.
  const meR = await api('GET', '/api/me', { token: admin2Tok });
  const admin2Id = meR.json.user.id;
  await api('PATCH', '/api/admin/users/' + admin2Id, { token: adminTok, body: { is_admin: true } });

  ok('admin can read safety stats', (await api('GET', '/api/admin/safety', { token: adminTok })).status === 200);
  ok('non-admin is refused safety stats', (await api('GET', '/api/admin/safety', { token: badTok })).status === 403);

  // ---- import a hash list (SHA-256 exact) ----
  // Real lists arrive as files/CSV; this is the same shape.
  const listText = `kind,hash\nsha256,${badSha}\n`;
  const imp = await fetch(BASE + '/api/admin/safety/hashlist', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + adminTok },
    body: form({ kind: 'sha256', source: 'e2e-test' }, 'file', 'list.csv', Buffer.from(listText)),
  });
  const impJson = await imp.json();
  ok('hash list import accepted', imp.status === 200 && impJson.parsed >= 1, `parsed=${impJson.parsed} added=${impJson.added}`);

  // ---- exact-hash match ----
  const up1 = await upload(badTok, 'bad.png', badBuf);
  ok('illegal upload is accepted for async scanning', up1.status === 200, `status=${up1.status}`);
  const key1 = 'files/' + String(up1.json.url).split('/').pop().split('?')[0];

  const review = await waitFor(async () => {
    const r = await api('GET', '/api/admin/safety/reviews?status=open', { token: adminTok });
    return (r.json.reviews || []).find((x) => x.matchKind === 'sha256');
  }, 30000);
  ok('exact match produced a review row', !!review, review ? `match=${review.matchKind} dist=${review.matchDistance}` : 'none');
  ok('review records the uploader', !!review && review.username === badName, review && review.username);

  // Bytes must be gone from /uploads (410) — never served again.
  const served = await fetch(`${BASE}/uploads/${key1}`);
  ok('quarantined bytes are not served (410)', served.status === 410, `status=${served.status}`);

  // Account is locked: existing token stops working, and login is refused.
  const meAfter = await api('GET', '/api/me', { token: badTok });
  ok('locked account is rejected on existing token', meAfter.status === 403 && meAfter.json.error === 'account_locked',
    `${meAfter.status} ${meAfter.json && meAfter.json.error}`);
  const relogin = await api('POST', '/api/login', { body: { username: badName, password: 'testpass123' } });
  ok('locked account cannot log in again', relogin.status === 403 && relogin.json.error === 'account_locked',
    `${relogin.status} ${relogin.json && relogin.json.error}`);

  // ---- admin exemption ----
  const upAdmin = await upload(admin2Tok, 'bad-admin.png', badBuf);
  ok('admin upload still accepted', upAdmin.status === 200);
  const adminLocked = await waitFor(async () => {
    const r = await api('GET', '/api/me', { token: admin2Tok });
    return r.status === 403 ? 'locked' : null;
  }, 6000, 500);
  ok('admin is NOT auto-locked (no softlock)', adminLocked === null, adminLocked === 'locked' ? 'admin got locked!' : 'still active');
  const adminReviews = await api('GET', '/api/admin/safety/reviews?status=open', { token: adminTok });
  ok('admin upload still raised a review', (adminReviews.json.reviews || []).length >= 1,
    `${(adminReviews.json.reviews || []).length} open`);

  // ---- false-positive clear ----
  const clearR = await api('POST', `/api/admin/safety/reviews/${review.id}/clear`, {
    token: adminTok, body: { notes: 'e2e false positive' },
  });
  ok('admin can clear a review', clearR.status === 200);
  const meAgain = await api('GET', '/api/me', { token: badTok });
  ok('cleared review unlocks the account', meAgain.status === 200, `status=${meAgain.status}`);

  // ---- re-upload is allowlisted ----
  const up2 = await upload(badTok, 'bad-again.png', badBuf);
  ok('re-upload accepted after clear', up2.status === 200);
  const noNewReview = await waitFor(async () => {
    const r = await api('GET', '/api/admin/safety/reviews?status=open', { token: adminTok });
    const hits = (r.json.reviews || []).filter((x) => x.username === badName && x.matchHash === badSha);
    return hits.length === 0 ? 'none' : null;
  }, 6000, 500);
  ok('cleared hash is allowlisted (does not re-trigger)', noNewReview === 'none');

  // ---- perceptual (PDQ) match on a MODIFIED copy ----
  // Import the PDQ hash of the original, then upload the re-encoded/resized
  // copy: an exact-hash scheme cannot catch this, PDQ must.
  const pdq = require('../pdq');
  const badFp = await require('../csam-scan')._fingerprintFile(bad);
  const pdqList = `kind,hash\npdq,${badFp.variants[0]}\n`;
  const imp2 = await fetch(BASE + '/api/admin/safety/hashlist', {
    method: 'POST', headers: { Authorization: 'Bearer ' + adminTok },
    body: form({ kind: 'pdq', source: 'e2e-pdq' }, 'file', 'pdq.csv', Buffer.from(pdqList)),
  });
  ok('pdq list import accepted', imp2.status === 200, `parsed=${(await imp2.json()).parsed}`);

  const badModSha = sha256(badModBuf);
  ok('modified copy differs byte-wise from original', badModSha !== badSha, `${badModSha.slice(0, 12)}… != ${badSha.slice(0, 12)}…`);

  const up3 = await upload(badTok, 'bad-modified.jpg', badModBuf);
  ok('modified re-upload accepted', up3.status === 200);
  const percReview = await waitFor(async () => {
    const r = await api('GET', '/api/admin/safety/reviews?status=open', { token: adminTok });
    return (r.json.reviews || []).find((x) => x.matchKind === 'pdq' && (x.matchDistance === 0 || x.matchDistance > 0));
  }, 30000);
  ok('PDQ caught the re-encoded/resized copy (exact hashing would miss it)', !!percReview,
    percReview ? `distance=${percReview.matchDistance} (threshold ≤31)` : 'no pdq match');

  const stats = await api('GET', '/api/admin/safety', { token: adminTok });
  console.log('\n  safety stats:', JSON.stringify({
    listCounts: stats.json.listCounts, allowCounts: stats.json.allowCounts,
    counts: stats.json.counts, reviews: stats.json.reviews,
    lockedUsers: stats.json.lockedUsers, quarantineFiles: stats.json.quarantineFiles,
  }));

  // ---- admin allowlist + review lifecycle endpoints ----
  const al = await api('GET', '/api/admin/safety/allowlist', { token: adminTok });
  ok('allowlist lists the cleared hash', (al.json.allowlist || []).some((a) => a.hash === badSha),
    `${(al.json.allowlist || []).length} entries`);
  const alDel = await api('DELETE', `/api/admin/safety/allowlist?hash=${badSha}&kind=sha256`, { token: adminTok });
  ok('allowlist entry can be removed', alDel.status === 200);
  // Put it back so the re-upload assertion above stays meaningful.
  await fetch(BASE + '/api/admin/safety/hashlist', {
    method: 'POST', headers: { Authorization: 'Bearer ' + adminTok },
    body: form({ kind: 'sha256', source: 'e2e' }, 'file', 'l.csv', Buffer.from(`kind,hash\nsha256,${badSha}\n`)),
  });
  await api('POST', `/api/admin/safety/reviews/${review.id}/clear`, { token: adminTok, body: { notes: 're-cleared' } });

  const confirmR = await api('POST', `/api/admin/safety/reviews/${percReview.id}/confirm`, {
    token: adminTok, body: { notes: 'e2e confirm', ban: false },
  });
  ok('review can be confirmed', confirmR.status === 200);
  const reopenR = await api('POST', `/api/admin/safety/reviews/${percReview.id}/reopen`, { token: adminTok });
  ok('review can be reopened', reopenR.status === 200);

  const rescan = await api('POST', '/api/admin/safety/rescan', { token: adminTok, body: { scope: 'all' } });
  ok('retroactive rescan queues existing uploads', rescan.status === 200 && rescan.json.queued >= 0,
    `queued=${rescan.json.queued} of ${rescan.json.total}`);

  const unlockR = await api('POST', `/api/admin/safety/users/${review.userId}/unlock`, { token: adminTok });
  ok('manual account unlock works', unlockR.status === 200);

  // ---- profile media (avatar/banner) is scanned INLINE ----
  // These URLs go live immediately, so they must be judged before the handler
  // can reference them. The sha256 is allowlisted by now, so this exercises the
  // PDQ path, which is not.
  const avName = 'csam_av_' + run;
  const avTok = await mkUser(avName);
  const av = await upload(avTok, 'bad-avatar.png', badBuf, 'file', '/api/me/avatar');
  ok('matching avatar is rejected outright (451), not stored', av.status === 451 && av.json.error === 'illegal_content',
    `${av.status} ${av.json && av.json.error}`);
  const avMe = await api('GET', '/api/me', { token: avTok });
  ok('avatar uploader is locked', avMe.status === 403 && avMe.json.error === 'account_locked',
    `${avMe.status} ${avMe.json && avMe.json.error}`);

  const bnName = 'csam_bn_' + run;
  const bnTok = await mkUser(bnName);
  const bn = await upload(bnTok, 'bad-banner.png', badBuf, 'file', '/api/me/banner');
  ok('matching banner is rejected outright (451)', bn.status === 451, `${bn.status}`);

  const goodName = 'csam_ok_' + run;
  const goodTok = await mkUser(goodName);
  const gav = await upload(goodTok, 'good-avatar.png', goodBuf, 'file', '/api/me/avatar');
  ok('benign avatar is accepted', gav.status === 200, `${gav.status} ${gav.json && gav.json.error}`);
  const gMe = await api('GET', '/api/me', { token: goodTok });
  ok('benign avatar uploader is not locked', gMe.status === 200 && !!gMe.json.user.avatar_url);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log('all good');
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
