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
// [7] push notifications still use the caption as the fallback text
check(
  /notifyDmMessage\(t, me, caption \|\| pushed, mid\)/.test(serverSrc),
  'push notification text unchanged',
);

console.log(passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
