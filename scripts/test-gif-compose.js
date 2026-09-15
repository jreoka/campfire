// A GIF picked while a message is being written joins THAT message.
//
// The request: "if i have a message typed out and i click a gif can it attach
// the gif to the message then i can send it instead of sending the gif
// separately". The picker used to post on the click, always — so the words in
// the box stayed in the box and the GIF arrived as its own message above them.
// Now `sendGif` reads the composer first: with words in it (or files already
// staged) the GIF becomes a chip in `#attach-preview` and leaves with the rest
// of the message on the reader's own Send; with an empty composer it still
// posts on the click, which is the whole gesture for "just a GIF".
//
// Three parts:
//   [A] the real `sendGif` block, sliced out of pickers.js and RUN against a
//       fake composer: empty vs. drafted, channel vs. DM, the cap, the chip's
//       own preview, an in-thread reply, and a picker that is choosing profile
//       media (which must never touch the composer);
//   [B] the staged object is the SAME attachment the post-on-the-click path
//       sends — Klipy slug, thumb, mp4 and the measured shape — so a GIF that
//       waited in the composer is exactly as starrable and as well-shaped as
//       one that went straight out;
//   [C] the composer's own submit still sends the staged list with the text,
//       and the chip reads "GIF" rather than the "0 B" a remote GIF has.
//
// Usage: node scripts/test-gif-compose.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

// The real block, with the module just around it.
const GIF_START = 'function gifAttachment(g) {';
const GIF_END = '// ---------- reactions / reply / edit / thread actions ----------';
const gifSource = slice(pickers, GIF_START, GIF_END);

const GIF = {
  slug: 'sunday-al', title: 'Al Roker Shouts Sunday',
  gif: 'https://static.klipy.com/ii/d7ae/5e/90/UPvW7RGb.gif',
  thumb: 'https://static.klipy.com/ii/d7ae/5e/90/wDpY3Hvl.gif',
  mp4: 'https://static.klipy.com/ii/d7ae/5e/90/foquSkvAvV5CbRDkLsdl.mp4',
  w: 640, h: 398,
};

// A composer page: the textarea, the two lists the chips live in, and the
// recorders for everything the block calls out to.
function makeWorld({ text = '', pending = [], view = 'server', ready = true, bar = 'main', replyText = '' } = {}) {
  const world = {
    sent: [], staged: [], toasts: [], previews: [], focuses: 0, closed: 0, profile: [],
    pending, text, view, threadBar: bar, threadList: [],
  };
  const S = {
    view,
    serverId: ready && view !== 'home' ? 's1' : null,
    channelId: ready && view !== 'home' ? 'c1' : null,
    dmThreadId: ready && view === 'home' ? 'dm1' : null,
    pendingAtts: pending,
    uploads: [],
    gifPick: null,
    replyTo: null, threadReplyTo: null, thread: null,
  };
  world.S = S;
  const inp = { value: text, focus: () => { world.focuses++; } };
  // The thread bar's field and its own staged list (the real ones are per-thread;
  // see threadAttCtx/threadAtts in messages.js).
  const threadInp = { value: replyText, focus: () => { world.focuses++; } };
  const els = {
    '#in-message': inp, '#in-thread': threadInp,
    '#attach-preview': { innerHTML: '', classList: { toggle() {}, add() {}, remove() {}, contains: () => true } },
  };
  const run = new Function(
    'S', '$', 'closePicker', 'applyProfileUrl', 'sendChat', 'sendDm', 'renderComposerMeta',
    'renderThreadComposerMeta', 'toast', 'haptic', 'setAttPreview', 'syncPendingAttsCtx',
    'attsCtxNow', 'activeUploadCount', 'draftCtx', 'pickerBar', 'threadAtts', 'threadAttCtx',
    gifSource + '\nreturn { gifAttachment, gifComposerReady, composerHasDraft, stageGif, sendGif };'
  );
  world.api = run(
    S,
    (sel) => els[sel] || null,
    () => { world.closed++; },
    (kind, url) => world.profile.push({ kind, url }),
    (content, opts = {}) => world.sent.push({ how: 'chat', content, ...opts }),
    (content, opts = {}) => world.sent.push({ how: 'dm', content, ...opts }),
    () => { world.meta = (world.meta || 0) + 1; },
    () => { world.threadMeta = (world.threadMeta || 0) + 1; },
    (t) => world.toasts.push(String(t)),
    () => {},
    (url, src) => { world.previews.push({ url, src }); return true; },
    () => false,                        // the composer already belongs to this ctx
    () => 's:s1:c1',
    () => 0,
    () => 's:s1:c1',
    () => world.threadBar,              // pickerBar: which bar opened the picker
    () => world.threadList,             // threadAtts: the reply's own staged files
    () => (S.thread && S.thread.rootId ? 't:' + S.thread.rootId : null)
  );
  return world;
}

