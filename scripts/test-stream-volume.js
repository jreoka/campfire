// Per-person volume: the MIC and the STREAM are two numbers, not one (see
// AGENTS.md verification conventions).
//
// Owner ask: when someone goes live with audio, a listener must be able to turn
// that stream down without turning the person down — i.e. a separate "Stream
// volume" slider beside the mic's. Before this, one number (cf_volumes) was
// written onto BOTH of that peer's audio elements, so the mic mix and the
// stream mix moved together and the game someone was streaming could not be
// quietened without burying their voice.
//
// The REAL volume block (voice.js) and the REAL refreshUserCardVolumes
// (pickers.js) run here against fakes via `new Function`, which keeps the fakes
// the only bindings in scope. Asserted:
//   - the two stores are independent (writing one never moves the other),
//   - each applier writes exactly ONE element: applyUserVolume → audioEls,
//     applyStreamVolume → screenAudioEls (and the attach sites use the right one),
//   - defaults are 100, values clamp to 0–100, garbage/corrupt storage is safe,
//   - peerStreamAudio() is true only for a LIVE audio track (a video-only or
//     ended share must not offer a slider that moves nothing),
//   - an open card reveals/retires the stream row as that track comes and goes.
//
// Usage: node scripts/test-stream-volume.js
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
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) { console.error('[test] could not find the "' + from + '" block'); process.exit(1); }
  return src.slice(a, b);
}

const voice = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
const pickers = fs.readFileSync(path.join(ROOT, 'public/js/pickers.js'), 'utf8');

const VOL_SRC = slice(voice, '// ---------- per-user local volume', '// Occupants of the room I\'m currently in');
const REFRESH_SRC = slice(pickers, 'function refreshUserCardVolumes(uid) {', '// ---------- server tag mini-panel ----------');
const MIC_ATTACH = slice(voice, 'function attachRemoteAudioTrack(peerId, track) {', 'function attachScreenAudioTrack(peerId, track) {');
const STREAM_ATTACH = slice(voice, 'function attachScreenAudioTrack(peerId, track) {', 'function attachRemoteAudio(peerId, stream) {');

