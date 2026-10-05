// Member-list typing pill: while someone types in the open channel, their
// member-row status dot blooms into a pill with bouncing dots (see the
// .m-typing rules in index.html's <style> block).
//
// Typing state lives in S.typingNames and every change funnels through
// paintTyping() (adds plus the 2.5s-lease removals) or clearTyping() (view
// switches). Both are top-level function declarations, so wrapping them here
// — this script loads after messages.js — keeps the pill perfectly in step
// with the typing strip, with no polling.
//
// The strip deliberately excludes yourself (showTyping returns early for
// S.me.id), but the pill includes you: your own keystrokes are tracked here
// on the same 2.5s lease.
(function () {
  'use strict';

  var selfTypingTimer = 0;

  function syncMemberTyping() {
    if (typeof S === 'undefined' || !S || !(S.typingNames instanceof Map)) return;
    var list = document.getElementById('member-list');
    if (!list) return;
    var typing = {};
    S.typingNames.forEach(function (_, id) { typing[String(id)] = true; });
    if (selfTypingTimer && S.me && S.me.id != null) typing[String(S.me.id)] = true;
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

  function markSelfTyping() {
    if (typeof S === 'undefined' || !S || !S.me) return;
    clearTimeout(selfTypingTimer);
    try { syncMemberTyping(); } catch (e) {}
    selfTypingTimer = setTimeout(function () {
      selfTypingTimer = 0;
      try { syncMemberTyping(); } catch (e) {}
    }, 2600);
  }

  // Your own keystrokes: the channel box and the thread reply box. Delegated
  // so it works no matter when the inputs enter the DOM.
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && (t.id === 'in-message' || t.id === 'in-thread')) markSelfTyping();
  });

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
