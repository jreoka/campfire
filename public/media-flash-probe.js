// What happens to a photo between "sent" and "the compressor settled it"?
//
// Paste this into the browser console (F12 → Console) on campfire.dill.mil, send a
// photo, and when it has flashed stop and read what it collected. It watches every
// image inside the message list for 30 seconds and records, per animation frame,
// who is on screen and what it is showing — plus every time the compressor's
// verdict (message-updated) arrives.
//
// Nothing is uploaded anywhere: the record is a JS array in the page. The
// interesting output is `__cfMediaReport()` — paste that back.
//
// Usage:
//   (paste this file's contents)
//   … send a photo, watch it flash …
//   __cfMediaReport()
(function () {
  const W = window;
  if (W.__cfMediaWatch) { console.log('[cf] already watching — call __cfMediaReport()'); return; }
  W.__cfMediaWatch = { frames: [], events: [], started: Date.now() };
  // Which BUILD this page is really running. The pending-preview code is what has
  // to be in it for the message to show the picked bytes; a stale service-worker
  // copy would still behave the old way.
  const build = (() => {
    try {
      const src = String(attachmentHTML || '');
      return {
        pendingPreview: src.includes('attPendingPreview'),
        slot: src.includes('att-slot'),
        patch: typeof patchAttachmentInList === 'undefined' ? 'n/a' : 'ok',
        version: (W.S && (W.S.bootVersion || W.S.appVersion)) || null,
        gen: (W.S && W.S.bootGen) || null,
      };
    } catch (e) { return { err: String(e && e.message) }; }
  })();
  W.__cfMediaWatch.build = build;

  // Everything the reader can be looking at: the two message lists, the composer
  // chip rows, the upload cards and the thread composer. A flash in any of them
  // counts.
  const BOXES = '#messages, #thread-replies, #attach-preview, #thread-attach-preview, #upload-list, #thread-upload-list';
  const IMGS = 'img.att-img, .att-chip img, .up-ic img';

  const key = (el) => {
    const s = el.closest ? el.closest('.att-slot, .att-chip, .up-card') : null;
    if (!s) return '?';
    return String(s.getAttribute('data-att-slot') || s.className.split(' ')[0] || '?');
  };
  const describe = (img) => {
    const slot = img.closest ? img.closest('.att-slot, .att-chip, .up-card') : null;
    if (!slot) return null;
    const inMessage = !!(img.closest && img.closest('.msg'));
    const chip = !!(slot.querySelector && slot.querySelector('.att-proc'));
    const r = (img.closest('.att-wrap') || img).getBoundingClientRect();
    const cs = getComputedStyle(img);
    const src = String(img.getAttribute('src') || '');
    return {
      id: key(img),
      where: inMessage ? 'msg' : (slot.classList.contains('up-card') ? 'card' : 'chip'),
      kind: src.startsWith('data:') ? 'data' : (src.startsWith('blob:') ? 'blob' : (img.dataset.fbThumb ? 'thumb' : 'file')),
      src: src.slice(0, 70),
      opacity: cs.opacity,
      visible: cs.visibility !== 'hidden' && cs.opacity !== '0',
      natural: img.naturalWidth,
      w: Math.round(r.width), h: Math.round(r.height),
      chip, card: !!(slot.querySelector && slot.querySelector('.scan-block')),
      held: !!(slot.querySelector && slot.querySelector('.att-held')),
    };
  };

  // Every time an image the list was showing is detached, and what it was.
  const gone = new Set();
  const prune = new Set(['.remove', 'removeChild', 'replaceChild', 'replaceWith', 'replaceChildren', 'insertBefore', 'after', 'before', 'appendChild']);
  for (const name of prune) {
    try {
      const proto = (name === 'remove' || name === 'replaceWith' || name === 'after' || name === 'before') ? Element.prototype : Node.prototype;
      const orig = proto[name];
      if (!orig) continue;
      proto[name] = function (...args) {
        const moved = [];
        const note = (n) => { if (n && n.nodeType === 1) { const im = n.matches && n.matches('img.att-img') ? n : (n.querySelector ? n.querySelector('img.att-img') : null); if (im) moved.push(describe(im)); } };
        if (this && this.nodeType === 1) note(this);
        for (const a of args) note(a);
        const out = orig.apply(this, args);
        if (moved.length) {
          W.__cfMediaWatch.events.push({ t: Date.now(), kind: name, moved: moved.filter(Boolean) });
        }
        return out;
      };
    } catch (e) {}
  }

  // The verdict itself (and any other message frame) as the browser's socket sees
  // it. The page's socket lives at S.ws (see public/js/socket.js).
  const hookSocket = () => {
    const s = (W.S && W.S.ws) || null;
    if (!s || s.__cfHooked) return !!s;
    s.__cfHooked = true;
    s.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m && (m.t === 'message-updated' || m.t === 'message-new' || m.t === 'dm-updated' || m.t === 'dm-new')) {
          const atts = (m.message && m.message.attachments) || [];
          W.__cfMediaWatch.events.push({
            t: Date.now(), kind: 'ws:' + m.t, mid: m.message && m.message.id,
            atts: atts.map((a) => ({ id: a.id, scan: a.scan, url: String(a.url || '').slice(0, 70), size: a.size, w: a.w, h: a.h })),
          });
        }
      } catch (e) {}
    });
    return true;
  };
  hookSocket();
  const hookTimer = setInterval(hookSocket, 500);

  let on = true;
  const sample = () => {
    if (!on) return;
    const boxes = [...document.querySelectorAll(BOXES)];
    const rows = boxes.flatMap((b) => [...b.querySelectorAll(IMGS)]).map(describe).filter(Boolean);
    W.__cfMediaWatch.frames.push({
      t: Date.now(),
      n: rows.length,
      painted: rows.filter((r) => r.visible && r.natural > 0).length,
      rows: rows.map((r) => [r.where, r.id, r.kind, r.visible ? 'vis' : 'HIDDEN', r.natural ? 'ok' : 'NOLOAD', r.w + 'x' + r.h, r.chip ? 'chip' : '', r.held ? 'held' : ''].filter(Boolean).join(':')),
    });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  setTimeout(() => { on = false; clearInterval(hookTimer); }, 30000);

  W.__cfMediaReport = function () {
    const w = W.__cfMediaWatch;
    const f = w.frames;
    // A frame is a "gap" when something was on screen and painted, and the next
    // one is not: that is the blink, with the frames around it.
    const gaps = [];
    for (let i = 1; i < f.length; i++) {
      if (f[i - 1].painted > 0 && f[i].painted === 0) gaps.push({ at: f[i].t, before: f[i - 1], after: f[i] });
    }
    const dest = { for: -1 };
    for (let i = 0; i < f.length; i++) { if (f[i].painted <= 0 && dest.for < 0) { dest.for = i; break; } if (f[i].painted > 0) dest.for = -1; }
    return {
      seconds: Math.round((Date.now() - w.started) / 1000),
      frames: f.length,
      gaps: gaps.length,
      gapSamples: gaps.slice(0, 6),
      events: w.events.slice(0, 40),
      distinctRowStates: [...new Set(f.flatMap((x) => x.rows))].slice(0, 22),
    };
  };
  console.log('[cf] watching the message list for 30s — send a photo, then run __cfMediaReport()');
})();