// ---------- fakes ----------
function fakeLocalStorage() {
  const m = new Map();
  return {
    raw: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}
function classList() {
  const s = new Set();
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    contains: (c) => s.has(c),
    toggle: (c, on) => { if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); return s.has(c); },
    set: s,
  };
}
function fakeEl() { const cl = classList(); return { classList: cl, classes: cl.set }; }
function fakeCard(uid, hidden, children) {
  const cl = classList();
  if (hidden) cl.add('hidden');
  return { dataset: { uid }, classList: cl, querySelectorAll: () => children };
}
// getAudioTracks() is audio-only, like the real MediaStream's — a video track
// must never make the stream slider appear.
function streamOf(tracks) { return { getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') }; }
const track = (kind, readyState) => ({ kind, readyState, id: kind + ':' + readyState + ':' + Math.random() });

// Build the two REAL functions in one scope (streamAudioChanged reaches
// refreshUserCardVolumes through a typeof check, so both must share it).
function build(localStorage, S, $) {
  return new Function('localStorage', 'S', '$',
    VOL_SRC + '\n' + REFRESH_SRC + '\n' +
    'return { getUserVolume, setUserVolume, getUserStreamVolume, setUserStreamVolume, applyUserVolume, applyStreamVolume, peerStreamAudio, streamAudioChanged, refreshUserCardVolumes };'
  )(localStorage, S, $);
}
function env(voiceState) { return { S: { voice: voiceState || null }, ls: fakeLocalStorage() }; }

console.log('[test] per-person mic + stream volume');

// ---------- 1. the stores are independent ----------
{
  const e = env();
  const f = build(e.ls, e.S, () => null);
  check(f.getUserVolume('u1') === 100 && f.getUserStreamVolume('u1') === 100, 'both default to 100');
  f.setUserVolume('u1', 40);
  check(f.getUserVolume('u1') === 40, 'mic volume stores 40');
  check(f.getUserStreamVolume('u1') === 100, 'writing the mic leaves the stream at 100');
  f.setUserStreamVolume('u1', 15);
  check(f.getUserStreamVolume('u1') === 15, 'stream volume stores 15');
  check(f.getUserVolume('u1') === 40, 'writing the stream leaves the mic at 40');
  const keys = [...e.ls.raw.keys()].sort().join(',');
  check(keys === 'cf_stream_volumes,cf_volumes', 'the two live in separate keys', keys);
  check(JSON.parse(e.ls.raw.get('cf_volumes')).u1 === 40 && JSON.parse(e.ls.raw.get('cf_stream_volumes')).u1 === 15, 'each key holds its own value');
  f.setUserVolume('u2', 5);
  check(f.getUserVolume('u1') === 40 && f.getUserVolume('u2') === 5, 'per-user keys do not clobber each other');
}

// ---------- 2. clamping, rounding, garbage ----------
{
  const e = env();
  const f = build(e.ls, e.S, () => null);
  f.setUserStreamVolume('u1', -20);
  check(f.getUserStreamVolume('u1') === 0, 'below 0 clamps to 0');
  f.setUserStreamVolume('u1', 400);
  check(f.getUserStreamVolume('u1') === 100, 'above 100 clamps to 100');
  f.setUserStreamVolume('u1', 33.6);
  check(f.getUserStreamVolume('u1') === 34, 'fractional rounds to 34');
  f.setUserStreamVolume('u1', 'nonsense');
  check(f.getUserStreamVolume('u1') === 0, 'non-numeric is 0, never NaN');
  e.ls.setItem('cf_stream_volumes', '{not json');
  check(f.getUserStreamVolume('u1') === 100, 'corrupt JSON falls back to 100');
  e.ls.setItem('cf_stream_volumes', 'null');
  check(f.getUserStreamVolume('u1') === 100, 'null storage falls back to 100');
  e.ls.setItem('cf_stream_volumes', '{"u1":"55"}');
  check(f.getUserStreamVolume('u1') === 55, 'a string value still reads as 55');
}

// ---------- 3. each applier owns exactly one element ----------
{
  const micEl = { volume: 1 };
  const streamEl = { volume: 1 };
  const st = { audioEls: new Map([['u1', micEl]]), screenAudioEls: new Map([['u1', streamEl]]) };
  const e = env(st);
  const f = build(e.ls, e.S, () => null);
  f.setUserVolume('u1', 40);
  f.setUserStreamVolume('u1', 15);
  check(Math.abs(micEl.volume - 0.4) < 1e-9, 'mic element gets the mic value', micEl.volume);
  check(Math.abs(streamEl.volume - 0.15) < 1e-9, 'stream element gets the stream value', streamEl.volume);
  // The regression that mattered: one applier must not move the other's element.
  f.setUserVolume('u1', 100);
  check(Math.abs(streamEl.volume - 0.15) < 1e-9, 'raising the mic leaves the stream alone', streamEl.volume);
  f.setUserStreamVolume('u1', 0);
  check(Math.abs(micEl.volume - 1) < 1e-9, 'muting the stream leaves the mic alone', micEl.volume);
  // A peer with only one of the two elements present must not throw.
  const solo = { audioEls: new Map([['u9', { volume: 1 }]]), screenAudioEls: new Map() };
  const f2 = build(fakeLocalStorage(), { voice: solo }, () => null);
  let threw = false;
  try { f2.applyStreamVolume('u9'); f2.applyUserVolume('nobody'); } catch { threw = true; }
  check(!threw, 'a peer with no stream element is a no-op, not a throw');
  let threw2 = false;
  const f3 = build(fakeLocalStorage(), { voice: null }, () => null);
  try { f3.applyUserVolume('u1'); f3.applyStreamVolume('u1'); } catch { threw2 = true; }
  check(!threw2, 'appliers no-op outside a call');
}

// ---------- 4. the attach sites choose the right applier ----------
{
  check(/applyStreamVolume\(peerId\)/.test(STREAM_ATTACH), 'attachScreenAudioTrack applies the STREAM volume');
  check(!/applyUserVolume\(peerId\)/.test(STREAM_ATTACH), 'attachScreenAudioTrack never applies the mic volume');
  check(/applyUserVolume\(peerId\)/.test(MIC_ATTACH), 'attachRemoteAudioTrack applies the MIC volume');
  check(!/applyStreamVolume\(peerId\)/.test(MIC_ATTACH), 'attachRemoteAudioTrack never applies the stream volume');
  check(/streamAudioChanged\(peerId\)/.test(STREAM_ATTACH), 'the stream attach announces itself to the open card');
  check(/track\.onended[\s\S]{0,140}streamAudioChanged\(peerId\)/.test(STREAM_ATTACH), 'the stream track ending re-announces too');
}

// ---------- 5. peerStreamAudio: only a LIVE audio track counts ----------
{
  const e = env({ audioEls: new Map(), screenAudioEls: new Map(), remoteScreenAudio: new Map() });
  const f = build(e.ls, e.S, () => null);
  check(f.peerStreamAudio('u1') === false, 'no stream at all is false');
  e.S.voice.remoteScreenAudio.set('u1', streamOf([]));
  check(f.peerStreamAudio('u1') === false, 'an audio-less stream is false');
  e.S.voice.remoteScreenAudio.set('u1', streamOf([track('video', 'live')]));
  check(f.peerStreamAudio('u1') === false, 'a video-only share is false');
  e.S.voice.remoteScreenAudio.set('u1', streamOf([track('audio', 'live')]));
  check(f.peerStreamAudio('u1') === true, 'a live audio track is true');
  e.S.voice.remoteScreenAudio.set('u1', streamOf([track('audio', 'ended')]));
  check(f.peerStreamAudio('u1') === false, 'an ended audio track is false');
  e.S.voice.remoteScreenAudio.set('u1', streamOf([track('video', 'live'), track('audio', 'live')]));
  check(f.peerStreamAudio('u1') === true, 'video + live audio is true');
  e.S.voice.remoteScreenAudio.delete('u1');
  const el = { volume: 1, srcObject: streamOf([track('audio', 'live')]) };
  e.S.voice.screenAudioEls.set('u1', el);
  check(f.peerStreamAudio('u1') === true, 'an element whose own stream is live is true');
  el.srcObject = null;
  check(f.peerStreamAudio('u1') === false, 'an element with no stream is false');
  const f2 = build(fakeLocalStorage(), { voice: null }, () => null);
  check(f2.peerStreamAudio('u1') === false, 'outside a call it is false');
}

// ---------- 6. the open user card follows the track ----------
{
  const row = fakeEl();
  const label = fakeEl();
  const children = [row, label];
  const e = env({
    audioEls: new Map(), screenAudioEls: new Map(),
    remoteScreenAudio: new Map([['u1', streamOf([track('audio', 'live')])]]),
  });
  let card = fakeCard('u1', false, children);
  const $ = () => card;
  const f = build(e.ls, e.S, $);
  f.refreshUserCardVolumes('u1');
  check(!row.classes.has('hidden') && !label.classes.has('hidden'), 'live stream audio reveals the stream row');
  e.S.voice.remoteScreenAudio.set('u1', streamOf([track('audio', 'ended')]));
  f.refreshUserCardVolumes('u1');
  check(row.classes.has('hidden') && label.classes.has('hidden'), 'the track ending hides it again');
  // The card's own uid guard: a card open for someone ELSE must never be touched.
  e.S.voice.remoteScreenAudio.set('u1', streamOf([track('audio', 'live')]));
  card = fakeCard('someone-else', false, children);
  row.classList.remove('hidden'); label.classList.remove('hidden');
  f.refreshUserCardVolumes('u1');
  check(!row.classes.has('hidden'), 'a card open for another user is left alone');
  card = fakeCard('u1', true, children);
  row.classList.add('hidden'); label.classList.add('hidden');
  f.refreshUserCardVolumes('u1');
  check(row.classes.has('hidden'), 'a closed card is left alone (no work while hidden)');
  // No card in the DOM at all, and a bare streamAudioChanged call, must not throw.
  const f2 = build(e.ls, e.S, () => null);
  let threw = false;
  try { f2.refreshUserCardVolumes('u1'); f2.streamAudioChanged('u1'); } catch { threw = true; }
  check(!threw, 'no card on screen is a no-op, not a throw');
  // The bridge really does reach the card function (typeof guard satisfied).
  const card2 = fakeCard('u1', false, children);
  const f3 = build(e.ls, e.S, () => card2);
  row.classList.add('hidden'); label.classList.add('hidden');
  e.S.voice.remoteScreenAudio.set('u1', streamOf([track('audio', 'live')]));
  f3.streamAudioChanged('u1');
  check(!row.classes.has('hidden'), 'streamAudioChanged reaches the open card');
  // ...and stays silent when pickers.js did not load the function.
  const orphan = new Function('S', 'localStorage', VOL_SRC + '\nreturn streamAudioChanged;')({ voice: null }, fakeLocalStorage());
  let threw2 = false;
  try { orphan('u1'); } catch { threw2 = true; }
  check(!threw2, 'the bridge is guarded when the card module is absent');
}

// ---------- 7. the card's markup and wiring ----------
{
  check(/uc-sec-label">Mic volume</.test(pickers), 'the mic slider is labelled "Mic volume"');
  check(/uc-sec-label uc-vol-stream-label\$\{streamHidden\}">Stream volume</.test(pickers), 'a second, separately labelled "Stream volume" row exists');
  check(/id="uc-vol-stream"[^>]*aria-label="Stream volume"/.test(pickers), 'the stream slider has its own id + aria-label');
  check(/id="uc-vol-stream-pct"/.test(pickers), 'the stream slider has its own percentage readout');
  check(/getUserStreamVolume\(uid\)/.test(pickers), 'the stream row paints the stored stream value');
  check(/svol\.oninput[\s\S]{0,200}setUserStreamVolume\(uid, svol\.value\)/.test(pickers), 'the stream slider writes through setUserStreamVolume');
  check(/\$\('#uc-vol-stream-pct'\)[\s\S]{0,120}getUserStreamVolume\(uid\)/.test(pickers), 'its readout reads back the stored value');
  check(/myPeer && myPeer\.sharing && peerStreamAudio\(uid\)/.test(pickers), 'the row exists only for a sharing peer with real stream audio');
  check(/streamHidden = hasStreamAudio \? '' : ' hidden'/.test(pickers), 'it starts hidden when there is no stream audio');
}

console.log(`\n[test] ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
