// DM list typing pill: while someone types in a DM, their DM row's avatar
// status dot blooms into a pill with bouncing dots — same as the member
// list (see .dmrow.dm-typing in index.html).
//
// DM typing events arrive via the 'dm-typing' socket message. We track them
// per-thread with a 2.5s lease (matching the channel typing behavior).
(function () {
  'use strict';

  var dmTypingTimers = {};

  function syncDmTyping() {
    if (typeof S === 'undefined' || !S) return;
    var rows = document.querySelectorAll('#dm-list .dmrow[data-dmthread], #group-list .dmrow[data-dmthread]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var tid = row.dataset.dmthread;
      var dot = row.querySelector('.avwrap .status-dot');
      if (!dot) continue;
      if (dmTypingTimers[tid]) {
        if (!row.classList.contains('dm-typing')) {
          row.classList.add('dm-typing');
          dot.innerHTML = '<i></i><i></i><i></i>';
        }
      } else if (row.classList.contains('dm-typing')) {
        row.classList.remove('dm-typing');
        dot.innerHTML = '';
      }
    }
  }

  function markDmTyping(threadId) {
    if (!threadId) return;
    var tid = String(threadId);
    if (dmTypingTimers[tid]) clearTimeout(dmTypingTimers[tid]);
    dmTypingTimers[tid] = setTimeout(function () {
      delete dmTypingTimers[tid];
      try { syncDmTyping(); } catch (e) {}
    }, 2600);
    try { syncDmTyping(); } catch (e) {}
  }

  function clearDmTyping() {
    for (var tid in dmTypingTimers) clearTimeout(dmTypingTimers[tid]);
    dmTypingTimers = {};
    try { syncDmTyping(); } catch (e) {}
  }

  // Hook into the dm-typing socket message. The existing handler in socket.js
  // only shows the strip when viewing that thread; we track all DMs here.
  var origOnMessage = null;
  function hookSocket() {
    if (typeof S === 'undefined' || !S || !S.ws) return false;
    // Wrap the message handler if we haven't already
    if (S.ws.__dmTypingHooked) return true;
    S.ws.__dmTypingHooked = true;
    var orig = S.ws.onmessage;
    S.ws.onmessage = function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (m && m.t === 'dm-typing' && m.threadId) {
          markDmTyping(m.threadId);
        }
      } catch (e) {}
      if (orig) return orig.call(this, ev);
    };
    return true;
  }

  // Try to hook immediately, retry until S.ws exists
  if (!hookSocket()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (hookSocket() || ++tries > 50) clearInterval(iv);
    }, 500);
  }

  // Clear on view switches (matches clearTyping behavior)
  if (typeof window.clearTyping === 'function') {
    var origClear = window.clearTyping;
    window.clearTyping = function () {
      clearDmTyping();
      return origClear.apply(this, arguments);
    };
  }

  // Re-sync when DM list re-renders
  if (typeof window.renderDmLists === 'function') {
    var origRender = window.renderDmLists;
    window.renderDmLists = function () {
      var r = origRender.apply(this, arguments);
      try { syncDmTyping(); } catch (e) {}
      return r;
    };
  }
})();