function main() {
  console.log('\n[A1] a GIF with nothing being written still posts on the click');
  {
    const w = makeWorld();
    w.api.sendGif(GIF);
    check(w.sent.length === 1 && w.sent[0].how === 'chat' && w.sent[0].content === '',
      'it is its own message, exactly as before', w.sent);
    check(w.sent[0].attachments.length === 1 && w.sent[0].attachments[0].url === GIF.gif,
      'carrying the gif', w.sent[0].attachments);
    check(w.S.pendingAtts.length === 0 && w.previews.length === 0,
      'and the composer is left alone (no chip, no staged file)', w.S.pendingAtts);
    check(w.closed === 1 && w.meta === 1,
      'the picker closed and the composer repainted', { closed: w.closed, meta: w.meta });
  }

  console.log('\n[A2] with a message typed out, the GIF attaches to it instead');
  {
    const w = makeWorld({ text: 'look at this' });
    w.api.sendGif(GIF);
    check(w.sent.length === 0, 'nothing is posted — the reader still owns the Send', w.sent);
    check(w.S.pendingAtts.length === 1 && w.S.pendingAtts[0].url === GIF.gif,
      'the GIF is staged as an attachment on the composer', w.S.pendingAtts);
    check(w.meta >= 1, 'and the composer repaints, so its chip is on screen', w.meta);
    check(w.previews.length === 1 && w.previews[0].src === GIF.thumb,
      'the chip tiles the Klipy THUMB, not the animated gif', w.previews);
    check(w.focuses === 1, 'with the caret back in the box (so the reader can keep typing)', w.focuses);
  }

  console.log('\n[A3] staged files count too — the GIF joins them, text or not');
  {
    const w = makeWorld({ pending: [{ url: '/uploads/files/photo.png', name: 'photo.png', kind: 'image', size: 10 }] });
    w.api.sendGif(GIF);
    check(w.sent.length === 0 && w.S.pendingAtts.length === 2 && w.S.pendingAtts[1].url === GIF.gif,
      'the photo and the GIF are one message waiting to go', w.S.pendingAtts.map((a) => a.url));
  }

  console.log('\n[A4] a DM and a channel both take one');
  for (const [view, how] of [['home', 'dm'], ['server', 'chat']]) {
    const empty = makeWorld({ view });
    empty.api.sendGif(GIF);
    check(empty.sent.length === 1 && empty.sent[0].how === how,
      `an empty ${how === 'dm' ? 'DM' : 'channel'} composer still posts on the click`, empty.sent);
    const drafted = makeWorld({ view, text: 'hey' });
    drafted.api.sendGif(GIF);
    check(drafted.sent.length === 0 && drafted.S.pendingAtts.length === 1,
      `a drafted one stages it instead`, drafted.S.pendingAtts);
  }

  console.log('\n[A5] the 5-attachment cap holds');
  {
    const full = makeWorld({ text: 'hi', pending: [1, 2, 3, 4, 5].map((i) => ({ url: '/u/' + i + '.png' })) });
    full.api.sendGif(GIF);
    check(full.S.pendingAtts.length === 5 && full.sent.length === 0,
      'nothing is added and nothing is posted', full.S.pendingAtts.length);
    check(full.toasts.includes('Max 5 attachments per message'), 'the reader is told why', full.toasts);
    const room = makeWorld({ text: 'hi', pending: [1, 2, 3, 4].map((i) => ({ url: '/u/' + i + '.png' })) });
    room.api.sendGif(GIF);
    check(room.S.pendingAtts.length === 5 && room.toasts.length === 0, 'and the fifth one fits', room.S.pendingAtts.length);
  }

  console.log('\n[A6] no conversation open: nothing is sent, nothing is staged');
  {
    const w = makeWorld({ text: 'orphan', ready: false });
    w.api.sendGif(GIF);
    check(w.sent.length === 0 && w.S.pendingAtts.length === 0, 'it is a no-op (the empty-composer path still guards too)');
    const e = makeWorld({ ready: false });
    e.api.sendGif(GIF);
    check(e.sent.length === 0, 'even with an empty box', e.sent);
  }

  console.log('\n[A7] an in-thread reply and the profile picker are untouched');
  {
    // Empty main composer + a pending in-thread reply: the GIF still goes into
    // the thread, as its own reply (there is nothing to join).
    const w = makeWorld();
    w.S.thread = { rootId: 'root1' };
    w.S.threadReplyTo = { id: 'r1' };
    w.api.sendGif(GIF);
    check(w.sent.length === 1 && w.sent[0].threadRoot === 'root1' && w.sent[0].replyTo === 'r1',
      'the in-thread GIF is still a reply in the thread', w.sent);
    // With words typed in the main composer, the GIF joins THAT message instead.
    const t = makeWorld({ text: 'words' });
    t.S.thread = { rootId: 'root1' };
    t.S.threadReplyTo = { id: 'r1' };
    t.api.sendGif(GIF);
    check(t.sent.length === 0 && t.S.pendingAtts.length === 1,
      'but a drafted main composer wins: the GIF waits for it', t.S.pendingAtts);
    // The picker choosing profile media never touches the chat composer.
    const p = makeWorld({ text: 'words' });
    p.S.gifPick = 'avatar';
    p.api.sendGif(GIF);
    check(p.profile.length === 1 && p.profile[0].kind === 'avatar' && p.profile[0].url === GIF.gif,
      'a profile pick applies to the profile', p.profile);
    check(p.S.pendingAtts.length === 0 && p.sent.length === 0, 'and never stages or posts a message', p.S.pendingAtts);
  }

  console.log('\n[A8] the thread bar\'s own picker posts into the thread, never the channel');
  {
    const w = makeWorld({ bar: 'thread' });
    w.S.thread = { rootId: 'root1' };
    w.S.threadReplyTo = { id: 'r1' };
    w.api.sendGif(GIF);
    check(w.sent.length === 1 && w.sent[0].how === 'chat' && w.sent[0].threadRoot === 'root1' && w.sent[0].replyTo === 'r1',
      'an empty reply box: the GIF goes out as its own reply, with the pending reply chip', w.sent);
    const d = makeWorld({ bar: 'thread', replyText: 'look at this' });
    d.S.thread = { rootId: 'root1' };
    d.api.sendGif(GIF);
    check(d.sent.length === 0 && d.threadList.length === 1 && d.threadList[0].url === GIF.gif,
      'words in the reply box: the GIF is staged on the REPLY instead', d.threadList);
    check(d.S.pendingAtts.length === 0, 'and the chat composer beside it is left alone', d.S.pendingAtts);
    check(d.meta >= 1 && d.previews.length === 1, 'with the reply bar repainted so its chip tiles the thumb', { meta: d.meta, previews: d.previews });
    const closed = makeWorld({ bar: 'thread' });
    closed.api.sendGif(GIF);
    check(closed.sent.length === 0 && closed.threadList.length === 0, 'no thread open: nothing is sent and nothing is staged', closed.sent);
  }

  console.log('\n[B1] a staged GIF is the very attachment the instant path sends');
  {
    const w = makeWorld();
    const att = w.api.gifAttachment(GIF);
    check(att.url === GIF.gif && att.name === 'Al Roker Shouts Sunday.gif' && att.mime === 'image/gif' &&
      att.size === 0 && att.kind === 'image', 'the same shape as before', att);
    check(att.gifSlug === GIF.slug && att.gifThumb === GIF.thumb && att.gifMp4 === GIF.mp4,
      'with the whole Klipy identity (so it is starrable from the chat it lands in)', att);
    check(att.w === 640 && att.h === 398, 'and the measured shape', att);
    const staged = makeWorld({ text: 'x' });
    staged.api.sendGif(GIF);
    check(JSON.stringify(staged.S.pendingAtts[0]) === JSON.stringify(att),
      'staging it does not change a byte of it', staged.S.pendingAtts[0]);
    const mp4Only = w.api.gifAttachment({ title: 'x', mp4: 'https://cdn/x.mp4' });
    check(mp4Only.url === 'https://cdn/x.mp4', 'a GIF with no gif url falls back to its mp4 (as it always did)');
  }

  console.log('\n[C1] the composer sends the staged GIF WITH the text');
  {
    check(/if \(S\.view === 'home'\) sendDm\(content, \{ attachments: S\.pendingAtts, replyTo: S\.replyTo\?\.id \|\| null \}\);/.test(messages)
      && /else sendChat\(content, \{ attachments: S\.pendingAtts, replyTo: S\.replyTo\?\.id \|\| null \}\);/.test(messages),
      'the submit handler hands the staged list and the text over together');
    check(/\(!content && !S\.pendingAtts\.length\) \|\| noChat/.test(messages),
      'and a staged GIF alone is still something to send');
    check(/const url = g\.gif \|\| g\.mp4;/.test(gifSource) && /url, name: \(g\.title \|\| 'gif'\)/.test(gifSource),
      'the instant path and the staged path build the object in ONE place', gifSource.length);
    check(/gifSlug: g\.slug \|\| '', gifThumb: g\.thumb \|\| '', gifMp4: g\.mp4 \|\| ''/.test(gifSource),
      'which is where the picker still stamps its Klipy identity');
  }

  console.log('\n[C2] the chip reads "GIF", not "0 B"');
  {
    const sub = slice(messages, 'function attChipSub(a) {', 'function attChipHTML(a) {');
    check(/const remoteGif = a\.kind === 'image' && a\.mime === 'image\/gif' && !a\.size && \/\^https:\\\/\\\/\/\.test\(String\(a\.url \|\| ''\)\)/.test(sub),
      'a remote gif with no size of ours is recognised', sub.trim());
    check(/\$\{attChipSub\(a\)\}/.test(messages), 'and the chip uses that readout');
    const run = new Function('fmtSize', sub + '\nreturn attChipSub;')((b) => (Number(b) || 0) + ' B');
    check(run({ kind: 'image', mime: 'image/gif', url: 'https://cdn/a.gif', size: 0 }) === 'GIF',
      'the picker GIF chip says GIF', run({ kind: 'image', mime: 'image/gif', url: 'https://cdn/a.gif', size: 0 }));
    check(run({ kind: 'image', mime: 'image/gif', url: '/uploads/files/cat.gif', size: 4096 }) === '4096 B',
      'an uploaded .gif keeps its real size', run({ kind: 'image', mime: 'image/gif', url: '/uploads/files/cat.gif', size: 4096 }));
    check(run({ kind: 'image', mime: 'image/gif', url: 'https://cdn/a.gif', size: 0, spoiler: true }) === 'GIF · Spoiler',
      'and the spoiler readout still rides along');
    check(run({ kind: 'video', mime: 'video/mp4', url: 'https://cdn/a.mp4', size: 0 }) === '0 B',
      'a remote video is not relabelled (only the GIF case is)');
  }

  console.log('\n[C3] the shell cache is versioned');
  check(/const CACHE = 'campfire-v\d+'/.test(sw), 'bumped with these frontend edits');

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${passed + failures.length} checks:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`All ${passed} checks passed.`);
}

main();
