'use strict';
/* RNNoise (simple-rnnoise-wasm) microphone noise suppression.
 * Turns a raw getUserMedia mic stream into a denoised stream by routing it
 * through an AudioWorklet that runs RNNoise inference. Used for both live
 * voice calls (outbound audio) and voice-message recordings.
 * Files vendored at /vendor/rnnoise/ (rnnoise.worklet.js + rnnoise.wasm).
 */
let _rnModuleP = null;
function _rnModule() {
  return _rnModuleP || (_rnModuleP = fetch('/vendor/rnnoise/rnnoise.wasm')
    .then((r) => { if (!r.ok) throw new Error('rnnoise wasm ' + r.status); return r.arrayBuffer(); })
    .then((b) => WebAssembly.compile(b)));
}
function noiseSuppressionEnabled() {
  // Default on. localStorage stores '0' to disable.
  return localStorage.getItem('cf_nn') !== '0';
}
function setNoiseSuppression(on) {
  localStorage.setItem('cf_nn', on ? '1' : '0');
}
// Apply RNNoise to a live mic stream. Returns { stream: denoisedMediaStream, stop() }.
async function applyNoiseSuppression(micStream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 48000 }); // RNNoise is trained at 48kHz
  await ctx.audioWorklet.addModule('/vendor/rnnoise/rnnoise.worklet.js');
  const mod = await _rnModule();
  const node = new AudioWorkletNode(ctx, 'rnnoise', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCountMode: 'explicit', channelCount: 1, channelInterpretation: 'speakers',
    processorOptions: { module: mod },
  });
  const src = ctx.createMediaStreamSource(micStream);
  const dest = ctx.createMediaStreamDestination();
  src.connect(node);
  node.connect(dest);
  return {
    stream: dest.stream,
    node,
    ctx,
    stop() {
      try { src.disconnect(); } catch {}
      try { node.disconnect(); } catch {}
      try { dest.disconnect(); } catch {}
      try { ctx.close(); } catch {}
    },
  };
}
