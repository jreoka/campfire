// A view-once caption belongs to the story, not the chat: it renders under the
// media in the one-shot viewer (like a regular story caption) instead of as a
// text bubble attached to the view-once card in the DM. messageEl is the single
// renderer for every chat surface, so these are static pins on its decision plus
// the server contract that keeps the caption where the viewer needs it.
//
// Usage: node scripts/test-viewonce-caption.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const messagesSrc = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const viewOnceSrc = fs.readFileSync(path.join(ROOT, 'public/js/viewonce.js'), 'utf8');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

// [1] the text bubble branch is gated off for view-once messages
check(
  /else if \(m\.content && !m\.viewOnce\) \{/.test(messagesSrc),
  'text bubble branch skips view-once messages',
);
// [2] the edit-box branch still comes first, so a caption can still be edited
check(
  /if \(S\.editing === m\.id\) \{[\s\S]{0,1500}\} else if \(m\.content && !m\.viewOnce\) \{/.test(messagesSrc),
  'editing branch still precedes the text branch',
);
// [3] the vo card still renders after the (now skipped) text branch
check(
  /m\.viewOnce && typeof voCardHTML === 'function'\) inner \+= voCardHTML\(m\);/.test(messagesSrc),
  'view-once card still renders in chat',
);
// [4] the one-shot viewer still paints the caption under the media
check(
  /\$\('#vo-cap'\)/.test(viewOnceSrc) && /\.vo-cap/.test(fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')),
  'viewer keeps its under-media caption slot',
);
// [5] the server still stores the caption (the viewer reads it from content)
check(
  /INSERT INTO dm_messages \(id,thread_id,user_id,content,reply_to_id,fwd_from,view_once,/.test(serverSrc),
  'server still stores the caption in content',
);
// [6] the open endpoint still hands the caption to the viewer
check(
  /caption: m\.content \|\| ''/.test(serverSrc),
  '/viewonce/open still returns the caption',
);
// (the old "push notification text unchanged" pin was retired when pushes were
// masked: the server push and the in-app background notification are pinned
// under [9] and [10] below instead.)

// [8] the DM sidebar preview never shows a view-once caption — the generic
// line for the recipient and the sender alike.
const homeSrc = fs.readFileSync(path.join(ROOT, 'public/js/home.js'), 'utf8');
check(
  /t\.last\.viewOnce \? 'Sent a view-once'/.test(homeSrc),
  'sidebar preview masks a view-once caption for everyone',
);
check(
  /viewOnce: !!last\.view_once, mine: userId \? last\.user_id === userId : false/.test(serverSrc),
  'thread payload carries the view-once flag and authorship',
);

// [9] push surfaces never carry a view-once caption (the server push or the
// in-app background-tab notification would put it on the lock screen).
check(
  /notifyDmMessage\(t, me, pushed, mid\)/.test(serverSrc),
  'server push uses the generic view-once line, not the caption',
);
const socketSrc = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
check(
  /m\.viewOnce \? 'Sent a view-once' : \(m\.content \|\| '\[attachment\]'\)/.test(socketSrc),
  'in-app background notification masks a view-once caption',
);

// [11] open receipts: after the recipient opens a view-once, the card reads
// "Opened by X at <time>".
const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
check(
  /addColumn\('dm_messages', 'view_once_opened_by', 'TEXT'\)/.test(dbSrc)
    && /addColumn\('dm_messages', 'view_once_opened_at', 'BIGINT NOT NULL DEFAULT 0'\)/.test(dbSrc),
  'migration adds the open-receipt columns',
);
check(
  /view_once_opened_by = \?, view_once_opened_at = \? WHERE id = \? AND \(view_once_opened_at IS NULL OR view_once_opened_at = 0\)/.test(serverSrc),
  'first /viewonce/open stamps who opened it and when (replays never move it)',
);
check(
  /\[viewonce\] opened push failed/.test(serverSrc)
    && /dmNotify\(m\.thread_id, \{ t: 'dm-updated', message: full \}\)/.test(serverSrc),
  'first open pushes dm-updated so the sender\u2019s card flips live',
);
check(
  /openedAt: Number\(r\.view_once_opened_at\) \|\| 0/.test(serverSrc)
    && /openedBy: r\.view_once_opened_by \? \(voOpenerNames\.get\(r\.view_once_opened_by\) \|\| '\?'\) : null/.test(serverSrc),
  'thread payload carries the opener name and timestamp',
);
const voSrc = fs.readFileSync(path.join(ROOT, 'public/js/viewonce.js'), 'utf8');
check(
  /function voOpenedSub\(vo\)/.test(voSrc) && /'Opened by ' \+ \(vo\.openedBy \|\| 'them'\) \+ ' at ' \+ when/.test(voSrc),
  'card renders the "Opened by X at <time>" receipt',
);

console.log(passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
