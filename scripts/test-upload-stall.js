// A stalled upload must fail visibly instead of shimmering forever.
//
// The bug this covers (reported live): a 36 KB PNG's card sat on "Finishing…"
// with no end. The bytes had reached the object store and the compression
// verdict landed half a second later, so the server was never slow — the
// browser simply never got an answer it could act on. A half-open connection (a
// phone that slept, an app backgrounded mid-upload) leaves an XHR pending with
// NO event at all: no onerror, no onabort, and no timeout of the browser's own.
//
// The watchdog that was supposed to catch that had two holes:
//   1. it was armed only from an upload-progress event reporting every byte
//      sent, so a transfer that never reported progress had NO ceiling at all;
//   2. its one ceiling was five minutes, which from the reader's side is
//      indistinguishable from forever.
//
// This drives the REAL watchdog (sliced out of public/js/messages.js) on a
// virtual clock, so the ceilings are asserted exactly. Offline, no browser.
//
// Usage: node scripts/test-upload-stall.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

const src = fs.readFileSync(path.join(ROOT, 'public/js/messages.js'), 'utf8');
const finalSrc = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');

// ---------- the slice: the watchdog, verbatim ----------
function slice(from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}
const watchdogSrc = slice('// A stalled upload must never shimmer forever', 'function startUpload(u) {');

