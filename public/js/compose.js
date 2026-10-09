'use strict';
// ---------- voice messages (record → attach → Send) ----------
let recSt = null; // {rec, stream, chunks, t0, timer, cancelled}
const REC_MAX_MS = 5 * 60 * 1000;
function recMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  try {
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  } catch { return ''; }
}
async function startVoiceRec() {
  if (recSt) { toast('Already recording'); return; }
  if (!composerTargetReady()) { toast('Pick a chat first, then record'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone blocked — allow mic access to record'); return; }
  let recStream = stream, noise = null;
  if (noiseSuppressionEnabled()) {
    try { const r = await applyNoiseSuppression(stream); recStream = r.stream; noise = r; }
    catch { recStream = stream; } // fall back to raw mic if RNNoise can't start
  }
  const mt = recMime();
  let rec;
  try { rec = new MediaRecorder(recStream, mt ? { mimeType: mt } : undefined); }
  catch { try { stream.getTracks().forEach((t) => t.stop()); } catch {} try { noise?.stop(); } catch {} toast('Recording is not supported here'); return; }
  recSt = { rec, stream, noise, chunks: [], t0: Date.now(), timer: null, cancelled: false, paused: false, pauseTotal: 0, pauseStart: null };
  rec.ondataavailable = (e) => { if (recSt && e.data && e.data.size) recSt.chunks.push(e.data); };
  rec.onstop = finishVoiceRec;
  try { rec.start(); } catch { cancelVoiceRec(); return; }
  paintRecBar();
  recSt.timer = setInterval(() => {
    if (!recSt) return;
    paintRecTime();
    if (recElapsedMs() >= REC_MAX_MS) stopVoiceRec(); // cap on actual recorded audio (pauses don't count)
  }, 500);
}
function paintRecBar() {
  const bar = $('#rec-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !recSt);
  if (recSt) {
    bar.classList.toggle('paused', !!recSt.paused);
    const pb = $('#rec-pause');
    if (pb) pb.textContent = recSt.paused ? 'Resume' : 'Pause';
    const st = $('#rec-status');
    if (st) st.textContent = recSt.paused ? 'Paused' : 'Recording…';
  }
  paintRecTime();
}
function paintRecTime() {
  const t = $('#rec-time');
  if (t) t.textContent = fmtClock(recSt ? recElapsedMs() / 1000 : 0);
}
// Milliseconds of actual audio recorded so far — paused time does not count.
function recElapsedMs() {
  const st = recSt;
  if (!st) return 0;
  if (st.paused) return (st.pauseStart - st.t0) - st.pauseTotal;
  return (Date.now() - st.t0) - st.pauseTotal;
}
function pauseVoiceRec() {
  if (!recSt || recSt.paused) return;
  try { recSt.rec.pause(); } catch {}
  recSt.paused = true;
  recSt.pauseStart = Date.now();
  paintRecBar();
}
function resumeVoiceRec() {
  if (!recSt || !recSt.paused) return;
  recSt.pauseTotal += Date.now() - recSt.pauseStart;
  recSt.pauseStart = null;
  try { recSt.rec.resume(); } catch {}
  recSt.paused = false;
  paintRecBar();
}
function toggleRecPause() { recSt && recSt.paused ? resumeVoiceRec() : pauseVoiceRec(); }
function stopVoiceRec() {
  if (recSt && !recSt.cancelled) { try { recSt.rec.stop(); } catch {} }
}
function cancelVoiceRec() {
  if (!recSt) return;
  recSt.cancelled = true;
  try { recSt.rec.stop(); } catch { finishVoiceRec(); }
}
function finishVoiceRec() {
  const st = recSt;
  recSt = null;
  if (st) {
    if (st.timer) clearInterval(st.timer);
    try { st.noise?.stop(); } catch {}
    try { st.stream.getTracks().forEach((t) => t.stop()); } catch {}
  }
  paintRecBar();
  if (!st || st.cancelled || !st.chunks.length) return;
  const type = String((st.rec.mimeType || 'audio/webm')).split(';')[0] || 'audio/webm';
  const file = new File(st.chunks, 'voice-message.' + (type === 'audio/mp4' ? 'm4a' : 'webm'), { type });
  if (!composerTargetReady()) { toast('Pick a chat first, then record'); return; }
  uploadAndAttach(file);
  $('#in-message').focus();
}
// ---------- dictation (record → server Whistle → message box) ----------
// Server-side only: the Windows/WebView2 app has no Web Speech API, and this
// way every platform uses the same local transcription with no Google.
let dictSt = null; // {rec, stream, chunks} while recording
let dictBase = ''; // textarea content when dictation started
function paintDictate() {
  const ind = $('#dictate-ind');
  if (ind) {
    ind.classList.toggle('hidden', !dictSt);
    // Tap the pill itself to stop — more obvious than reopening the menu.
    ind.onclick = dictSt ? (e) => { e.stopPropagation(); stopDictate(); } : null;
  }
  const btn = $('#cm-dictate');
  if (btn) btn.classList.toggle('active', !!dictSt);
}
async function toggleDictate() {
  if (dictSt) { stopDictate(); return; }
  if (!composerTargetReady()) { toast('Pick a chat first, then dictate'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone blocked — allow mic access to dictate'); return; }
  const mt = recMime();
  let rec;
  try { rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined); }
  catch {
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    toast('Recording is not supported here');
    return;
  }
  const ta = $('#in-message');
  dictBase = ta ? ta.value : '';
  if (dictBase && !/\s$/.test(dictBase)) dictBase += ' ';
  const prevPh = ta ? ta.placeholder : '';
  dictSt = { rec, stream, chunkN: 0, appended: '', done: false, prevPh, queue: Promise.resolve() };
  const st = dictSt; // closure ref — survives dictSt being nulled on stop
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    // Serialize chunk uploads so text appends in spoken order.
    st.queue = st.queue.then(() => transcribeChunk(e.data, st)).catch(() => {});
  };
  rec.onstop = () => finishDictate(st);
  try { rec.start(3000); } // 3s chunks → near-live transcription
  catch { dictSt = null; try { stream.getTracks().forEach((t) => t.stop()); } catch {} toast('Could not start dictation'); return; }
  paintDictate();
  if (ta) ta.focus();
}
// Transcribe one 3s chunk and append its text live.
async function transcribeChunk(blob, st) {
  if (!st || st.done) return;
  const n = ++st.chunkN;
  try {
    const type = String(blob.type || 'audio/webm').split(';')[0] || 'audio/webm';
    const file = new File([blob], 'chunk-' + n + '.webm', { type });
    const fd = new FormData();
    fd.append('audio', file);
    const headers = store.token ? { 'Authorization': 'Bearer ' + store.token } : {};
    const r = await fetch('/api/dictate', { method: 'POST', body: fd, headers, credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    if (st.done || !j || !j.text) {
      // First chunk failed and gave nothing — surface it once so the user
      // isn't staring at a silent Listening indicator.
      if (n === 1 && !st.warned) {
        st.warned = true;
        const detail = j && j.error ? ' (' + j.error + ')' : ' (HTTP ' + r.status + ')';
        toast(r.status === 401 ? 'Dictation: not signed in?' : "Couldn't transcribe" + detail);
      }
      return;
    }
    const ta = $('#in-message');
    if (ta) {
      st.appended += (st.appended ? ' ' : '') + j.text;
      ta.value = dictBase + st.appended;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch (e) {
    // Chunk failed — skip it, keep recording. Warn once on the first chunk
    // so a broken pipeline isn't silent.
    if (n === 1 && !st.warned) {
      st.warned = true;
      toast("Couldn't reach the transcription server");
    }
  }
}
function stopDictate() {
  const st = dictSt;
  dictSt = null;
  paintDictate();
  if (st) {
    const ta = $('#in-message');
    if (ta) ta.placeholder = 'Transcribing…';
    // Rebind onstop to carry the state — dictSt is already null.
    st.rec.onstop = () => finishDictate(st);
    try { st.rec.stop(); } catch { finishDictate(st); }
  }
}
async function finishDictate(st) {
  // Chunks were transcribed live; the final partial chunk was queued by the
  // last ondataavailable before onstop. Just clean up.
  if (st) st.done = true;
  dictSt = null;
  paintDictate();
  if (st) { try { st.stream.getTracks().forEach((t) => t.stop()); } catch {} }
  const ta = $('#in-message');
  if (ta && ta.placeholder === 'Transcribing…') ta.placeholder = (st && st.prevPh) || '';
}
// ---------- polls ----------
function sendPoll(question, options) {
  question = String(question || '').trim().slice(0, 200);
  options = [...new Set((options || []).map((o) => String(o || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
  if (!question || options.length < 2) return;
  if (!S.ws || S.ws.readyState !== 1) { toast('Reconnecting… try again in a second'); return; }
  if (S.view === 'home') {
    if (!S.dmThreadId) { toast('Pick a chat first'); return; }
    S.ws.send(JSON.stringify({ t: 'dm', threadId: S.dmThreadId, content: question, attachments: [], replyTo: null, poll: { options } }));
    renderDmMessages(true);
  } else {
    if (!S.serverId || !S.channelId) { toast('Pick a chat first'); return; }
    S.ws.send(JSON.stringify({ t: 'message', serverId: S.serverId, channelId: S.channelId, content: question, attachments: [], replyTo: null, threadRoot: null, poll: { options } }));
    renderMessages(true);
  }
}
function openPollModal(q = '', opts = []) {
  const cur = opts.length ? opts : ['', ''];
  openModal('Create a poll', `
    <label>Question<input id="m-poll-q" maxlength="200" placeholder="What should we ask?" value="${esc(q)}" /></label>
    <div id="m-poll-opts" style="margin-top:.6rem;display:flex;flex-direction:column;gap:.4rem">
      ${cur.map((o, i) => `<input class="m-poll-opt" maxlength="60" placeholder="Option ${i + 1}" value="${esc(o)}" />`).join('')}
    </div>
    <div class="row" style="margin-top:.5rem"><button type="button" class="btn small" id="m-poll-add">Add option</button></div>
    <p class="muted small">2–8 options · one vote per person · tap your vote again to take it back</p>
  `, 'Post poll', () => {
    const question = ($('#m-poll-q') || {}).value.trim();
    const options = [...document.querySelectorAll('.m-poll-opt')].map((i) => i.value.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      toast(!question ? 'Ask a question first' : 'Add at least 2 options');
      setTimeout(() => openPollModal(question, [...document.querySelectorAll('.m-poll-opt')].map((i) => i.value)), 0);
      return;
    }
    sendPoll(question, options);
  });
  $('#m-poll-add').onclick = () => {
    const box = $('#m-poll-opts');
    const n = box.querySelectorAll('.m-poll-opt').length;
    if (n >= 8) { toast('Max 8 options'); return; }
    const inp = document.createElement('input');
    inp.className = 'm-poll-opt'; inp.maxLength = 60; inp.placeholder = `Option ${n + 1}`;
    box.appendChild(inp);
    inp.focus();
  };
}

