// A deploy must never reload the page on its own.
//
// The behaviour this covers (owner request): users were being surprised by
// forced reloads. There were three of them, and each was reachable without the
// user doing anything but reading:
//   * a 30-second timer armed the moment a new version was seen, which reloaded
//     the tab mid-sentence;
//   * the next version poll (every 60s, and again on every socket reconnect —
//     and a deploy drops every socket) reloaded immediately if the tab was
//     visible and not in a call;
//   * leaving a voice call reloaded on the spot if an update was waiting.
// The replacement is a banner at the top of the shell with an Update button. It
// is the ONLY thing that may reload, and only when clicked.
//
// This drives the REAL banner code (sliced out of public/js/final.js) against a
// small DOM stub and a virtual clock, so "nothing reloads itself" is asserted
// rather than eyeballed. It also pins the rolling-update rule: with
// `maxUnavailable: 1` across replicas two builds answer at once, so "is there a
// newer release?" is decided by the server's RELEASE GENERATION (a cluster-wide
// counter), never by the build fingerprint.
//
// Offline, no browser. Usage: node scripts/test-update-banner.js
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

const finalSrc = fs.readFileSync(path.join(ROOT, 'public/js/final.js'), 'utf8');

// ---------- the slice: the banner block, verbatim ----------
// From its banner comment to beforeunload, which is the next top-level statement.
const FROM = '// ---------- update banner (a deploy never reloads the page for you) ----------';
const TO = "window.addEventListener('beforeunload'";
const a = finalSrc.indexOf(FROM);
const b = a < 0 ? -1 : finalSrc.indexOf(TO, a + FROM.length);
if (a < 0 || b < 0) { console.error('[test] could not find the update-banner block in final.js'); process.exit(1); }
const bannerSrc = finalSrc.slice(a, b);