// A virtual clock: the ceilings are minutes long, so real timers would make this
// test take minutes and still be flaky.
function harness() {
  let now = 1000000;
  let timers = [];
  let seq = 0;
  const store = { uploads: [] };
  const failed = [];
  const api = new Function(
    'S', 'setTimeout', 'clearTimeout', 'Date', 'failUpload', 'prettyError', 'renderUploads', 'toast',
    watchdogSrc + '\nreturn { armUploadWatchdog, checkUploadStall, uploadStalledAt, sweepStalledUploads, detachUpload, UPLOAD_IDLE_MS, UPLOAD_ANSWER_MS, UPLOAD_IDLE_UNKNOWN_MS };'
  )(
    store,
    (fn, ms) => { const id = ++seq; timers.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    (id) => { timers = timers.filter((t) => t.id !== id); },
    { now: () => now },
    (u, err) => { if (!u || u.state !== 'uploading') return; u.state = 'failed'; u.err = String(err); failed.push(u); timers = timers.filter((t) => t.id !== u.watch); },
    (e) => e,
    () => {},
    () => {}
  );
  return {
    api, store, failed,
    // Fire every timer due by `t`, in order, then settle at `t`.
    runTo(t) {
      for (;;) {
        const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        if (now < due.at) now = due.at;
        due.fn();
      }
      now = t;
    },
    // Advance the clock WITHOUT letting timers fire (a page hidden long enough
    // for them to be throttled away, which is what the foreground sweep is for).
    jump(t) { now = t; },
    timerCount: () => timers.length,
    now: () => now,
  };
}
const upload = (over) => Object.assign({ id: 1, state: 'uploading', loaded: 0, total: 4096, indet: false, err: '', xhr: null, thumb: '', watch: null, startedAt: 1000000, lastTick: 1000000, sentAt: 0 }, over);

function main() {
  console.log('\n[1] the body is out and the answer never comes');
  {
    const h = harness();
    const u = upload({ loaded: 4096, sentAt: 1000000 + 2000 }); // every byte handed over 2s in
    h.api.armUploadWatchdog(u);
    h.runTo(1000000 + 2000 + h.api.UPLOAD_ANSWER_MS - 1);
    check(u.state === 'uploading', 'still waiting just before the ceiling', u.state);
    h.runTo(1000000 + 2000 + h.api.UPLOAD_ANSWER_MS);
    check(u.state === 'failed' && u.err === 'upload_timeout', 'it fails at the answer ceiling (not five minutes)', { state: u.state, err: u.err });
    check(h.api.UPLOAD_ANSWER_MS <= 120000, 'and that ceiling is well under two minutes', h.api.UPLOAD_ANSWER_MS);
  }

  console.log('\n[2] the body stalls on the way out');
  {
    const h = harness();
    const u = upload({ loaded: 1024 });
    h.api.armUploadWatchdog(u);
    h.runTo(1000000 + h.api.UPLOAD_IDLE_MS - 1);
    check(u.state === 'uploading', 'a slow transfer is not killed early', u.state);
    h.runTo(1000000 + h.api.UPLOAD_IDLE_MS);
    check(u.state === 'failed', 'no progress for a minute fails it', u.state);
  }

  console.log('\n[3] progress keeps it alive');
  {
    const h = harness();
    const u = upload({ loaded: 0 });
    h.api.armUploadWatchdog(u);
    for (let i = 1; i <= 12; i++) {
      u.loaded = i * 300; u.lastTick = 1000000 + i * 20000;
      h.api.armUploadWatchdog(u); // what a progress event does
      h.runTo(1000000 + i * 20000 + 19000);
      if (u.state !== 'uploading') break;
    }
    check(u.state === 'uploading', 'four minutes of steady progress is never a stall', u.state);
  }

  console.log('\n[4] an unknown size is judged by silence, not by percentage');
  {
    const h = harness();
    const u = upload({ loaded: 0, total: 0 });
    h.api.armUploadWatchdog(u);
    h.runTo(1000000 + h.api.UPLOAD_IDLE_MS + 1000);
    check(u.state === 'uploading', 'the short idle ceiling does not apply when progress cannot be measured', u.state);
    h.runTo(1000000 + h.api.UPLOAD_IDLE_UNKNOWN_MS);
    check(u.state === 'failed', 'but a long silence still fails it', u.state);
  }

  console.log('\n[5] a finished upload is never failed');
  {
    const h = harness();
    const u = upload({ state: 'done', loaded: 4096, sentAt: 1000000 });
    h.api.checkUploadStall(u);
    h.runTo(1000000 + 600000);
    check(u.state === 'done' && !h.failed.length, 'a done entry is left alone', { state: u.state, failed: h.failed.length });
  }

  console.log('\n[6] coming back to the page delivers the verdict at once');
  {
    const h = harness();
    const u = upload({ loaded: 4096, sentAt: 1000000 });
    h.store.uploads.push(u);
    h.api.armUploadWatchdog(u);
    // Hidden long enough that the timer never ran (background timers are throttled).
    h.jump(1000000 + 10 * 60 * 1000);
    check(u.state === 'uploading', 'the bar is still shimmering while hidden', u.state);
    h.api.sweepStalledUploads();
    check(u.state === 'failed' && u.err === 'upload_timeout', 'foregrounding fails it immediately instead of waiting', { state: u.state, err: u.err });
  }

  console.log('\n[7] an abandoned attempt can never answer later');
  {
    const h = harness();
    let aborted = false;
    const xhr = { onload: 1, onerror: 1, onabort: 1, upload: { onprogress: 1 }, abort: () => { aborted = true; } };
    const u = upload({ xhr });
    h.api.detachUpload(u);
    check(aborted && u.xhr === null, 'the XHR is aborted and released', { aborted, xhr: u.xhr });
    check(!xhr.onload && !xhr.onerror && !xhr.onabort && !xhr.upload.onprogress,
      'and its handlers are gone, so a late answer cannot add a second attachment', xhr);
  }

  console.log('\n[8] the wiring that makes all of that reachable');
  {
    check(/try \{ xhr\.send\(fd\); \} catch \(err\) \{ failUpload\(u, err && err\.message\); return; \}[\s\S]{0,400}armUploadWatchdog\(u\);/.test(src),
      'startUpload arms the watchdog from the send, not from a progress event');
    check(!/UPLOAD_STALL_MS/.test(src), 'the old five-minute ceiling is gone');
    check(/if \(u\.total > 0 && u\.loaded >= u\.total && !u\.sentAt\) u\.sentAt = Date\.now\(\);/.test(src),
      'the "every byte sent" moment stamps sentAt (which switches to the short ceiling)');
    check(/function cancelUpload\(id\) \{[\s\S]{0,200}detachUpload\(u\);/.test(src),
      'cancelling detaches the attempt it abandons');
    check(/if \(typeof sweepStalledUploads === 'function'\) sweepStalledUploads\(\);/.test(finalSrc),
      'the app sweeps stalled uploads when the page comes back to the front');
  }

  console.log('\n' + (failures.length ? 'FAILED (' + failures.length + ')\n  - ' + failures.join('\n  - ') : 'all ' + passed + ' checks passed'));
  process.exit(failures.length ? 1 : 0);
}

main();
