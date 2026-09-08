'use strict';
// ---------- websocket ----------
function sendVisibility() {
  try { S.ws?.send(JSON.stringify({ t: 'visibility', visible: document.visibilityState === 'visible' })); } catch {}
}
// Tell the server when the tab is foregrounded/backgrounded so it stops
// suppressing pushes for hidden/closed mobile tabs.
document.addEventListener('visibilitychange', sendVisibility);
function connectWS() {
  S.ws?.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(store.token)}`);
  S.ws = ws;
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'subscribe' })); sendVisibility(); checkVersion(); };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onWS(m);
  };
  ws.onclose = () => {
    // auto-reconnect
    setTimeout(() => { if (store.token) connectWS(); }, 2500);
  };
}
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
      if (m.serverId !== S.serverId) break;
      const msg = m.message;
      const dnd = S.me && S.me.status === 'dnd';
      if (msg.threadRoot) {
        updateMsgInCaches(msg.threadRoot, (r) => { r.threadCount = (r.threadCount || 0) + 1; });
        if (m.channelId === S.channelId) renderMessages();
        if (S.thread && S.thread.rootId === msg.threadRoot) {
          S.thread.replies.push(msg);
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
        S.messages.set(m.channelId, arr);
        if (m.channelId === S.channelId) {
          renderMessages();
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
        old.reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: (r.users || []).includes(S.me.id) }));
      });
      const inHistRx = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      if (m.channelId === S.channelId && !inHistRx) renderMessages();
      break;
    }
    case 'message-deleted': {
      const arr = (S.messages.get(m.channelId) || []).filter((x) => x.id !== m.messageId);
      S.messages.set(m.channelId, arr);
      scrubReplyPreview(m.messageId);
      // A deleted reply drops the root's live reply count (drives the N-replies link).
      if (m.threadRoot) updateMsgInCaches(m.threadRoot, (r) => { r.threadCount = Math.max(0, (r.threadCount || 1) - 1); });
      if (S.thread) {
        if (S.thread.rootId === m.messageId) closeThread();
        else S.thread.replies = S.thread.replies.filter((x) => x.id !== m.messageId);
        renderThread();
      }
      const inHistDel = S.histMode && S.histMode.kind === 'server' && S.histMode.id === m.channelId;
      if (m.channelId === S.channelId && !inHistDel) renderMessages();
      break;
    }
    case 'dm-new': {
      const msg = m.message;
      const inHistDm = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === msg.threadId;
      if (!inHistDm) {
        const arr = S.dmMessages.get(msg.threadId) || [];
        arr.push(msg);
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
          renderDmMessages();
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
      if (S.view === 'home' && S.dmThreadId === m.threadId && !inHistDd) renderDmMessages();
      break;
    }
    case 'dm-reaction': {
      updateMsgInCaches(m.messageId, (old) => {
        old.reactions = (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: (r.users || []).includes(S.me.id) }));
      });
      const inHistDr = S.histMode && S.histMode.kind === 'dm' && S.histMode.id === m.threadId;
      if (S.view === 'home' && S.dmThreadId === m.threadId && !inHistDr) renderDmMessages();
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
    case 'dm-threads-changed':
      if (S.view === 'home') {
        refreshDms().then(() => {
          if (S.dmThreadId && !S.dms.some((t) => t.id === S.dmThreadId)) { S.dmThreadId = null; renderDmBlank(); rememberView(); }
          else renderDmMembers();
        });
      }
      break;
    case 'friends-changed':
      // Always refresh so the home button badge (pending requests) stays
      // correct even when looking at a server; no popup.
      refreshFriends();
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
        if (S.channelId === m.channelId) selectChannel((S.serverDetail.channels.find((c) => c.type === 'text') || {}).id);
      }
      break;
    case 'presence':
      Object.assign(S.presenceAll, m.online || {});
      if (m.serverId === S.serverId) { S.online = m.online || {}; S.online[S.me.id] = S.me.status || 'online'; }
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-online':
      S.presenceAll[m.userId] = m.status || 'online';
      if (m.serverId === S.serverId) S.online[m.userId] = m.status || 'online';
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-offline':
      delete S.presenceAll[m.userId];
      if (m.serverId === S.serverId) delete S.online[m.userId];
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-status':
      if (m.status === 'invisible') delete S.presenceAll[m.userId];
      else S.presenceAll[m.userId] = m.status;
      if (m.serverId === S.serverId) {
        if (m.status === 'invisible') delete S.online[m.userId];
        else S.online[m.userId] = m.status;
      }
      if (S.view === 'server') renderMembers(); else if (S.view === 'home') renderDmMembers();
      break;
    case 'user-updated': {
      const u = m.user;
      if (u.id === S.me.id) { S.me = { ...S.me, ...u }; paintMe(); }
      const mem = (S.serverDetail?.members || []).find((x) => x.id === u.id);
      if (mem) Object.assign(mem, u);
      for (const t of S.dms) {
        const dm = (t.members || []).find((x) => x.id === u.id);
        if (dm) Object.assign(dm, u);
      }
      renderMembers();
      if (S.view === 'home') renderDmMembers();
      if (S.channelId) renderMessages();
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
      if (S.dmThreadId === m.threadId) { S.dmThreadId = null; renderDmBlank(); rememberView(); }
      refreshDms();
      toast('You were removed from a group chat');
      break;
    case 'server-deleted':
      toast('Server was deleted'); refreshServers(); break;
    case 'invite-updated':
      if (m.serverId === S.serverId) S.serverDetail.invite_code = m.invite_code;
      if (S.srvSetId === m.serverId && !$('#srv-settings-backdrop')?.classList.contains('hidden')) renderServerTab();
      break;
    case 'invites-changed':
      if (S.srvSetId === m.serverId && !$('#srv-settings-backdrop')?.classList.contains('hidden')) renderServerTab();
      break;
    case 'notif-new':
      paintNotifBadge(m.unread || 0);
      break;
    // ---- voice ----
    case 'voice-peers': {
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
      closePeer(m.userId);
      if (S.voice && S.voice.serverId === m.serverId && S.voice.channelId === m.channelId) sfx.leave();
      renderVoiceUsers();
      renderStage();
      break;
    }
    case 'voice-state': {
      const occ = S.voiceOccupancy.get(m.channelId) || [];
      const p = occ.find((x) => x.id === m.userId);
      if (p) { p.muted = m.muted; p.speaking = !!m.speaking; p.deafened = !!m.deafened; p.camera = !!m.camera; p.sharing = !!m.sharing; }
      if (m.serverId === S.serverId) renderVoiceUsers();
      if (S.voice && S.voice.channelId === m.channelId) renderStage();
      break;
    }
    case 'voice-signal':
      onVoiceSignal(m.from, m.data);
      break;
    case 'voice-kicked':
      if (S.voice && S.voice.channelId === m.channelId) { leaveVoice(); toast('Voice room was deleted'); }
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

