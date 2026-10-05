// Member-list typing pill: while someone types in the open channel, their
// member-row status dot blooms into a pill with bouncing dots (see the
// .m-typing rules in index.html's <style> block).
//
// Typing state lives in S.typingNames and every change funnels through
// paintTyping() (adds plus the 2.5s-lease removals) or clearTyping() (view
// switches). Both are top-level function declarations, so wrapping them here
// — this script loads after messages.js — keeps the pill perfectly in step
// with the typing strip, with no polling.
(function () {
  'use strict';

  function syncMemberTyping() {
    if (typeof S === 'undefined' || !S || !(S.typingNames instanceof Map)) return;
    var list = document.getElementById('member-list');
    if (!list) return;
    var typing = {};
    S.typingNames.forEach(function (_, id) { typing[String(id)] = true; });
    var rows = list.querySelectorAll('.member[data-uid]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var dot = row.querySelector('.avwrap .status-dot');
      if (!dot) continue;
      if (typing[String(row.dataset.uid)]) {
        if (!row.classList.contains('m-typing')) {
          row.classList.add('m-typing');
          dot.innerHTML = '<i></i><i></i><i></i>';
        }
      } else if (row.classList.contains('m-typing')) {
        row.classList.remove('m-typing');
        dot.innerHTML = '';
      }
    }
  }

  function wrap(name) {
    try {
      var orig = window[name];
      if (typeof orig !== 'function' || orig.__mTypingWrapped) return;
      var wrapped = function () {
        var r = orig.apply(this, arguments);
        try { syncMemberTyping(); } catch (e) {}
        return r;
      };
      wrapped.__mTypingWrapped = true;
      window[name] = wrapped;
    } catch (e) {}
  }

  wrap('paintTyping');
  wrap('clearTyping');
})();
