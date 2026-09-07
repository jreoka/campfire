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
  const mt = recMime();
  let rec;
  try { rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined); }
  catch { try { stream.getTracks().forEach((t) => t.stop()); } catch {} toast('Recording is not supported here'); return; }
  recSt = { rec, stream, chunks: [], t0: Date.now(), timer: null, cancelled: false };
  rec.ondataavailable = (e) => { if (recSt && e.data && e.data.size) recSt.chunks.push(e.data); };
  rec.onstop = finishVoiceRec;
  try { rec.start(); } catch { cancelVoiceRec(); return; }
  paintRecBar();
  recSt.timer = setInterval(() => {
    if (!recSt) return;
    paintRecTime();
    if (Date.now() - recSt.t0 >= REC_MAX_MS) stopVoiceRec(); // cap: auto-finish
  }, 500);
}
function paintRecBar() {
  const bar = $('#rec-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !recSt);
  paintRecTime();
}
function paintRecTime() {
  const t = $('#rec-time');
  if (t) t.textContent = fmtClock(recSt ? (Date.now() - recSt.t0) / 1000 : 0);
}
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

