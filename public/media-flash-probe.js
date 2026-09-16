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
  W.__cfMediaWatch = { frames: [], events: [], nodes: new Map(), started: Date.now() };

  const key = (el) => {
    const s = el.closest ? el.closest('.att-slot') : null;
    return String((s && s.getAttribute('data-att-slot')) || '?');
  };
  const describe = (img) => {
    const wrap = img.closest ? img.closest('.att-wrap') : null;
    const slot = img.closest ? img.closest('.att-slot') : null;
    if (!slot) return null;
    const r = (wrap || img).getBoundingClientRect();
    const cs = getComputedStyle(img);
    return {
      id: key(img),
      src: String(img.getAttribute('src') || '').slice(0, 70),
      current: String(img.currentSrc || '').slice(0, 70),
      opacity: cs.opacity,
      visible: cs.visibility !== 'hidden' && cs.opacity !== '0',
      natural: img.naturalWidth,
      w: Math.round(r.width), h: Math.round(r.height),
      chip: !!(slot.querySelector('.att-proc')),
      card: !!(slot.querySelector('.scan-block')),
      thumb: !!img.dataset.fbThumb,
      held: !!slot.querySelector('.att-held'),
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
    const box = document.querySelector('#messages, #thread-replies');
    const imgs = box ? [...box.querySelectorAll('img.att-img')] : [];
    const rows = imgs.map(describe).filter(Boolean);
    W.__cfMediaWatch.frames.push({
      t: Date.now(),
      n: rows.length,
      shown: rows.filter((r) => r.w > 0).length,
      painted: rows.filter((r) => r.visible && r.natural > 0).length,
      rows: rows.map((r) => r.id + ':' + (r.thumb ? 'thumb' : (r.src.startsWith('data:') ? 'data' : (r.src.startsWith('blob:') ? 'blob' : 'file'))) + ':' + (r.visible ? 'vis' : 'HIDDEN') + ':' + r.w + 'x' + r.h + (r.chip ? ':chip' : '')),
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