// ---------- a DOM/clock harness around the real code ----------
// `server` is a function returning what /api/version would answer.
function harness(server) {
  const handlers = {};
  const els = new Map();
  const makeEl = (id, initial) => {
    const set = new Set(initial || []);
    const el = {
      id, textContent: '', innerHTML: '', disabled: false,
      classList: {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
        toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); },
      },
      addEventListener: (t, fn) => { handlers[id + ':' + t] = fn; },
      click: () => { const fn = handlers[id + ':click']; if (fn) fn({}); },
    };
    el.hidden = () => set.has('hidden');
    return el;
  };
  // #update-banner ships with class="hidden" in index.html; the stub starts there.
  els.set('update-banner', makeEl('update-banner', ['hidden']));
  for (const id of ['ub-sub', 'ub-go', 'ub-x']) els.set(id, makeEl(id));
  const bodySet = new Set();
  const store = new Map();
  const state = { S: {}, reloads: 0, flushed: 0, intervals: [] };
  const doc = {
    body: { classList: { toggle: (c, on) => { if (on) bodySet.add(c); else bodySet.delete(c); }, contains: (c) => bodySet.has(c) } },
    hidden: false,
    addEventListener: () => {},
  };
  const api = new Function(
    'S', 'document', 'localStorage', 'fetch', 'setInterval', 'navigator', 'location',
    'flushDrafts', 'rememberView', 'pinSeenFlush', '$', 'armConnSoon',
    bannerSrc + '\nreturn { checkVersion, onUpdateReady, paintUpdateBanner, dismissUpdateNotice, applyUpdate, noteBuild, pollVersion };'
  )(
    state.S,
    doc,
    {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    async () => ({ ok: true, json: async () => server() }),
    (fn, ms) => { state.intervals.push({ fn, ms }); return state.intervals.length; },
    { serviceWorker: null },
    { reload: () => { state.reloads++; } },
    () => { state.flushed++; },
    () => {},
    () => {},
    (sel) => els.get(String(sel).replace(/^#/, '')) || null,
    () => {}
  );
  return {
    api, state,
    el: (id) => els.get(id),
    bannerOpen: () => bodySet.has('ub-open') && !els.get('update-banner').hidden(),
    bannerShut: () => !bodySet.has('ub-open') && els.get('update-banner').hidden(),
    stored: (k) => store.get(k),
    // Run every poll the code scheduled, the way an hour of open tab would.
    runPolls(n) { for (let i = 0; i < n; i++) for (const it of state.intervals) it.fn(); },
  };
}

async function main() {
  console.log('\n[1] first check just records what this page is running');
  {
    const h = harness(() => ({ version: 'aaa111', gen: 4 }));
    await h.api.checkVersion();
    check(h.state.S.bootVersion === 'aaa111', 'the boot fingerprint is recorded');
    check(h.state.S.bootGen === 4, 'and the release generation', h.state.S.bootGen);
    check(h.bannerShut(), 'no banner for the release we are already on');
    check(h.state.reloads === 0, 'no reload');
  }

  console.log('\n[2] a newer release shows the banner — and NEVER reloads on its own');
  {
    let res = { version: 'aaa111', gen: 4 };
    const h = harness(() => res);
    await h.api.checkVersion();
    res = { version: 'bbb222', gen: 5 };
    await h.api.checkVersion();
    check(h.state.S.updateReady === true, 'the update is flagged');
    check(h.bannerOpen(), 'the banner is up and the shell paid for its height (body.ub-open)');
    check(h.el('ub-sub').textContent.includes('rolled out'), 'the sub-line says a change rolled out', h.el('ub-sub').textContent);
    check(h.el('ub-go').textContent === 'Update', 'the button reads Update', h.el('ub-go').textContent);
    check(h.state.reloads === 0, 'still no reload');
    // The three old reload paths, all at once: the 30s timer (there is none),
    // sixty more version polls, and a foregrounding.
    h.runPolls(60);
    check(h.state.reloads === 0, '60 further polls (an hour of open tab) reload nothing', { reloads: h.state.reloads });
    check(h.bannerOpen(), 'and the banner is still waiting for the reader');
    check(h.state.intervals.every((i) => i.ms === 60000), 'the only interval is the version poll', h.state.intervals.map((i) => i.ms));
  }

  console.log('\n[3] clicking Update is the one thing that reloads');
  {
    const h = harness(() => ({ version: 'bbb222', gen: 5 }));
    await h.api.checkVersion();
    h.api.onUpdateReady(5);
    h.el('ub-go').click();
    check(h.state.reloads === 1, 'the button reloads exactly once', { reloads: h.state.reloads });
    check(h.state.flushed === 1, 'and flushes the composer drafts first', { flushed: h.state.flushed });
    check(h.el('ub-go').disabled === true, 'the button is disabled so a second click cannot double-reload');
    check(h.el('ub-go').textContent === 'Updating…', 'and says so');
  }

  console.log('\n[4] dismissing is a real choice: the app keeps running');
  {
    let res = { version: 'aaa111', gen: 4 };
    const h = harness(() => res);
    await h.api.checkVersion();
    res = { version: 'bbb222', gen: 5 };
    await h.api.checkVersion();
    h.el('ub-x').click();
    check(h.bannerShut(), 'dismissing takes the banner away');
    h.runPolls(10);
    check(h.bannerShut(), 'and it stays away rather than nagging on every poll');
    check(h.state.reloads === 0, 'nothing reloaded');
    check(h.state.S.updateReady === true, 'the update is still known to be waiting (a natural reload still gets it)');
    // A LATER release is a new fact and speaks up again.
    res = { version: 'ccc333', gen: 6 };
    await h.api.checkVersion();
    check(h.bannerOpen(), 'a release newer than the dismissed one raises the banner again');
  }

  console.log('\n[5] an OLDER build still serving mid-rollout is not an update');
  {
    // The rolling-update case: two builds answer at once. This tab booted from
    // the new pod, then polled an old one — which reports a LOWER generation and
    // must raise nothing. (A fingerprint cannot tell the two apart: it reads as a
    // change either way round, which is why the generation exists.)
    let res = { version: 'bbb222', gen: 5 };
    const h = harness(() => res);
    await h.api.checkVersion();          // booted from gen 5
    res = { version: 'aaa111', gen: 4 }; // an old pod answers the next poll
    await h.api.checkVersion();
    check(h.bannerShut(), 'an older build still serving does not prompt');
    check(h.state.S.updateReady === false, 'and does not arm the update flag');
    check(h.state.S.bootGen === 5, 'the tab still knows what it is running');
    // Once the rollout finishes, a genuinely newer build still prompts.
    res = { version: 'ccc333', gen: 6 };
    await h.api.checkVersion();
    check(h.bannerOpen(), 'a genuinely newer release still raises the banner');
  }
  {
    // Same shape after a reload: the page lands back on an old pod. Nothing is
    // remembered in localStorage any more — the generation makes it decidable.
    const h = harness(() => ({ version: 'aaa111', gen: 4 }));
    await h.api.checkVersion();
    check(h.bannerShut(), 'booting on the old pod mid-rollout shows nothing');
    check(h.state.reloads === 0, 'no reload');
  }

  console.log('\n[6] in a call the banner warns instead of quietly ending it');
  {
    let res = { version: 'aaa111', gen: 4 };
    const h = harness(() => res);
    await h.api.checkVersion();
    h.state.S.voice = { kind: 'server', serverId: 's', channelId: 'c' };
    res = { version: 'bbb222', gen: 5 };
    await h.api.checkVersion();
    check(h.bannerOpen(), 'the banner still appears');
    check(h.el('ub-go').textContent === 'Leave & update', 'the button says what it will actually do', h.el('ub-go').textContent);
    check(h.el('ub-sub').textContent.includes('end your call'), 'and the copy warns the call will end', h.el('ub-sub').textContent);
    check(h.state.reloads === 0, 'but nothing happens until it is pressed');
    // Hanging up repaints the plain notice; it must NOT reload (the old code did).
    h.state.S.voice = null;
    h.api.paintUpdateBanner();
    check(h.el('ub-go').textContent === 'Update', 'hanging up restores the plain button label', h.el('ub-go').textContent);
    check(h.state.reloads === 0, 'and hanging up does not reload');
  }

  console.log('\n[7] static wiring (the paths a slice cannot see)');
  {
    const reloadsInBlock = (bannerSrc.match(/location\.reload\(\)/g) || []).length;
    check(reloadsInBlock === 1, 'exactly one location.reload() survives in the banner block', { count: reloadsInBlock });
    const applyIdx = bannerSrc.indexOf('function applyUpdate()');
    const reloadIdx = bannerSrc.indexOf('location.reload()');
    check(applyIdx >= 0 && reloadIdx > applyIdx, 'and it is inside applyUpdate() — the button, not a timer');
    check(!/setTimeout/.test(bannerSrc), 'no timer of any kind lives in the banner block');
    check(!/toastAction/.test(finalSrc), 'the old toast-with-Refresh path is gone entirely');

    const voiceSrc = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
    check(!/location\.reload\(\)/.test(voiceSrc), 'leaving a voice call never reloads (voice.js has no reload at all)');
    check(/if \(S\.updateReady\) \{ try \{ paintUpdateBanner\(\); \} catch \{\} \}/.test(voiceSrc),
      'it repaints the banner instead');

    const sockSrc = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
    check(/onUpdateReady\(m\.gen\)/.test(sockSrc), 'the socket handshake passes the peer generation to onUpdateReady');
    check(/noteBuild\(m\.version, m\.gen\)/.test(sockSrc), 'and records the build before comparing');

    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check(/res\.json\(\{ version: APP_VERSION, gen: APP_GEN \}\)/.test(srv), '/api/version reports the release generation');
    check(/t: 'hello'[^}]*gen: APP_GEN/.test(srv), 'and so does the WS handshake');
    check(/app_releases/.test(srv) && /ON CONFLICT \(version\) DO NOTHING/.test(srv),
      'the generation is claimed idempotently, so two replicas booting one image agree');
    const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    check(/CREATE TABLE IF NOT EXISTS app_releases/.test(dbSrc), 'the table is created by a guarded migration');
    check(/CREATE TABLE IF NOT EXISTS watcher_beacons/.test(dbSrc), 'and so is the shared watcher-beacon table');

    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    for (const id of ['update-banner', 'ub-go', 'ub-x', 'ub-sub']) {
      check(html.includes(`id="${id}"`), `index.html carries #${id}`);
    }
    check(/role="status"/.test(html.slice(html.indexOf('id="update-banner"') - 200, html.indexOf('id="update-banner"') + 200)),
      'the banner is announced politely to assistive tech');

    const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
    check(/body\.ub-open\{--ub-h:3rem\}/.test(css), 'the strip declares its own height');
    check(/body\.ub-open #view-main\{padding-top:calc\(var\(--safe-t\) \+ var\(--ub-h\)\)\}/.test(css),
      'and the shell pays for it instead of hiding a header');
    for (const sel of ['#left', '#members', '#vo-view', '#story-view', '#view-auth']) {
      check(css.includes(`body.ub-open ${sel}`), `the fixed-position ${sel} pays for it too`);
    }
    check(/#update-banner\{[^}]*z-index:600/.test(css), 'the strip sits above the app chrome');
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  FAILED: ' + f); process.exit(1); }
  process.exit(0);
}

main();
