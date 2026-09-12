// The sidebar voice bar's connection readout (see AGENTS.md verification
// conventions).
//
// The complaint: the quick voice widget above the me bar only ever printed the
// room name, so the one question it cannot answer is the one people ask while
// joining — "is this actually working?". A room where the other side never
// answers looks exactly like a room at rest. The bar now carries a status chip
// driven by the REAL WebRTC mesh plus the signaling socket:
//
//   Connecting…   a peer connection exists but has not reported 'connected'
//   Connected     every live peer is up (and it is honest when you are alone —
//                 the mic is captured and there are no links to build)
//   Reconnecting… a peer failed, is recovering, or the socket dropped
//   Disconnected  navigator.onLine says the whole network is gone
//
// Colours follow the app's semantic palette: green = live, amber = working on
// it, red = down; the dot and the bar's own border ride the same class.
//
// Offline checks are static (markup, stylesheet, wiring). Then the REAL
// voiceConnInfo/paintVoiceStatus functions out of voice.js run against a fake
// DOM, a fake RTCPeerConnection state set and a fake socket, so the mapping
// from mesh state to chip is exercised for real.
//
// Usage: node scripts/test-voice-conn-status.js
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
function skip(msg) { console.log('[test] SKIP: ' + msg); process.exit(0); }

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const voice = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');
const socket = fs.readFileSync(path.join(ROOT, 'public/js/socket.js'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');

// The real block between two markers of voice.js.
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) skip('could not find the "' + from + '" block in voice.js');
  return src.slice(a, b);
}

console.log('\n[1] the sidebar markup carries the readout');
const bar = (() => {
  const a = index.indexOf('<div id="voice-bar"');
  const b = a < 0 ? -1 : index.indexOf('<div id="me-card">', a);
  return a < 0 || b < 0 ? null : index.slice(a, b);
})();
check(!!bar, 'the voice bar is still where the quick call controls live');
check(!!bar && /<span id="voice-conn" role="status" aria-live="polite">Connected<\/span>/.test(bar),
  'and it holds a status chip announced to screen readers (not just a colour)', bar && bar.slice(0, 200));
check(!!bar && /id="voice-status"[\s\S]*id="voice-conn"[\s\S]*<\/span>/.test(bar),
  'the chip sits inside the row that opens the call view (so it is not a second tap target)');
check(!!socket && /try \{ paintVoiceStatus\(true\); \} catch \{\}/.test(socket),
  'the socket open/close paths refresh it');
check(/ws\.onopen[\s\S]{0,400}paintVoiceStatus/.test(socket) && /armConnSoon\(\);[\s\S]{0,300}paintVoiceStatus/.test(socket),
  'both halves: a fresh socket clears it, a dropped one flips it to reconnecting');

