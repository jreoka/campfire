'use strict';
// ---------- websocket ----------
function sendVisibility() {
  try { S.ws?.send(JSON.stringify({ t: 'visibility', visible: document.visibilityState === 'visible' })); } catch {}
}
// Tell the server when the tab is foregrounded/backgrounded so it stops
// suppressing pushes for hidden/closed mobile tabs.
document.addEventListener('visibilitychange', sendVisibility);
// ---------- connection overlay (full-page "Connecting..." state) ----------
// A themed campfire splash covers the stale app whenever the live socket
// drops, until the server is reachable again. A short grace delay keeps fast
// blips (and the initial boot handshake) from flashing it.
let connTimer = null, connAttempts = 0, connVisible = false, connPingSent = 0, connProbePending = false, connFadeT = null;
function connEl() { return document.getElementById('conn-overlay'); }
function inMainView() { return !document.getElementById('view-main')?.classList.contains('hidden'); }
// The overlay is the animated campfire alone — no copy, no buttons. Only the
// screen-reader label changes with the state.
function paintConn() {
  const el = connEl();
  if (el) el.setAttribute('aria-label', navigator.onLine ? 'Connecting' : 'No connection');
}
function connShow() {
  // Fade in: unhide at opacity 0, then rAF into opacity 1. Clears a
  // pending fade-out so a quick hide→show never snaps or strands hidden.
  const el = connEl();
  if (!el) return;
  if (connFadeT) { clearTimeout(connFadeT); connFadeT = null; }
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.classList.add('show');
}
function connHide() {
  // Fade out, then display:none once the fade lands (guarded on the
  // logical flag so a re-show mid-fade isn't buried by a stale timer).
  const el = connEl();
  if (!el) return;
  el.classList.remove('show');
  if (connFadeT) clearTimeout(connFadeT);
  connFadeT = setTimeout(() => {
    connFadeT = null;
    if (!connVisible) el.classList.add('hidden');
  }, 240);
}
function showConn() {
  if (connVisible) { paintConn(); return; }
  if (!navigator.onLine) {
    // Genuinely offline: the whole app is dead, including sign-in — say so
    // full-screen on whatever view is showing.
    connVisible = true;
    paintConn();
    connShow();
    return;
  }
  if (!store.token || !inMainView()) { paintConn(); return; }
  connVisible = true;
  paintConn();
  connShow();
}
function hideConn() {
  if (connTimer) { clearTimeout(connTimer); connTimer = null; }
  if (!connVisible) return;
  connVisible = false;
  connHide();
}
function armConnSoon() {
  paintConn();
  if (connVisible || connTimer || !store.token || !inMainView()) return;
  // Offline shows instantly (no grace); a dropped socket gets a short grace
  // window so fast blips and the initial boot handshake never flash it.
  const delay = !navigator.onLine ? 0 : (connAttempts <= 1 ? 1200 : 0);
  connTimer = setTimeout(() => { connTimer = null; showConn(); }, delay);
}
// Auth was revoked server-side (bad/expired token): stop the reconnect loop
// and send the user back to sign in instead of spinning forever.
async function connAuthDead() {
  try { if (S.ws) { S.ws.onclose = null; S.ws.onerror = null; } } catch {}
  hideConn();
  let why = '';
  try { await api('/api/me'); return connectWS(); } catch {}
  try { S.ws?.close(); } catch {}
  S.ws = null; S.me = null;
  store.token = ''; store.sid = '';
  try { showAuth(); setMode('login'); } catch {}
  try { toast('Session expired — sign in again'); } catch {}
}
function connectWS() {
  connPingSent = 0; connProbePending = false;
  try { if (S.ws) { S.ws.onclose = null; S.ws.onerror = null; try { S.ws.close(); } catch {} } } catch {}
  if (!store.token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(store.token)}`);
  S.ws = ws;
  ws.onopen = () => { connAttempts = 0; connPingSent = 0; S.lastWsMsg = Date.now(); hideConn(); ws.send(JSON.stringify({ t: 'subscribe' })); sendVisibility(); checkVersion(); };
  ws.onmessage = (ev) => {
    S.lastWsMsg = Date.now(); connPingSent = 0;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onWS(m);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onclose = (ev) => {
    if (ev && ev.code === 4401) { connAuthDead(); return; } // bad token — don't loop
    if (!store.token || S.ws !== ws) return; // logged out or superseded — stay quiet
    connAttempts++;
    armConnSoon();
    // auto-reconnect
    setTimeout(() => { if (store.token && S.ws === ws) connectWS(); }, 2500);
  };
}
window.addEventListener('online', () => {
  paintConn();
  if (store.token && inMainView() && (!S.ws || S.ws.readyState !== 1)) connectWS();
  else if (!store.token || !inMainView()) {
    // offline-only overlay (e.g. sign-in) lifts; the captcha only loads at
    // page load, so a reconnect must kick it off if it never ran
    hideConn();
    try { if (typeof initTurnstile === 'function') initTurnstile(); } catch {}
  }
});
window.addEventListener('offline', () => { showConn(); });
// Cheap reachability probe: fails fast when truly offline, hangs to timeout
// in a packet blackhole. Only used when the socket has gone suspiciously
// quiet — never on a healthy, chatty connection.
function probeServer() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      const c = new AbortController();
      const t = setTimeout(() => { try { c.abort(); } catch {} finish(false); }, 3500);
      fetch('/api/version', { cache: 'no-store', signal: c.signal })
        .then((r) => { clearTimeout(t); finish(r.ok); })
        .catch(() => { clearTimeout(t); finish(false); });
    } catch { finish(false); }
  });
}
// Connectivity watchdog: the safety net under the socket events above.
// - Some disconnects never fire onclose (half-open TCP looks OPEN forever,
//   a reconnect stuck in CONNECTING fires nothing). Poll the actual state.
// - Some environments never fire window offline/online reliably. Poll that too.
// - An OPEN socket gone quiet gets one app-level ping plus an HTTP probe in
//   parallel: a failed probe means the network is gone (overlay at once),
//   an unanswered ping means just the socket died — either way close it so
//   onclose runs the reconnect flow. Worst case ~15s, no refresh needed.
setInterval(() => {
  try {
    if (!navigator.onLine) { showConn(); return; }
    if (!store.token || !inMainView()) return;
    const ws = S.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) { armConnSoon(); return; }
    if (connPingSent && Date.now() - connPingSent > 6000) {
      // Pinged but nothing came back (not even our pong) — socket is dead.
      connPingSent = 0; connProbePending = false;
      paintConn(); showConn();
      try { ws.close(); } catch {}
      return;
    }
    const idle = Date.now() - (S.lastWsMsg || 0);
    if (idle > 10000 && !connPingSent && !connProbePending) {
      connPingSent = Date.now();
      try { ws.send(JSON.stringify({ t: 'ping' })); } catch { try { ws.close(); } catch {} return; }
      connProbePending = true;
      probeServer().then((ok) => {
        connProbePending = false;
        if (ok || S.ws !== ws) return; // network fine, or socket already superseded
        if (!store.token || !inMainView()) return;
        connPingSent = 0;
        paintConn(); showConn();
        try { ws.close(); } catch {}
      });
    }
  } catch {}
}, 3000);
function scrubReplyPreview(deletedId) {
  // A deleted message's text must not linger in the reply-quote previews of
  // messages that quoted it. Fresh history loads already come back scrubbed
  // (server emits deleted:true with an empty snippet); this clears live
  // caches so open clients see the placeholder immediately.
  const scrub = (m) => {
    if (m && m.replyTo && m.replyTo.id === deletedId) {
      m.replyTo = { id: deletedId, author: 'deleted', snippet: '', deleted: true };
    }
  };
  for (const [, arr] of S.messages) arr.forEach(scrub);
  for (const [, arr] of S.dmMessages) arr.forEach(scrub);
  if (S.thread) {
    if (S.thread.root) scrub(S.thread.root);
    (S.thread.replies || []).forEach(scrub);
  }
}
function onWS(m) {
  switch (m.t) {
    case 'hello': {
      S.me = m.user;
      // deploys drop + re-establish every WS: version mismatch here means an
      // update landed while the tab was open — prompt immediately, no waiting
      if (m.version && S.bootVersion && m.version !== S.bootVersion && !S.updateReady) onUpdateReady();
      else if (m.version && !S.bootVersion) S.bootVersion = m.version;
      break;
    }
    case 'message-new': {
      const msg = m.message;
      // Background unread: a normal message from someone else in a channel the
      // reader is not looking at (another server, another channel, or a hidden
      // tab) earns that channel's dot. Thread replies have their own surface.
      if (msg && !msg.sys && !msg.threadRoot) {
        const mine = !!(msg.user && S.me && msg.user.id === S.me.id);
        const viewing = m.serverId === S.serverId && m.channelId === S.channelId && !document.hidden;
        if (!mine && !viewing) { try { markChanUnread(m.serverId, m.channelId); } catch {} }
      }
      if (m.serverId !== S.serverId) break;
      const dnd = S.me && S.me.status === 'dnd';
      if (msg.threadRoot) {
        updateMsgInCaches(msg.threadRoot, (r) => { r.threadCount = (r.threadCount || 0) + 1; });
        // Thread replies don't change the channel list itself — just patch
        // the root's reply-count link in place (no rebuild, no scroll jump).
        if (m.channelId === S.channelId) paintThreadCount(msg.threadRoot);
        if (S.thread && S.thread.rootId === msg.threadRoot) {
          S.thread.replies.push(msg);
          trimLiveTail(S.thread.replies); // renderThread rebuilds, so no DOM prune needed
          renderThread(true);
          if (document.hidden && !dnd) notifyMsg(msg);
        }
      } else {
        const inHist = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
        if (inHist) {
          // viewing older messages: hold the window, count up the jump pill
          if (!msg.sys) {
            S.histNew++;
            updatePill();
            if (!dnd) sfx.msg();
            if (document.hidden && !dnd) notifyMsg(msg);
          }
          break;
        }
        const arr = S.messages.get(m.channelId) || [];
        arr.push(msg);
        const dropOld = trimLiveTail(arr);
        S.messages.set(m.channelId, arr);
        if (m.channelId === S.channelId) {
          // Incremental append keeps every existing avatar <img> untouched
          // (full rebuilds flash them in Safari); fall back if not live-tail.
          if (!appendLiveMessage($('#messages'), arr, msg)) renderMessages();
          else if (dropOld) pruneLiveTop($('#messages'), dropOld);
          if (!msg.sys && document.hidden && !dnd) notifyMsg(msg);
          else if (!msg.sys && !document.hidden && !dnd && mentionsMe(msg)) sfx.msg();
        } else if (!msg.sys && !dnd) {
          sfx.msg();
        }
      }
      break;
    }
    case 'message-updated': {
      updateMsgInCaches(m.message.id, (old) => Object.assign(old, m.message));
      const inHistUp = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      if (m.channelId === S.channelId && !inHistUp) renderMessages();
      if (S.thread && (S.thread.rootId === m.message.id || S.thread.replies.some((r) => r.id === m.message.id))) renderThread();
      break;
    }
    case 'reaction-update': {
      updateMsgInCaches(m.messageId, (old) => {
        old.reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: (r.users || []).includes(S.me.id), users: r.users || [] }));
      });
      try { if (typeof reactionDetailCache !== 'undefined') reactionDetailCache.delete(m.messageId); } catch {}
      const inHistRx = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      // Patch the one reaction bar in place — a full list rebuild jumps the
      // scroll on Safari for a change that touches a single element.
      if (m.channelId === S.channelId && !inHistRx && !patchMessageReactions(m.messageId, $('#messages'))) renderMessages();
      if (S.thread && (S.thread.rootId === m.messageId || S.thread.replies.some((r) => r.id === m.messageId))) {
        if (!patchMessageReactions(m.messageId, $('#thread-replies'))) renderThread();
      }
      break;
    }
    case 'message-deleted': {
      const prev = S.messages.get(m.channelId) || [];
      const arr = prev.filter((x) => x.id !== m.messageId);
      S.messages.set(m.channelId, arr);
      scrubReplyPreview(m.messageId);
      // A deleted reply drops the root's live reply count (drives the N-replies link).
      if (m.threadRoot) updateMsgInCaches(m.threadRoot, (r) => { r.threadCount = Math.max(0, (r.threadCount || 1) - 1); });
      if (S.thread) {
        if (S.thread.rootId === m.messageId) closeThread();
        else if (S.thread.replies.some((x) => x.id === m.messageId)) {
          S.thread.replies = S.thread.replies.filter((x) => x.id !== m.messageId);
          // Surgical panel removal (same no-jump rationale as the channel
          // list below); the panel is tiny so a fallback rebuild is harmless.
          if (!removeMessageNode($('#thread-replies'), S.thread.replies, m.messageId)) renderThread();
        }
        // Else: unrelated to the open thread — leave the panel alone
        // (it used to rebuild here on every channel delete).
      }
      const inHistDel = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      if (m.channelId === S.channelId && !inHistDel) {
        const box = $('#messages');
        if (m.threadRoot) paintThreadCount(m.threadRoot);
        // Surgical single-node removal keeps every image/avatar node (and
        // the reader's scroll place) intact. A full rebuild here recreates
        // every image at 0 height and can strand the reader scrolled up at
        // earlier messages — most visibly when deleting the latest message
        // with an image. Rebuild only as fallback.
        let patched = false;
        try { patched = removeMessageNode(box, arr, m.messageId); } catch { patched = false; }
        if (!patched && !m.threadRoot) renderMessages();
        else if (!patched) { try { updatePill(); } catch {} }
      }
      break;
    }
    case 'dm-new': {
      const msg = m.message;
      const inHistDm = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === msg.threadId;
      let dmDrop = 0;
      if (!inHistDm) {
        const arr = S.dmMessages.get(msg.threadId) || [];
        arr.push(msg);
        dmDrop = trimLiveTail(arr);
        S.dmMessages.set(msg.threadId, arr);
      }
      const ddnd = S.me && S.me.status === 'dnd';
      const own = !!(msg.user && S.me && msg.user.id === S.me.id);
      if (S.view === 'home' && S.dmThreadId === msg.threadId) {
        if (inHistDm) {
          // viewing older messages: hold the window, count up the jump pill
          if (!msg.sys) {
            S.histNew++;
            updatePill();
            if (!ddnd && !own) sfx.msg();
            if (document.hidden && !ddnd) notifyMsg(msg);
          }
        } else {
          if (!appendLiveMessage($('#messages'), S.dmMessages.get(msg.threadId) || [], msg)) renderDmMessages();
          else if (dmDrop) pruneLiveTop($('#messages'), dmDrop);
          if (!msg.sys && document.hidden && !ddnd) notifyMsg(msg);
        }
        // Keep the DM/group list preview fresh — e.g. the first message sent
        // while viewing a freshly created chat would otherwise show
        // "No messages yet" until a manual refresh.
        refreshDms();
      } else if (!msg.sys && !own) {
        // background thread: count up the DM row + home button badges (no popup)
        S.dmUnread.set(msg.threadId, (S.dmUnread.get(msg.threadId) || 0) + 1);
        refreshDms();
        paintHomeBadge();
        if (!ddnd) sfx.msg();
      } else {
        refreshDms();
      }
      break;
    }
    case 'dm-updated': {
      updateMsgInCaches(m.message.id, (old) => Object.assign(old, m.message));
      const inHistDu = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === m.message.threadId;
      if (S.view === 'home' && S.dmThreadId === m.message.threadId && !inHistDu) renderDmMessages();
      break;
    }
    case 'dm-deleted': {
      const darr = (S.dmMessages.get(m.threadId) || []).filter((x) => x.id !== m.messageId);
      S.dmMessages.set(m.threadId, darr);
      scrubReplyPreview(m.messageId);
      const inHistDd = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === m.threadId;
      if (S.view === 'home' && S.dmThreadId === m.threadId && !inHistDd) {
        // Surgical removal (see message-deleted above); rebuild only as fallback.
        let dpatched = false;
        try { dpatched = removeMessageNode($('#messages'), darr, m.messageId); } catch { dpatched = false; }
        if (!dpatched) renderDmMessages();
      }
      break;
    }
    case 'dm-reaction': {
      updateMsgInCaches(m.messageId, (old) => {
        old.reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: (r.users || []).includes(S.me.id), users: r.users || [] }));
      });
      try { if (typeof reactionDetailCache !== 'undefined') reactionDetailCache.delete(m.messageId); } catch {}
      const inHistDr = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === m.threadId;
      // Same in-place patch as channel reactions (see reaction-update).
      if (S.view === 'home' && S.dmThreadId === m.threadId && !inHistDr && !patchMessageReactions(m.messageId, $('#messages'))) renderDmMessages();
      break;
    }
    case 'pins-changed':
      if (m.serverId === S.serverId && m.channelId === S.channelId) {
        refreshPinsCount();
        if (S.pinsCtx && S.pinsCtx.kind === 'server' && S.pinsCtx.id === m.channelId) renderPinsList();
      }
      break;
    case 'dm-pins-changed':
      if (S.view === 'home' && S.dmThreadId === m.threadId) {
        refreshPinsCount();
        if (S.pinsCtx && S.pinsCtx.kind === 'dm' && S.pinsCtx.id === m.threadId) renderPinsList();
      }
      break;
    // Another device on this account read a conversation's pins: the badge has
    // to go away here too (see applyPinSeenRemote).
    case 'pin-seen':
      try { applyPinSeenRemote({ [m.ctx]: { ids: m.ids, at: m.at } }); } catch {}
      break;
    case 'dm-threads-changed':
      // Refresh everywhere (not just on Home): a thread left/closed/created
      // on another device must vanish/appear here too, even mid-server-view.
      // If the currently open thread is gone (left, removed, dismissed),
      // drop back to a blank instead of showing a ghost room.
      refreshDms().then(() => {
        if (S.view !== 'home') { rememberView(); return; }
        if (S.dmThreadId && !S.dms.some((t) => t.id === S.dmThreadId)) { S.dmThreadId = null; renderDmBlank(); rememberView(); rememberHomeTab(); }
        else {
          // Repaint the header too: a rename / new description from another
          // device (or our own group settings modal) must reach #chan-name.
          if (S.dmThreadId) paintDmHead(S.dms.find((t) => t.id === S.dmThreadId));
          renderDmMembers();
        }
      });
      break;
    case 'friends-changed':
      // Always refresh so the home button badge (pending requests) stays
      // correct even when looking at a server; no popup.
      refreshFriends();
      break;
    // ---- stories ----
    case 'story-new':
      // Someone posted: pull the tray list again (coalesced) and repaint the
      // rails. A server post only matters while that server is open.
      scheduleStoryRefresh(400);
      break;
    case 'story-deleted':
      storyRemoved(m.storyId);
      break;
    case 'story-viewed':
      storyViewsUpdated(m.storyId, m.views);
      break;
    case 'story-reaction':
      // Quick reactions: update every tray (and the open viewer) from the full
      // tally the server sends, and float the emoji if we are watching it.
      storyReactionPush(m);
      break;
    case 'dm-typing':
      if (S.view === 'home' && S.dmThreadId === m.threadId) showTyping(m.userId, m.display_name);
      break;
    case 'channel-new':
      if (m.channel.server_id === S.serverId) { S.serverDetail.channels.push(m.channel); renderChannels(); }
      break;
    case 'channel-deleted':
      if (m.serverId === S.serverId) {
        S.serverDetail.channels = S.serverDetail.channels.filter((c) => c.id !== m.channelId);
        renderChannels();
        if (S.chanSet && S.chanSet.cid === m.channelId) closeChannelSettings();
        if (S.channelId === m.channelId) selectChannel((S.serverDetail.channels.find((c) => c.type === 'text') || {}).id);
      }
      break;
    case 'presence':
      Object.assign(S.presenceAll, m.online || {});
      if (m.serverId === S.serverId) { S.online = m.online || {}; S.online[S.me.id] = S.me.status || 'online'; }
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      repaintFriendsIfVisible();
      break;
    // Friends' voice rooms (Active Now rail). Friend-scoped + full-map replace,
    // so a dropped frame can never strand a stale IN VOICE row.
    case 'friends-voice':
      S.friendsVoice = new Map(Object.entries(m.voice || {}));
      if (S.view === 'home') { try { renderActiveNow(); } catch {} }
      break;
    case 'user-online':
      S.presenceAll[m.userId] = m.status || 'online';
      if (m.serverId === S.serverId) S.online[m.userId] = m.status || 'online';
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      repaintFriendsIfVisible();
      break;
    case 'user-offline':
      delete S.presenceAll[m.userId];
      if (m.serverId === S.serverId) delete S.online[m.userId];
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      repaintFriendsIfVisible();
      break;
    case 'user-status':
      if (m.status === 'invisible') delete S.presenceAll[m.userId];
      else S.presenceAll[m.userId] = m.status;
      if (m.serverId === S.serverId) {
        if (m.status === 'invisible') delete S.online[m.userId];
        else S.online[m.userId] = m.status;
      }
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      repaintFriendsIfVisible();
      break;
    // Site-admin Overview: live online/session counts pushed by the server on
    // every connect/disconnect/status flip, so the panel needs no refresh.
    case 'admin-presence': {
      if (typeof adminPresence === 'function') adminPresence(m.online, m.sessions);
      break;
    }
    // Message reports: move the badge (tab + rail dot), and keep an open
    // Reports pane current without a manual refresh.
    case 'report-new': {
      if (typeof paintAdminReportBadge === 'function') paintAdminReportBadge(m.openReports || 0);
      if (typeof adminTabIs === 'function' && adminConsoleOpen() && adminTabIs('reports')) loadAdminReports();
      if (m.report) toast('New report · ' + (m.report.reasonLabel || 'Report'));
      break;
    }
    case 'report-updated': {
      if (typeof paintAdminReportBadge === 'function') paintAdminReportBadge(m.openReports || 0);
      if (typeof adminTabIs === 'function' && adminConsoleOpen() && adminTabIs('reports')) loadAdminReports();
      break;
    }
    case 'user-updated': {
      const u = m.user;
      // Message rows render live identity (name / avatar / name colors) via
      // liveUserFor — snapshot those BEFORE merging so a rebuild happens only
      // when something chat-visible actually changed. Game beacons hit this
      // path every ~15s per gaming user and must NOT rebuild the whole list
      // (each rebuild risks nudging scrolled-up readers). Member list, DM
      // rows and cards below still update every time.
      const rowKeys = ['display_name', 'avatar_url', 'avatar_color', 'name_color', 'name_gradient', 'card_color', 'card_gradient', 'avatar_decoration', 'active_tag', 'active_tag_server_id'];
      const snapRow = (o) => (o ? rowKeys.map((k) => String(o[k] ?? '')) : []);
      const snapRows = () => [
        u.id === S.me?.id ? snapRow(S.me) : [],
        snapRow((S.serverDetail?.members || []).find((x) => x.id === u.id)),
        ...(S.dms || []).map((t) => snapRow((t.members || []).find((x) => x.id === u.id))),
      ].join('￾');
      const rowsBefore = snapRows();
      if (u.id === S.me.id) { S.me = { ...S.me, ...u }; paintMe(); }
      const mem = (S.serverDetail?.members || []).find((x) => x.id === u.id);
      if (mem) Object.assign(mem, u);
      for (const t of S.dms) {
        const dm = (t.members || []).find((x) => x.id === u.id);
        if (dm) Object.assign(dm, u);
      }
      for (const k of ['friends', 'pendingIn', 'pendingOut', 'blocked']) {
        const fr = (S.friends[k] || []).find((x) => x.id === u.id);
        if (fr) Object.assign(fr, u);
      }
      // Voice occupants are separate ephemeral objects — sync the tag so
      // call tiles update without rejoining.
      try {
        for (const list of (S.voiceOccupancy || new Map()).values()) {
          const p = (list || []).find((x) => x && x.id === u.id);
          if (p) { p.display_name = u.display_name; p.avatar_url = u.avatar_url || null; p.active_tag = u.active_tag || null; }
        }
      } catch {}
      if (u.username) activeGaming.delete(u.username);
      renderMembers();
      if (S.view === 'home') {
        renderDmMembers();
        // Streaming flips + friend profile changes land here: keep the
        // friends list and Active Now rail live without a manual refresh.
        try { renderFriendLists(); } catch {}
        try { renderActiveNow(); } catch {}
      }
      if (S.channelId && snapRows() !== rowsBefore) renderMessages();
      break;
    }
    case 'server-updated': {
      const si = S.servers.findIndex((s) => s.id === m.server.id);
      if (si >= 0) S.servers[si] = { ...S.servers[si], ...m.server };
      if (m.server.id === S.serverId) {
        const keepChan = S.channelId;
        S.serverDetail = m.server;
        $('#server-name').textContent = m.server.name;
        renderServerHeader();
        renderTopic();
        if (!m.server.channels.find((c) => c.id === keepChan)) S.channelId = (m.server.channels.find((c) => c.type === 'text') || {}).id || null;
        renderServerList(); renderChannels(); renderMembers();
        paintSlowmodeHint();
        // Channel settings shows the open channel's fields — refresh them on
        // the General tab, but leave the Webhooks tab alone so typing a new
        // webhook name/URL is never wiped by background updates.
        if (S.chanSet && S.chanSet.sid === m.server.id && (S.chanSetTab || 'general') === 'general' && !$('#chan-settings-backdrop')?.classList.contains('hidden')) renderChanSettings();
        if (S.channelId && S.channelId !== keepChan) selectChannel(S.channelId);
      } else renderServerList();
      break;
    }
    case 'emoji-updated':
      // refresh the cross-server union (any joined server's emoji is now
      // renderable/reactable everywhere) and keep the current server's list
      refreshAllEmojis().catch(() => {});
      if (m.serverId === S.serverId) {
        S.emoji = {};
        for (const e of m.emoji || []) S.emoji[e.name] = e.url;
        if (S.channelId) renderMessages();
      }
      break;
    case 'typing':
      if (m.channelId === S.channelId) showTyping(m.userId, m.display_name);
      break;
    case 'member-left':
      if (m.serverId === S.serverId) selectServer(S.serverId);
      break;
    case 'removed-from-server':
      if (S.voice && S.voice.serverId === m.serverId) leaveVoice(true);
      toast(m.reason === 'banned' ? 'You were banned from a server' : 'You were kicked from a server');
      S.ws?.send(JSON.stringify({ t: 'subscribe' }));
      refreshServers();
      break;
    case 'removed-from-dm':
      if (S.dmThreadId === m.threadId) { S.dmThreadId = null; renderDmBlank(); rememberView(); rememberHomeTab(); }
      refreshDms();
      toast('You were removed from a group chat');
      break;
    case 'server-deleted':
      toast('Server was deleted'); refreshServers(); break;
    case 'invites-changed':
      if (S.srvSetId === m.serverId && !$('#srv-settings-backdrop')?.classList.contains('hidden')) renderServerTab();
      break;
    case 'notif-new':
      paintNotifBadge(m.unread || 0);
      break;
    case 'dm-call-incoming':
      onDmCallIncoming(m);
      break;
    case 'dm-call-ended':
      onDmCallEnded(m.threadId);
      break;
    // ---- voice ----
    case 'voice-peers': {
      if (m.threadId) {
        // DM call occupancy (also arrives when we're not in the call — drives badges)
        const key = 'dm:' + m.threadId;
        S.voiceOccupancy.set(key, m.peers);
        if ((m.peers || []).length) { if (!S.voiceSince.has(key)) S.voiceSince.set(key, Date.now()); }
        else S.voiceSince.delete(key);
        if (S.voice && S.voice.kind === 'dm' && S.voice.threadId === m.threadId) {
          onVoicePeers(m.peers);
          renderStage();
        }
        try { renderDmLists(); } catch {}
        if (S.view === 'home' && S.dmThreadId === m.threadId) { try { renderDmMembers(); } catch {} }
        break;
      }
      S.voiceOccupancy.set(m.channelId, m.peers);
      if ((m.peers || []).length) { if (!S.voiceSince.has(m.channelId)) S.voiceSince.set(m.channelId, Date.now()); }
      else S.voiceSince.delete(m.channelId);
      if (m.serverId === S.serverId) renderChannels();
      else renderVoiceUsers();
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) {
        onVoicePeers(m.peers);
        renderStage();
      }
      break;
    }
    case 'voice-peer-joined': {
      if (m.threadId) {
        dmPeerJoined(m.threadId, m.peer);
        if (S.voice && S.voice.kind === 'dm' && S.voice.threadId === m.threadId) {
          ensurePeer(m.peer.id, false); // existing member: wait for offer
          sfx.join();
          renderStage();
        }
        try { renderDmLists(); } catch {}
        if (S.view === 'home' && S.dmThreadId === m.threadId) { try { renderDmMembers(); } catch {} }
        break;
      }
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) {
        ensurePeer(m.peer.id, false); // existing member: wait for offer
        sfx.join();
      } else {
        // update occupancy cache so channel counts refresh on next voice-peers
        S.ws.send(JSON.stringify({ t: 'subscribe' }));
      }
      renderVoiceUsers();
      renderStage();
      break;
    }
    case 'voice-peer-left': {
      if (m.threadId) {
        dmPeerLeft(m.threadId, m.userId);
        if (S.voice && S.voice.kind === 'dm' && S.voice.threadId === m.threadId) {
          closePeer(m.userId);
          sfx.leave();
          renderStage();
        }
        try { renderDmLists(); } catch {}
        if (S.view === 'home' && S.dmThreadId === m.threadId) { try { renderDmMembers(); } catch {} }
        break;
      }
      closePeer(m.userId);
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) sfx.leave();
      renderVoiceUsers();
      renderStage();
      break;
    }
    case 'voice-state': {
      if (m.threadId) {
        const occ = S.voiceOccupancy.get('dm:' + m.threadId) || [];
        const p = occ.find((x) => x.id === m.userId);
        if (p) { p.muted = m.muted; p.speaking = !!m.speaking; p.deafened = !!m.deafened; p.camera = !!m.camera; p.sharing = !!m.sharing; p.serverMuted = !!m.serverMuted; p.streamName = m.streamName || null; }
        if (S.voice && S.voice.kind === 'dm' && S.voice.threadId === m.threadId) renderStage();
        break;
      }
      const occ = S.voiceOccupancy.get(m.channelId) || [];
      const p = occ.find((x) => x.id === m.userId);
      if (p) { p.muted = m.muted; p.speaking = !!m.speaking; p.deafened = !!m.deafened; p.camera = !!m.camera; p.sharing = !!m.sharing; p.serverMuted = !!m.serverMuted; p.streamName = m.streamName || null; }
      if (m.serverId === S.serverId) renderVoiceUsers();
      if (S.voice && S.voice.channelId === m.channelId) renderStage();
      break;
    }
    case 'voice-mod': {
      // An admin muted/unmuted me: enforce it locally (a server mute can't
      // be lifted with the mic button until an admin clears it).
      if (!S.voice) break;
      const mine = m.threadId
        ? (S.voice.kind === 'dm' && S.voice.threadId === m.threadId)
        : (S.voice.kind !== 'dm' && S.voice.channelId === m.channelId);
      if (!mine) break;
      if (m.action === 'muted') {
        S.voice.muted = true;
        S.voice.serverMuted = true;
        applyMicState();
        sendVoiceState();
        paintVoiceControls();
        renderVoiceUsers();
        renderStage();
        toast('An admin muted you');
      } else if (m.action === 'unmuted') {
        S.voice.serverMuted = false;
        sendVoiceState();
        paintVoiceControls();
        renderStage();
        toast('An admin unmuted you — unmute when ready');
      }
      break;
    }
    case 'voice-signal':
      if (m.threadId) {
        if (!S.voice || S.voice.kind !== 'dm' || S.voice.threadId !== m.threadId) break;
      } else if (S.voice && S.voice.kind === 'dm') break; // stale server signal while in a DM call
      onVoiceSignal(m.from, m.data);
      break;
    case 'voice-kicked':
      if (m.threadId) {
        if (S.voice && S.voice.kind === 'dm' && S.voice.threadId === m.threadId) { leaveVoice(); toast(m.reason === 'mod' ? 'An admin disconnected you from the call' : 'You were removed from the call'); }
        break;
      }
      if (S.voice && S.voice.channelId === m.channelId) { leaveVoice(); toast(m.reason === 'mod' ? 'An admin disconnected you from voice' : 'Voice room was deleted'); }
      break;
    case 'error':
      toast(m.error === 'slow_mode' && m.retryAfter ? `Slow mode — wait ${m.retryAfter}s` : prettyError(m.error));
      break;
  }
}
function chanName(id) {
  return (S.serverDetail?.channels.find((c) => c.id === id) || {}).name || 'chat';
}
function notifyMsg(m) {
  if (!m.user) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  sfx.msg();
  try { new Notification(m.threadId ? `${m.user.display_name} (DM)` : `${m.user.display_name} (#${chanName(m.channelId)})`, { body: (m.content || '[attachment]').slice(0, 120) }); } catch {}
}
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', function once() {
    Notification.requestPermission().catch(() => {});
    document.removeEventListener('click', once);
  });
}

