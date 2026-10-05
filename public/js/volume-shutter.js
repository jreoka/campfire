// Volume-button shutter — Android app only.
//
// The native shell dispatches a `cf-volume-shutter` event on window when a
// volume key goes down while the shutter is armed (see MainActivity.kt). A
// press maps to a shutter tap: down, then up quickly, staying under the
// 220 ms hold threshold so it takes a photo. storyShutterDown's own guards
// make this a no-op unless the story camera is on its capture step.
//
// Arming: the page tells the shell when the camera's capture step is live,
// through the CampfireNative bridge, so volume keys keep working normally
// everywhere else. Polled — the composer opens and closes through many
// paths, and a 500 ms poll that only calls out on change is cheaper and
// sturdier than hooking them all. Inert in browsers (no bridge, no events).
(function () {
  'use strict';

  var armed = false;

  function setArmed(want) {
    if (want === armed) return;
    armed = want;
    try {
      var b = window.CampfireNative;
      if (b && typeof b.setVolumeShutterArmed === 'function') b.setVolumeShutterArmed(want);
    } catch (e) {}
  }

  function cameraLive() {
    try {
      return typeof sc !== 'undefined' && !!sc && sc.step === 'capture' && !!sc.camReady;
    } catch (e) { return false; }
  }

  setInterval(function () { setArmed(cameraLive()); }, 500);

  window.addEventListener('cf-volume-shutter', function () {
    try {
      if (typeof storyShutterDown !== 'function' || typeof storyShutterUp !== 'function') return;
      storyShutterDown();
      setTimeout(function () { try { storyShutterUp(); } catch (e) {} }, 120);
    } catch (e) {}
  });
})();