console.log('\n[2] the colours are the app\'s semantic ones, and only on the bar');
check(/#voice-conn\{[^}]*margin-left:auto/.test(css), 'the chip is pushed to the bar\'s trailing edge, clear of the room name');
check(/#voice-chan-name\{[^}]*text-overflow:ellipsis/.test(css), 'and the room name ellipsises instead of shoving it off the bar');
check(/#voice-bar\.vc-connected #voice-conn\{[^}]*color:var\(--green\)/.test(css), 'connected reads green');
check(/#voice-bar\.vc-warn #voice-conn\{[^}]*color:var\(--amber\)/.test(css), 'connecting / reconnecting reads amber');
check(/#voice-bar\.vc-down #voice-conn\{[^}]*color:var\(--red\)/.test(css), 'a dead signaling path reads red');
check(/#voice-bar\.vc-warn\{border-color:rgba\(251,191,36/.test(css) && /#voice-bar\.vc-down\{border-color:rgba\(248,113,113/.test(css),
  'the bar\'s own border tints with the state (readable without reading)');
check(/#vf-name\.vc-connected\{color:var\(--green\)\}/.test(css) && /#stage-name\.vc-warn\{color:var\(--amber\)\}/.test(css),
  'the mobile floating bar and the call-view header ride the same classes');
check(/@keyframes vc-pulse/.test(css) && /prefers-reduced-motion:reduce\)\{#voice-bar\.vc-warn \.live-dot\{animation:none\}\}/.test(css),
  'the amber dot pulses, and stops for reduced-motion');
// The chip lives in #voice-bar only: nothing else in the shell may grow it.
check(!/#voice-conn/.test(index.split('<div id="voice-bar"')[0]),
  'the chip is defined once, in the voice bar');

console.log('\n[3] the real state machine, out of voice.js');
// The two functions verbatim, with the module state they close over
// (voicePeerDown / voiceConnAt / voiceConnT) declared alongside them — under
// `with (sandbox)` a `let` in the program scope is what the functions really
// read and write, so the test inspects the same variables the code uses.
const state = `let voicePeerDown = new Map(), voiceConnAt = 0, voiceConnT = null;\n`;
const src = state + slice(voice, 'function voiceConnInfo() {', "\n// The socket is the signaling path");
// A hidden-ish DOM: only the ids the painter touches.
const els = {};
for (const id of ['voice-conn', 'voice-bar', 'vf-name', 'stage-name']) {
  els[id] = {
    id,
    textContent: id === 'voice-conn' ? 'Connected' : '',
    title: '',
    classes: new Set(),
    classList: {
      toggle(c, on) { if (on) els[id].classes.add(c); else els[id].classes.delete(c); },
      contains(c) { return els[id].classes.has(c); },
    },
  };
}
const sandbox = {
  S: { voice: null, ws: null },
  // core.js's $(), the only helper the painter uses.
  $: (sel) => els[String(sel).replace('#', '')] || null,
  document: { querySelector: (sel) => els[String(sel).replace('#', '')] || null },
  navigator: { onLine: true },
  Date,
  setTimeout: (fn) => { sandbox.__pending = fn; return 1; },
  clearTimeout: () => {},
};
sandbox.window = sandbox;
const api = new Function('sandbox', `with (sandbox) { ${src}
  return { voiceConnInfo, paintVoiceStatus, peerDown: () => voicePeerDown,
    resetThrottle: () => { voiceConnAt = 0; voiceConnT = null; } }; }`)(sandbox);

const peer = (state) => ({ connectionState: state });
const run = (pcStates, opts = {}) => {
  sandbox.S.voice = { pcs: new Map(pcStates.map((s, i) => ['p' + i, peer(s)])) };
  sandbox.S.ws = opts.ws === undefined ? { readyState: 1 } : opts.ws;
  sandbox.navigator.onLine = opts.onLine !== false;
  // Clear the throttle window so each case starts from a clean paint. The
  // production code clamps a reset to ~now (a re-entrant paint must not spin),
  // so an external assignment would land inside the window; this runs in the
  // real function's scope.
  api.resetThrottle();
  sandbox.__pending = null;
  // Read the state BEFORE painting: voiceConnInfo() is what first remembers a
  // downed link, so calling it afterwards would describe a later moment.
  const state = api.voiceConnInfo();
  api.paintVoiceStatus(true);
  return {
    state,
    text: els['voice-conn'].textContent,
    cls: els['voice-bar'].classes.has('vc-connected') ? 'connected'
      : (els['voice-bar'].classes.has('vc-warn') ? 'warn' : (els['voice-bar'].classes.has('vc-down') ? 'down' : 'none')),
    warn: els['voice-bar'].classes.has('vc-warn'),
    down: els['voice-bar'].classes.has('vc-down'),
    title: els['voice-bar'].title,
  };
};

const alone = run([]);
check(alone.text === 'Connected' && alone.cls === 'connected',
  'a room you are alone in is Connected (the mic is captured; there is no link to build)', alone);

const joining = run(['connecting']);
check(joining.text === 'Connecting…' && joining.cls === 'warn',
  'a peer still negotiating reads Connecting… in amber', joining);

const up = run(['connected']);
check(up.text === 'Connected' && up.cls === 'connected' && up.title === 'Voice connected',
  'a live peer flips it green', up);

const halfUp = run(['connected', 'connecting']);
check(halfUp.text === 'Reconnecting…' && halfUp.cls === 'warn',
  'a working peer plus a joining one reads Reconnecting…, not a false green', halfUp);

const failed = run(['failed']);
check(failed.text === 'Reconnecting…' && failed.cls === 'warn',
  'a failed peer leaves the chip on Reconnecting… (never a green lie)', failed);
check(api.peerDown().has('p0'), 'and its recovery window is remembered', [...api.peerDown().keys()]);
const recovered = run(['failed']);
check(recovered.text === 'Reconnecting…', 'inside the grace window it is still amber (no flicker)');
sandbox.S.voice.pcs.get('p0').connectionState = 'connected';
api.paintVoiceStatus(true);
check(els['voice-conn'].textContent === 'Connected' && !api.peerDown().has('p0'),
  'and once it recovers, the failure is forgotten', els['voice-conn'].textContent);

console.log('\n[3b] a failed link stays in the mesh until its owner leaves');
// The old handler tore the RTCPeerConnection down on 'failed', which dropped
// the peer out of S.voice.pcs — the readout then counted an empty (healthy)
// mesh and went green while that person's audio was dead. The link has to stay
// so the retry can reuse it and the chip keeps telling the truth.
check(/if \(pc\.connectionState === 'failed'\) \{[\s\S]{0,400}renegotiate\(peerId\)/.test(voice),
  'a failed peer connection is retried, not torn down');
check(!/onconnectionstatechange = \(\) => \{\s*if \(\['failed', 'closed'\]\.includes\(pc\.connectionState\)\) closePeer/.test(voice),
  'and no longer closes the peer on failure (only a real exit does that)');

const noSocket = run([], { ws: { readyState: 3 } });
check(noSocket.text === 'Reconnecting…' && noSocket.cls === 'warn',
  'a dropped signaling socket (chat still retrying) reads Reconnecting…', noSocket);

const offline = run([], { onLine: false, ws: { readyState: 3 } });
check(offline.text === 'Disconnected' && offline.cls === 'down' && offline.down,
  'genuinely offline reads Disconnected in red', offline);

// The throttle must not freeze the chip on whoever connected first: a burst of
// five peers connecting in one tick has to end on the settled state.
sandbox.S.voice = { pcs: new Map() };
sandbox.S.ws = { readyState: 1 };
sandbox.navigator.onLine = true;
els['voice-conn'].textContent = 'Connecting…';
api.paintVoiceStatus(true);                       // opens the window
sandbox.S.voice.pcs.set('p0', peer('connecting'));
api.paintVoiceStatus();                           // throttled → schedules a repaint
sandbox.S.voice.pcs.set('p0', peer('connected'));
api.paintVoiceStatus();                           // still throttled
check(typeof sandbox.__pending === 'function', 'a burst schedules one trailing repaint (not a skipped tail)');
if (sandbox.__pending) sandbox.__pending();
check(els['voice-conn'].textContent === 'Connected',
  'and the settled state is what lands, not the first peer\'s', els['voice-conn'].textContent);

console.log('\n[4] leaving the room clears the readout');
check(/S\.voice = null;[\s\S]{0,200}voicePeerDown\.clear\(\)/.test(voice),
  'leaveVoice drops the remembered peer failures with the room');
check(/paintVoiceStatus\(true\);/.test(voice.slice(0, voice.indexOf('function joinDmCall'))),
  'and joining a room paints immediately (no stale state on the first frame)');
check(/function paintVoiceStatus\(force\) \{\s*\n\s*if \(!S\.voice\) return;/.test(voice),
  'the painter is a no-op with no room, so a late timer cannot resurrect the bar');

console.log('\n[5] the service-worker cache was bumped for a public/ change');
check(/CACHE\s*=\s*'campfire-v\d+'/.test(shell), 'the shell cache is name-versioned', (shell.match(/campfire-v\d+/) || [])[0]);

console.log('\n' + (failures.length ? failures.length + ' FAILED, ' + passed + ' passed' : 'all ' + passed + ' checks passed'));
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
