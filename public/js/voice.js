'use strict';
// ---------- VOICE (WebRTC mesh) ----------
// call + notification sounds (synthesized with WebAudio, no assets)
let sfxCtx = null;
function sfxTone(freq, dur = 0.12, type = 'sine', vol = 0.1, delay = 0) {
  try {
    if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (sfxCtx.state === 'suspended') { sfxCtx.resume().catch(() => {}); return; }
    const t0 = sfxCtx.currentTime + delay;
    const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(sfxCtx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  } catch {}
}
const sfx = {
  msg() { sfxTone(880, 0.1, 'sine', 0.09); sfxTone(1318, 0.12, 'sine', 0.07, 0.08); },
  mute() { sfxTone(440, 0.1, 'square', 0.045); },
  unmute() { sfxTone(660, 0.1, 'square', 0.045); },
  deaf() { sfxTone(330, 0.14, 'sawtooth', 0.045); sfxTone(220, 0.16, 'sawtooth', 0.045, 0.1); },
  undeaf() { sfxTone(520, 0.12, 'sine', 0.09); },
  join() { sfxTone(523, 0.1, 'sine', 0.09); sfxTone(784, 0.14, 'sine', 0.09, 0.09); },
  leave() { sfxTone(784, 0.1, 'sine', 0.08); sfxTone(523, 0.16, 'sine', 0.08, 0.09); },
  ring() { sfxTone(660, 0.18, 'sine', 0.09); sfxTone(520, 0.24, 'sine', 0.09, 0.22); },
};
const VB_SVG = {
  mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>',
  deaf: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  cam: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2.5"/><path d="M15 10.5l6-3.5v10l-6-3.5"/></svg>',
  share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M12 17v4M8 21h8"/></svg>',
};
for (const [id, svg] of [['#btn-mute', VB_SVG.mic], ['#vf-mute', VB_SVG.mic], ['#cv-mute', VB_SVG.mic], ['#btn-deafen', VB_SVG.deaf], ['#vf-deafen', VB_SVG.deaf], ['#cv-deafen', VB_SVG.deaf], ['#btn-camera', VB_SVG.cam], ['#vf-camera', VB_SVG.cam], ['#cv-camera', VB_SVG.cam], ['#btn-share', VB_SVG.share], ['#vf-share', VB_SVG.share], ['#cv-share', VB_SVG.share]]) {
  const b = $(id); if (b && !b.innerHTML.trim()) b.innerHTML = svg;
}
if ($('#btn-voice-leave') && !$('#btn-voice-leave').innerHTML.trim()) $('#btn-voice-leave').innerHTML = '✕';
$('#btn-voice-leave').onclick = () => leaveVoice();
$('#vf-leave').onclick = () => leaveVoice();
$('#vf-mute').onclick = () => toggleMute();
$('#btn-mute').onclick = () => toggleMute();
$('#vf-deafen').onclick = () => toggleDeafen();
$('#btn-deafen').onclick = () => toggleDeafen();
$('#vf-camera').onclick = () => toggleCamera();
$('#btn-camera').onclick = () => toggleCamera();
$('#vf-share').onclick = () => toggleScreen();
$('#btn-share').onclick = () => toggleScreen();
if ($('#sc-min')) $('#sc-min').onclick = () => closeCallView();
$('#voice-status').style.cursor = 'pointer';
$('#voice-status').onclick = () => openCallView();
$('#cv-leave').onclick = () => leaveVoice();
$('#cv-mute').onclick = () => toggleMute();
$('#cv-deafen').onclick = () => toggleDeafen();
$('#cv-camera').onclick = () => toggleCamera();
$('#cv-share').onclick = () => toggleScreen();
paintVoiceControls();

async function openVoiceChannel(serverId, channelId) {
  if (S.voice && S.voice.kind !== 'dm' && S.voice.serverId === serverId && S.voice.channelId === channelId) { openCallView(); return; }
  await joinVoice(serverId, channelId);
  if (S.voice && S.voice.kind !== 'dm' && S.voice.serverId === serverId && S.voice.channelId === channelId) openCallView();
}
// ---------- DM calls (1:1 + group): the thread itself is the voice room ----------
function dmOccKey(tid) { return 'dm:' + tid; }
function myVoiceKey() {
  if (!S.voice) return null;
  return S.voice.kind === 'dm' ? dmOccKey(S.voice.threadId) : S.voice.channelId;
}
function dmCallPeers(tid) { return S.voiceOccupancy.get(dmOccKey(tid)) || []; }
// Every voice event converges DM-call occupancy on its own (not just the
// paired voice-peers snapshot), so the in-call border + join strip update
// live even if one message is missed or arrives out of band.
function dmPeerJoined(threadId, peer) {
  if (!peer || !peer.id) return;
  const key = dmOccKey(threadId);
  const occ = S.voiceOccupancy.get(key) || [];
  if (!occ.some((p) => p.id === peer.id)) occ.push({ ...peer });
  S.voiceOccupancy.set(key, occ);
  if (!S.voiceSince.has(key)) S.voiceSince.set(key, Date.now());
}
function dmPeerLeft(threadId, userId) {
  const key = dmOccKey(threadId);
  const occ = (S.voiceOccupancy.get(key) || []).filter((p) => p.id !== userId);
  if (occ.length) S.voiceOccupancy.set(key, occ);
  else { S.voiceOccupancy.delete(key); S.voiceSince.delete(key); }
}
function inThisDmCall(tid) { return !!(S.voice && S.voice.kind === 'dm' && S.voice.threadId === tid); }
function voiceLabel() {
  if (!S.voice) return 'voice';
  if (S.voice.kind === 'dm') {
    const t = (S.dms || []).find((x) => x.id === S.voice.threadId);
    return t ? dmTitle(t) : 'DM call';
  }
  return (S.serverDetail?.channels.find((c) => c.id === S.voice.channelId) || {}).name || 'voice';
}
function paintDmCallButtons() {
  const show = S.view === 'home' && !!S.dmThreadId;
  for (const id of ['#btn-call-voice', '#btn-call-video']) {
    const b = $(id);
    if (b) b.classList.toggle('hidden', !show);
  }
  const inThis = show && inThisDmCall(S.dmThreadId);
  $('#btn-call-voice')?.classList.toggle('in-call', !!inThis);
  $('#btn-call-video')?.classList.toggle('in-call', !!inThis);
}
function dmCallClick(video) {
  if (!S.dmThreadId) return;
  if (inThisDmCall(S.dmThreadId)) {
    if (stageVisible()) openCallView();
    else toast('Already in this call');
    return;
  }
  joinDmCall(S.dmThreadId, video);
}
$('#btn-call-voice').onclick = () => dmCallClick(false);
$('#btn-call-video').onclick = () => dmCallClick(true);
// Incoming-call banner + ringing (first peer in rings the rest).
let ringTimer = null;
function stopRinging() {
  clearInterval(ringTimer); ringTimer = null;
  S.ringing = null;
  $('#incoming-call')?.classList.add('hidden');
}
function onDmCallIncoming(m) {
  refreshDms();
  if (inThisDmCall(m.threadId)) return; // already here — no banner
  if (m.caller && S.me && m.caller.id === S.me.id) return;
  S.ringing = { threadId: m.threadId };
  const c = m.caller || {};
  paintAvatar($('#ic-avatar'), { display_name: c.display_name || '?', avatar_color: c.avatar_color, avatar_url: c.avatar_url });
  $('#ic-title').textContent = `${c.display_name || 'Someone'} is calling`;
  const t = (S.dms || []).find((x) => x.id === m.threadId);
  $('#ic-sub').textContent = (m.video ? 'Video call' : 'Voice call') + (t && t.isGroup ? ` · ${t.name || 'Group chat'}` : '');
  $('#incoming-call').classList.remove('hidden');
  clearInterval(ringTimer);
  sfx.ring();
  ringTimer = setInterval(() => sfx.ring(), 2200);
}
function onDmCallEnded(threadId) {
  if (S.ringing && S.ringing.threadId === threadId) stopRinging();
  // The empty-peers broadcast just before this already cleared occupancy;
  // belt-and-suspenders in case it was missed.
  S.voiceOccupancy.delete(dmOccKey(threadId));
  S.voiceSince.delete(dmOccKey(threadId));
  try { renderDmLists(); } catch {}
  if (S.view === 'home' && S.dmThreadId === threadId) { try { renderDmMembers(); } catch {} }
}
$('#ic-accept').onclick = () => { const tid = S.ringing?.threadId; stopRinging(); if (tid) joinDmCall(tid, false); };
$('#ic-decline').onclick = () => stopRinging();
function openCallView() {
  if (!S.voice) return;
  S.callOpen = true;
  $('#chat').classList.add('call-open');
  $('#stage-name').textContent = voiceLabel();
  $('#messages').classList.add('hidden');
  $('#friends-page').classList.add('hidden');
  $('#composer').classList.add('hidden');
  $('#attach-preview').classList.add('hidden');
  $('#mention-pop').classList.add('hidden');
  $('#chan-pop').classList.add('hidden');
  $('#voice-fab').classList.add('hidden');
  renderStage();
}
function closeCallView() {
  S.callOpen = false;
  $('#chat').classList.remove('call-open');
  if (S.view === 'home' && !S.dmThreadId) renderDmBlank();
  else {
    $('#friends-page').classList.add('hidden');
    $('#messages').classList.remove('hidden');
    $('#composer').classList.remove('hidden');
    if (S.voice) $('#voice-fab').classList.remove('hidden');
    renderComposerMeta();
  }
  renderStage();
}
function updateCallHead() {
  if (!S.voice || !S.callOpen) return;
  const occ = S.voiceOccupancy.get(myVoiceKey()) || [];
  if (S.voice.kind === 'dm') {
    $('#stage-name').textContent = voiceLabel();
    const t0 = S.voiceSince.get(myVoiceKey());
    $('#stage-sub').innerHTML = `${occ.length} in call${t0 ? ` · <span class="vtime" data-vtimer="${myVoiceKey()}">${fmtVoiceTime(Date.now() - t0)}</span>` : ''}`;
    return;
  }
  const srv = (S.servers || []).find((s) => s.id === S.voice.serverId);
  $('#stage-name').textContent = (S.serverDetail?.channels.find((c) => c.id === S.voice.channelId) || {}).name || 'voice';
  const t0 = S.voice.channelId && S.voiceSince.get(S.voice.channelId);
  $('#stage-sub').innerHTML = `${esc(srv ? srv.name + ' · ' : '')}${occ.length} in call${t0 ? ` · <span class="vtime" data-vtimer="${S.voice.channelId}">${fmtVoiceTime(Date.now() - t0)}</span>` : ''}`;
}
async function acquireMic() {
  const mp = mediaPrefs();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: mp.ec, noiseSuppression: true, autoGainControl: mp.agc, ...(mp.micId ? { deviceId: { ideal: mp.micId } } : {}) }, video: false });
  } catch {
    toast('Microphone blocked — allow mic access to join voice');
    return null;
  }
  let sendStream = stream; // stream actually sent to peers (denoised when RNNoise on)
  let noise = null;
  if (noiseSuppressionEnabled()) {
    try { const r = await applyNoiseSuppression(stream); sendStream = r.stream; noise = r; }
    catch { sendStream = stream; } // fall back to raw mic if RNNoise can't start
  }
  return { stream, sendStream, noise };
}
async function joinVoice(serverId, channelId) {
  if (S.voice && S.voice.kind !== 'dm' && S.voice.serverId === serverId && S.voice.channelId === channelId) return; // already here
  leaveVoice(true);
  const mic = await acquireMic();
  if (!mic) return;
  S.voice = { kind: 'server', serverId, channelId, stream: mic.sendStream, micStream: mic.stream, noise: mic.noise, camStream: null, screenStream: null, pcs: new Map(), senders: new Map(), muted: false, deafened: false, cameraOn: false, sharing: false, quality: mediaPrefs().quality, speaking: false, audioEls: new Map(), remoteVideo: new Map(), trackMeta: new Map(), tiles: new Map() };
  $('#voice-bar').classList.remove('hidden');
  $('#voice-fab').classList.remove('hidden');
  $('#voice-chan-name').textContent = voiceLabel();
  $('#vf-name').textContent = voiceLabel();
  paintVoiceControls();
  renderStage();
  S.ws?.send(JSON.stringify({ t: 'voice-join', serverId, channelId }));
  renderChannels();
  startSpeakingMonitor();
  sfx.join();
}
async function joinDmCall(threadId, withVideo = false) {
  if (inThisDmCall(threadId)) { openCallView(); return; }
  leaveVoice(true);
  stopRinging();
  const mic = await acquireMic();
  if (!mic) return;
  S.voice = { kind: 'dm', threadId, stream: mic.sendStream, micStream: mic.stream, noise: mic.noise, camStream: null, screenStream: null, pcs: new Map(), senders: new Map(), muted: false, deafened: false, cameraOn: false, sharing: false, quality: mediaPrefs().quality, speaking: false, audioEls: new Map(), remoteVideo: new Map(), trackMeta: new Map(), tiles: new Map() };
  $('#voice-bar').classList.remove('hidden');
  $('#voice-fab').classList.remove('hidden');
  $('#voice-chan-name').textContent = voiceLabel();
  $('#vf-name').textContent = voiceLabel();
  paintVoiceControls();
  renderStage();
  S.ws?.send(JSON.stringify({ t: 'voice-join', threadId, video: !!withVideo }));
  startSpeakingMonitor();
  sfx.join();
  paintDmCallButtons();
  try { renderDmLists(); } catch {}
  if (withVideo) { try { await toggleCamera(); } catch {} }
}
function leaveVoice(silent) {
  if (!S.voice) return;
  for (const [, pc] of S.voice.pcs) { try { pc.close(); } catch {} }
  try { S.voice.noise?.stop(); } catch {}
  S.voice.stream?.getTracks().forEach((t) => t.stop());
  S.voice.micStream?.getTracks().forEach((t) => t.stop());
  S.voice.camStream?.getTracks().forEach((t) => t.stop());
  S.voice.screenStream?.getTracks().forEach((t) => t.stop());
  for (const [, el] of S.voice.audioEls) { try { el.remove(); } catch {} }
  S.callOpen = false;
  $('#chat').classList.remove('call-open');
  if (S.view === 'home' && !S.dmThreadId) renderDmBlank();
  else { $('#friends-page').classList.add('hidden'); $('#messages').classList.remove('hidden'); $('#composer').classList.remove('hidden'); renderComposerMeta(); }
  $('#stage').classList.add('hidden');
  $('#stage-grid').innerHTML = '';
  const vkey = myVoiceKey();
  S.voice = null;
  stopSpeakingMonitor();
  $('#voice-bar').classList.add('hidden');
  $('#voice-fab').classList.add('hidden');
  paintVoiceControls();
  paintDmCallButtons();
  // optimistically drop self so sidebars clear instantly (server echo confirms)
  if (vkey) {
    const occ = S.voiceOccupancy.get(vkey) || [];
    S.voiceOccupancy.set(vkey, occ.filter((p) => p.id !== S.me.id));
    if (!(S.voiceOccupancy.get(vkey) || []).length) S.voiceSince.delete(vkey);
  }
  if (!silent) { sfx.leave(); S.ws?.send(JSON.stringify({ t: 'voice-leave' })); }
  renderChannels();
  try { renderDmLists(); } catch {}
  if (S.view === 'home' && S.dmThreadId) { try { renderDmMembers(); } catch {} }
  if (S.updateReady && !silent) location.reload();
}
function sendVoiceState() {
  if (!S.voice) return;
  S.ws?.send(JSON.stringify({ t: 'voice-state',
    muted: S.voice.muted, deafened: S.voice.deafened,
    camera: S.voice.cameraOn, sharing: S.voice.sharing,
    speaking: (!S.voice.muted && !S.voice.deafened) && !!S.voice.speaking }));
}
function paintVoiceControls() {
  const v = S.voice;
  const set = (id, off, label) => { const b = $(id); if (!b) return; b.classList.toggle('off', !!off); b.title = label; };
  // Deafening also mutes the mic, so the mic button stays red while deafened.
  const micOff = v?.muted || v?.deafened;
  const micLabel = v?.deafened ? 'Deafened — undeafen to unmute' : (v?.muted ? 'Unmute mic' : 'Mute mic');
  set('#btn-mute', micOff, micLabel);
  set('#vf-mute', micOff, micLabel);
  set('#cv-mute', micOff, micLabel);
  set('#btn-deafen', v?.deafened, v?.deafened ? 'Undeafen' : 'Deafen');
  set('#vf-deafen', v?.deafened, v?.deafened ? 'Undeafen' : 'Deafen');
  set('#cv-deafen', v?.deafened, v?.deafened ? 'Undeafen' : 'Deafen');
  set('#btn-camera', !v?.cameraOn, v?.cameraOn ? 'Turn camera off' : 'Turn camera on');
  set('#vf-camera', !v?.cameraOn, v?.cameraOn ? 'Turn camera off' : 'Turn camera on');
  set('#cv-camera', !v?.cameraOn, v?.cameraOn ? 'Turn camera off' : 'Turn camera on');
  set('#btn-share', v?.sharing, v?.sharing ? 'Stop sharing screen' : 'Share screen');
  set('#vf-share', v?.sharing, v?.sharing ? 'Stop sharing screen' : 'Share screen');
  set('#cv-share', v?.sharing, v?.sharing ? 'Stop sharing screen' : 'Share screen');
}
function applyMicState() {
  if (!S.voice) return;
  const off = S.voice.muted || S.voice.deafened;
  S.voice.stream.getAudioTracks().forEach((t) => (t.enabled = !off));
  if (off) { S.voice.speaking = false; setSpeakingUI(S.me.id, false); }
}
function toggleMute() {
  if (!S.voice) return;
  if (S.voice.deafened) { toast('Undeafen to change your mic'); return; }
  S.voice.muted = !S.voice.muted;
  sfx[S.voice.muted ? 'mute' : 'unmute']();
  applyMicState();
  $('#vf-name').textContent = voiceLabel();
  sendVoiceState();
  paintVoiceControls();
  renderVoiceUsers();
  renderStage();
}
function toggleDeafen() {
  if (!S.voice) return;
  S.voice.deafened = !S.voice.deafened;
  sfx[S.voice.deafened ? 'deaf' : 'undeaf']();
  applyMicState();
  for (const [, el] of S.voice.audioEls) el.muted = S.voice.deafened;
  sendVoiceState();
  paintVoiceControls();
  renderVoiceUsers();
  renderStage();
}
const V_QUALITY = {
  high: { label: '720p', w: 1280, h: 720, br: 2500000 },
  medium: { label: '480p', w: 854, h: 480, br: 1000000 },
  low: { label: '360p', w: 640, h: 360, br: 500000 },
};
// Call device + processing prefs (Settings → Media). Mic/cam/quality apply on
// the next join; the speaker output applies immediately, even mid-call.
function mediaPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('cf_media') || '{}'); } catch {}
  return {
    micId: p.micId || '',
    camId: p.camId || '',
    speakerId: p.speakerId || '',
    quality: V_QUALITY[p.quality] ? p.quality : 'high',
    ec: p.ec !== false,
    agc: p.agc !== false,
  };
}
function saveMediaPref(k, v) {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('cf_media') || '{}'); } catch {}
  p[k] = v;
  try { localStorage.setItem('cf_media', JSON.stringify(p)); } catch {}
}
function applySpeakerOutput() {
  if (!S.voice || !('setSinkId' in HTMLMediaElement.prototype)) return;
  const sp = mediaPrefs().speakerId;
  if (!sp) return;
  for (const [, el] of S.voice.audioEls) { try { el.setSinkId(sp).catch(() => {}); } catch {} }
}
function applySenderQuality(sender) {
  if (!sender || !S.voice) return;
  const q = V_QUALITY[S.voice.quality] || V_QUALITY.high;
  try {
    const p = sender.getParameters();
    p.encodings = (p.encodings && p.encodings.length) ? p.encodings : [{}];
    p.encodings[0].maxBitrate = q.br;
    sender.setParameters(p).catch(() => {});
  } catch {}
}
async function toggleCamera() {
  if (!S.voice) return;
  if (S.voice.cameraOn) { stopCamera(); return; }
  const q = V_QUALITY[S.voice.quality] || V_QUALITY.high;
  const mpc = mediaPrefs();
  let cam;
  try {
    cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 }, ...(mpc.camId ? { deviceId: { ideal: mpc.camId } } : {}) }, audio: false });
  } catch { toast('Camera blocked — allow camera access'); return; }
  S.voice.camStream = cam;
  S.voice.cameraOn = true;
  const track = cam.getVideoTracks()[0];
  for (const [pid, pc] of S.voice.pcs) {
    try {
      const sender = pc.addTrack(track, cam);
      S.voice.senders.get(pid).camera = sender;
      applySenderQuality(sender);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: pid, data: { kind: 'track-meta', trackId: track.id, media: 'camera' } }));
    } catch {}
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
}
function stopCamera() {
  if (!S.voice || !S.voice.cameraOn) return;
  S.voice.camStream?.getVideoTracks().forEach((t) => { try { t.stop(); } catch {} });
  S.voice.camStream = null;
  S.voice.cameraOn = false;
  for (const [pid, pc] of S.voice.pcs) {
    const s = S.voice.senders.get(pid);
    if (s?.camera) { try { pc.removeTrack(s.camera); } catch {} s.camera = null; }
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
}
async function toggleScreen() {
  if (!S.voice) return;
  if (S.voice.sharing) { stopScreen(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('Screen sharing is not supported here'); return; }
  let screen;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
  } catch { return; }
  S.voice.screenStream = screen;
  S.voice.sharing = true;
  const track = screen.getVideoTracks()[0];
  if (track) track.onended = () => { if (S.voice?.sharing) stopScreen(); };
  for (const [pid, pc] of S.voice.pcs) {
    try {
      const sender = pc.addTrack(track, screen);
      S.voice.senders.get(pid).screen = sender;
      applySenderQuality(sender);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: pid, data: { kind: 'track-meta', trackId: track.id, media: 'screen' } }));
    } catch {}
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
  toast('You are sharing your screen');
}
function stopScreen() {
  if (!S.voice || !S.voice.sharing) return;
  S.voice.screenStream?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  S.voice.screenStream = null;
  S.voice.sharing = false;
  for (const [pid, pc] of S.voice.pcs) {
    const s = S.voice.senders.get(pid);
    if (s?.screen) { try { pc.removeTrack(s.screen); } catch {} s.screen = null; }
  }
  sendVoiceState();
  paintVoiceControls();
  renderStage();
}
function renegotiate(peerId) {
  if (!S.voice) return;
  const pc = S.voice.pcs.get(peerId);
  if (!pc || pc.signalingState !== 'stable') return;
  pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
    S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'offer', sdp: pc.localDescription } }));
  }).catch(() => {});
}
function ensurePeer(peerId, initiator) {
  if (!S.voice || peerId === S.me.id || S.voice.pcs.has(peerId)) return S.voice?.pcs.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  pc._initiator = !!initiator;
  pc._remoteOfferSeen = false;
  S.voice.pcs.set(peerId, pc);
  S.voice.senders.set(peerId, { audio: null, camera: null, screen: null });
  const senders = S.voice.senders.get(peerId);
  for (const track of S.voice.stream.getTracks()) senders.audio = pc.addTrack(track, S.voice.stream);
  if (S.voice.cameraOn && S.voice.camStream) {
    const ct = S.voice.camStream.getVideoTracks()[0];
    if (ct) {
      senders.camera = pc.addTrack(ct, S.voice.camStream);
      applySenderQuality(senders.camera);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'track-meta', trackId: ct.id, media: 'camera' } }));
    }
  }
  if (S.voice.sharing && S.voice.screenStream) {
    const st = S.voice.screenStream.getVideoTracks()[0];
    if (st) {
      senders.screen = pc.addTrack(st, S.voice.screenStream);
      applySenderQuality(senders.screen);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'track-meta', trackId: st.id, media: 'screen' } }));
    }
  }
  pc.onnegotiationneeded = () => {
    if (pc._politeWait) return; // non-initiator: wait for the other side's offer first
    renegotiate(peerId);
  };
  if (!initiator) pc._politeWait = true;
  pc.onicecandidate = (e) => {
    if (e.candidate) S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'ice', candidate: e.candidate } }));
  };
  pc.ontrack = (e) => {
    if (!e.track) return;
    if (e.track.kind === 'audio') { attachRemoteAudio(peerId, (e.streams && e.streams[0]) || new MediaStream([e.track])); return; }
    const media = (S.voice.trackMeta.get(e.track.id)) || guessRemoteMedia(peerId);
    attachRemoteVideo(peerId, media, e.track);
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId);
  };
  if (initiator) {
    pc.createOffer().then((offer) => pc.setLocalDescription(offer).then(() => {
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: peerId, data: { kind: 'offer', sdp: pc.localDescription } }));
    })).catch(() => {});
  }
  return pc;
}
async function onVoiceSignal(fromId, data) {
  if (!S.voice || !data) return;
  if (data.kind === 'track-meta' && data.trackId) {
    const want = data.media === 'screen' ? 'screen' : 'camera';
    S.voice.trackMeta.set(data.trackId, want);
    // relocate the track if it arrived before its label did
    for (const [, rv] of S.voice.remoteVideo) {
      for (const key of ['camera', 'screen']) {
        if (key === want) continue;
        const tr = rv[key].getVideoTracks().find((t) => t.id === data.trackId);
        if (tr) { try { rv[key].removeTrack(tr); rv[want].addTrack(tr); } catch {} }
      }
    }
    renderStage();
    return;
  }
  if (data.kind === 'offer') {
    const pc = ensurePeer(fromId, false);
    pc._remoteOfferSeen = true;
    pc._politeWait = false;
    try {
      if (pc.signalingState !== 'stable') {
        if (pc._initiator) return; // glare: our offer wins, ignore theirs
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
      }
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      S.ws?.send(JSON.stringify({ t: 'voice-signal', to: fromId, data: { kind: 'answer', sdp: pc.localDescription } }));
    } catch {}
  } else if (data.kind === 'answer') {
    const pc = S.voice.pcs.get(fromId);
    if (pc) { try { await pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); } catch {} }
  } else if (data.kind === 'ice' && data.candidate) {
    const pc = S.voice.pcs.get(fromId);
    if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {} }
  }
}
function onVoicePeers(peers) {
  if (!S.voice) return;
  // I just joined (or update): initiate offers to everyone already here
  for (const p of peers) {
    if (p.id !== S.me.id && !S.voice.pcs.has(p.id)) ensurePeer(p.id, true);
  }
  // clean up PCs for people who left
  const ids = new Set(peers.map((p) => p.id));
  for (const pid of [...S.voice.pcs.keys()]) {
    if (!ids.has(pid)) closePeer(pid);
  }
}
function closePeer(peerId) {
  if (!S.voice) return;
  const pc = S.voice.pcs.get(peerId);
  if (pc) { try { pc.close(); } catch {} S.voice.pcs.delete(peerId); }
  S.voice.senders.delete(peerId);
  S.voice.remoteVideo.delete(peerId);
  const el = S.voice.audioEls.get(peerId);
  if (el) { try { el.remove(); } catch {} S.voice.audioEls.delete(peerId); }
  renderStage();
}
function attachRemoteAudio(peerId, stream) {
  if (!S.voice) return;
  let el = S.voice.audioEls.get(peerId);
  if (!el) {
    el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
    document.body.appendChild(el);
    S.voice.audioEls.set(peerId, el);
  }
  el.muted = !!S.voice.deafened;
  el.srcObject = stream;
  try {
    const sp = mediaPrefs().speakerId;
    if (sp && typeof el.setSinkId === 'function') el.setSinkId(sp).catch(() => {});
  } catch {}
}
function guessRemoteMedia(peerId) {
  const rv = S.voice.remoteVideo.get(peerId);
  if (rv && rv.camera.getVideoTracks().some((t) => t.readyState === 'live') && !rv.screen.getVideoTracks().some((t) => t.readyState === 'live')) return 'screen';
  return 'camera';
}
function attachRemoteVideo(peerId, media, track) {
  if (!S.voice) return;
  let rv = S.voice.remoteVideo.get(peerId);
  if (!rv) { rv = { camera: new MediaStream(), screen: new MediaStream() }; S.voice.remoteVideo.set(peerId, rv); }
  const ms = media === 'screen' ? rv.screen : rv.camera;
  ms.getVideoTracks().forEach((t) => { if (t.id !== track.id) { try { ms.removeTrack(t); } catch {} } });
  try { if (!ms.getVideoTracks().some((t) => t.id === track.id)) ms.addTrack(track); } catch {}
  track.onended = () => { try { ms.removeTrack(track); } catch {} renderStage(); };
  renderStage();
}
// ---------- voice stage (video grid) ----------
function liveVideoTracks(ms) { return ms ? ms.getVideoTracks().filter((t) => t.readyState === 'live') : []; }
function stageVisible() {
  if (!S.voice) return false;
  if (S.callOpen) return true;
  if (S.voice.cameraOn || S.voice.sharing) return true;
  for (const [, rv] of S.voice.remoteVideo) {
    if (liveVideoTracks(rv.camera).length || liveVideoTracks(rv.screen).length) return true;
  }
  return false;
}
function voicePeerInfo(id) {
  if (id === 'me' || (S.me && id === S.me.id)) {
    return {
      id: S.me.id, display_name: S.me.display_name, username: S.me.username,
      avatar_color: S.me.avatar_color, avatar_url: S.me.avatar_url || null,
      muted: !!S.voice?.muted, deafened: !!S.voice?.deafened,
      camera: !!S.voice?.cameraOn, sharing: !!S.voice?.sharing,
      speaking: !!S.voice?.speaking, me: true,
    };
  }
  const p = (S.voiceOccupancy.get(myVoiceKey()) || []).find((x) => x.id === id);
  return p || { id, display_name: '?', username: '?', avatar_color: '#555', avatar_url: null };
}
function tileStream(key) {
  if (!S.voice) return null;
  if (key === 'me:cam') return S.voice.camStream;
  if (key === 'me:screen') return S.voice.screenStream;
  const [pid, media] = key.split(':');
  const rv = S.voice.remoteVideo.get(pid);
  return rv ? rv[media === 'screen' ? 'screen' : 'camera'] : null;
}
function paintTile(key, el) {
  const [pid, media] = key.split(':');
  const isScreen = media === 'screen';
  const u = voicePeerInfo(pid);
  const ms = tileStream(key);
  const live = liveVideoTracks(ms).length > 0;
  let video = el.querySelector('video');
  let fb = el.querySelector('.vfallback');
  if (live) {
    if (!video) { video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; el.prepend(video); }
    if (video.srcObject !== ms) video.srcObject = ms;
    video.classList.toggle('mirror', key === 'me:cam');
    video.style.display = '';
    if (fb) fb.style.display = 'none';
  } else {
    if (video) video.style.display = 'none';
    if (!fb) {
      fb = document.createElement('div');
      fb.className = 'vfallback';
      fb.innerHTML = '<span class="avatar"></span>';
      paintAvatar(fb.querySelector('.avatar'), u);
      el.prepend(fb);
    }
    fb.style.display = '';
  }
  el.querySelector('.vname').textContent = isScreen ? `${u.display_name}’s screen` : (u.me ? `${u.display_name} (you)` : u.display_name);
  const icons = el.querySelector('.vicons');
  icons.innerHTML = '';
  const badge = (svg, cls, title) => { const s = document.createElement('span'); if (cls) s.className = cls; s.title = title; s.innerHTML = svg; icons.appendChild(s); };
  if (u.deafened) badge(VB_SVG.deaf, '', 'Deafened');
  else if (u.muted) badge(VB_SVG.mic, '', 'Muted');
  if (!isScreen && u.sharing) badge(VB_SVG.share, 'ok', 'Sharing screen');
  el.classList.toggle('speaking', !!u.speaking && !u.muted && !u.deafened);
  el.dataset.vuser = pid === 'me' ? (S.me?.id || 'me') : pid;
}
function renderStage() {
  const stage = $('#stage'), grid = $('#stage-grid');
  if (!stageVisible() || !S.voice) { stage.classList.add('hidden'); return; }
  stage.classList.remove('hidden');
  const full = !!S.callOpen;
  $('#stage-head').classList.toggle('hidden', !full);
  $('#stage-controls').classList.toggle('hidden', !full);
  const occ = S.voiceOccupancy.get(myVoiceKey()) || [];
  const order = ['me:cam'];
  if (S.voice.sharing) order.push('me:screen');
  for (const p of occ) {
    if (p.id === S.me.id) continue;
    order.push(p.id + ':cam');
  }
  for (const p of occ) {
    if (p.id === S.me.id) continue;
    const rv = S.voice.remoteVideo.get(p.id);
    if (rv && liveVideoTracks(rv.screen).length) order.push(p.id + ':screen');
  }
  const want = new Set(order);
  for (const [k, el] of [...S.voice.tiles]) {
    if (!want.has(k)) { el.remove(); S.voice.tiles.delete(k); }
  }
  for (const k of order) {
    let el = S.voice.tiles.get(k);
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      el.className = 'vtile';
      el.dataset.vtile = k;
      el.innerHTML = '<div class="vname"></div><div class="vicons"></div>';
      S.voice.tiles.set(k, el);
      grid.appendChild(el);
    }
    paintTile(k, el);
  }
  updateCallHead();
  fitStage();
}
// Full call view: size tiles to fit the available area — no scrollbar, no giant tiles.
function fitStage() {
  const grid = $('#stage-grid');
  if (!grid) return;
  const n = grid.children.length;
  if (!S.callOpen || !S.voice || !n) { grid.style.gridTemplateColumns = ''; grid.style.justifyContent = ''; return; }
  const gap = 8, W = grid.clientWidth, H = grid.clientHeight;
  if (!W || !H) return;
  // Widest tile that still fits: cap every column layout by the available height.
  let best = null;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const w = Math.min((W - (c - 1) * gap) / c, ((H - (rows - 1) * gap) / rows) * 16 / 9);
    if (w <= 0) continue;
    if (!best || w > best.w) best = { cols: c, w };
  }
  if (!best) return;
  let { cols, w } = best;
  const MIN = 140;
  if (w < MIN) {
    // Tons of people: keep tiles usable and allow the scroll instead.
    cols = Math.max(1, Math.floor((W + gap) / (MIN + gap)));
    w = Math.min(MIN, (W - (cols - 1) * gap) / cols);
  }
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, ${Math.floor(w)}px))`;
  grid.style.justifyContent = 'center';
}
window.addEventListener('resize', () => { try { fitStage(); } catch {} });
// Mobile keyboard: track the visual viewport so the app shell compresses
// instead of panning — top stays anchored, composer + messages slide up.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const syncVV = () => {
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    const ae = document.activeElement;
    if (ae && (ae.id === 'in-message' || ae.id === 'in-thread')) {
      const m = $('#messages');
      if (m) m.scrollTop = m.scrollHeight;
    }
  };
  let vvT = null;
  vv.addEventListener('resize', () => { clearTimeout(vvT); vvT = setTimeout(syncVV, 60); });
  syncVV();
}
const MIC_OFF_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3M2 2l20 20"/></svg>';
// Discord-style: occupants listed under their voice channel, green ring while talking.
function renderVoiceUsers() {
  const d = S.serverDetail;
  if (!d) return;
  for (const c of d.channels.filter((x) => x.type === 'voice')) {
    const box = document.getElementById('vusers-' + c.id);
    if (!box) continue;
    const occ = S.voiceOccupancy.get(c.id) || [];
    box.innerHTML = '';
    for (const p of occ) {
      const u = document.createElement('div');
      u.className = 'vuser' + (p.speaking && !p.muted && !p.deafened ? ' speaking' : '');
      u.dataset.vuser = p.id;
      u.dataset.uid = p.id;
      let stat = '';
      if (p.deafened) stat = '<span class="vstat"><span class="bad" title="Deafened">' + VB_SVG.deaf + '</span></span>';
      else if (p.muted) stat = '<span class="vstat"><span class="bad" title="Muted">' + VB_SVG.mic + '</span></span>';
      else {
        const subs = [];
        if (p.camera) subs.push('<span class="on" title="Camera on">' + VB_SVG.cam + '</span>');
        if (p.sharing) subs.push('<span class="on" title="Sharing screen">' + VB_SVG.share + '</span>');
        if (subs.length) stat = '<span class="vstat">' + subs.join('') + '</span>';
      }
      u.innerHTML = `<span class="avatar"></span><span class="vname">${esc(p.display_name)}${p.id === S.me.id ? ' (you)' : ''}</span>${stat || (p.muted ? '<span class="vmic">' + MIC_OFF_SVG + '</span>' : '')}`;
      paintAvatar(u.querySelector('.avatar'), p);
      box.appendChild(u);
    }
  }
}
function setSpeakingUI(userId, speaking) {
  document.querySelectorAll('[data-vuser="' + CSS.escape(userId) + '"]').forEach((el) => el.classList.toggle('speaking', speaking));
}
// Voice activity detection: local mic level → broadcast speech state so every
// client sees green rings (works for all rooms, not just the one you're in).
let speakTimer = null, speakCtx = null, speakOn = false, speakQuiet = 0;
function startSpeakingMonitor() {
  stopSpeakingMonitor();
  try {
    speakCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = speakCtx.createMediaStreamSource(S.voice.stream);
    const an = speakCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    speakTimer = setInterval(() => {
      if (!S.voice) return;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const lvl = Math.sqrt(sum / buf.length);
      let talking = speakOn;
      if (S.voice.muted || S.voice.deafened) { talking = false; speakQuiet = 0; }
      else if (lvl > 0.09) { talking = true; speakQuiet = 0; }
      else if (speakOn && ++speakQuiet >= 3) { talking = false; speakQuiet = 0; }
      if (talking !== speakOn) {
        speakOn = talking;
        S.voice.speaking = talking;
        setSpeakingUI(S.me.id, talking);
        const occ = S.voiceOccupancy.get(myVoiceKey()) || [];
        const me = occ.find((p) => p.id === S.me.id);
        if (me) me.speaking = talking;
        sendVoiceState();
      }
    }, 200);
  } catch {}
}
function stopSpeakingMonitor() {
  clearInterval(speakTimer); speakTimer = null;
  if (speakOn) { speakOn = false; speakQuiet = 0; if (S.me) setSpeakingUI(S.me.id, false); }
  try { speakCtx?.close(); } catch {}
  speakCtx = null;
}
window.addEventListener('beforeunload', () => { try { S.ws?.send(JSON.stringify({ t: 'voice-leave' })); } catch {} });

