// What happens to a photo between "sent" and "the compressor settled it"?
//
// Paste this into the browser console (F12 → Console) on campfire.dill.moe, upload
// a photo, and when it has flashed read what it collected:
//
//   await import('/media-flash-probe.js')
//   … upload …                  (30-second window)
//   __cfMediaReport()
//
// Nothing is uploaded anywhere: the record is a JS array in the page.
//
// What it watches, because a "flash" can be any of these and they need different
// fixes:
//   - the node being REPLACED (detach/insert)         -> __cfMediaWatch.events
//   - the node's src/class being RE-POINTED           -> __cfAttr  (with call site)
//   - the list being REBUILT                          -> __cfRender (with call site)
//   - the picture being covered by the placeholder, or not yet decoded
//                                                     -> __cfHidden (with the
//                                                        placeholder's own state)
(function () {
  const W = window;
  if (W.__cfWatch) { console.log('[cf] already watching — call __cfMediaReport()'); return; }
  const attr = [];
  const renders = [];
  const events = [];
  const frames = [];
  const hidden = [];
  W.__cfAttr = attr;
  W.__cfRender = renders;
  W.__cfHidden = hidden;
  W.__cfWatch = { attr, renders, events, frames, hidden, started: Date.now() };

  const BUILD = (() => {
    try {
      const src = String(attachmentHTML || '');
      return {
        pendingPreview: src.includes('attPendingPreview'),
        slot: src.includes('att-slot'),
        sameFileFastPath: src.includes('srcPathOf'),
        version: (W.S && (W.S.bootVersion || W.S.appVersion)) || null,
        gen: (W.S && W.S.bootGen) || null,
      };
    } catch (e) { return { err: String(e && e.message) }; }
  })();

  const BOXES = '#messages, #thread-replies, #attach-preview, #thread-attach-preview, #upload-list, #thread-upload-list';
  const IMGS = 'img.att-img, .att-chip img, .up-ic img';
  const site = () => { try { return (new Error().stack || '').split('\n').slice(2, 5).join(' | ').slice(0, 240); } catch (e) { return ''; } };
  const keyOf = (img) => {
    const s = img.closest ? img.closest('.att-slot, .att-chip, .up-card') : null;
    if (!s) return '?';
    return String(s.getAttribute('data-att-slot') || s.className.split(' ')[0] || '?');
  };
  const whereOf = (img) => {
    if (img.closest && img.closest('.msg')) return 'msg';
    const s = img.closest ? img.closest('.att-chip, .up-card') : null;
    return s && s.classList.contains('up-card') ? 'card' : 'chip';
  };
  const kindOf = (img) => {
    const src = String(img.getAttribute('src') || '');
    if (src.startsWith('data:')) return 'data';
    if (src.startsWith('blob:')) return 'blob';
    return img.dataset.fbThumb ? 'thumb' : 'file';
  };
  const describe = (img) => {
    if (!img || !img.closest || !img.closest('.att-slot, .att-chip, .up-card')) return null;
    const wrap = img.closest('.att-wrap');
    const r = (wrap || img).getBoundingClientRect();
    const cs = getComputedStyle(img);
    return {
      id: keyOf(img), where: whereOf(img), kind: kindOf(img),
      src: String(img.getAttribute('src') || '').slice(0, 64),
      visible: cs.visibility !== 'hidden' && cs.opacity !== '0',
      opacity: cs.opacity,
      natural: img.naturalWidth,
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  // What the placeholder is doing for this picture: `.pending` with no `.ready` is
  // the spinner state, and `display:none` means it cannot be covering anything.
  const phState = (img) => {
    const wrap = img.closest ? img.closest('.att-wrap') : null;
    if (!wrap) return 'no-wrap';
    const ph = wrap.querySelector('.att-ph');
    const cs = ph ? getComputedStyle(ph) : null;
    return [
      wrap.classList.contains('pending') ? 'pending' : '-',
      wrap.classList.contains('ready') ? 'ready' : '-',
      cs && cs.display !== 'none' ? 'PH:' + cs.opacity : 'ph-off',
    ].join('/');
  };

  // ---- a node-level watcher: detach / insert of an attachment image ----
  for (const name of ['remove', 'removeChild', 'replaceChild', 'replaceWith', 'replaceChildren', 'insertBefore', 'after', 'before', 'appendChild']) {
    try {
      const proto = (name === 'remove' || name === 'replaceWith' || name === 'after' || name === 'before') ? Element.prototype : Node.prototype;
      const orig = proto[name];
      if (!orig) continue;
      proto[name] = function (...args) {
        const found = [];
        const note = (n) => {
          if (!n || n.nodeType !== 1) return;
          const im = (n.matches && n.matches('img.att-img')) ? n : (n.querySelector ? n.querySelector('img.att-img') : null);
          if (im) found.push(describe(im));
        };
        note(this);
        for (const a of args) note(a);
        const out = orig.apply(this, args);
        if (found.length) events.push({ t: Date.now(), kind: name, moved: found.filter(Boolean) });
        return out;
      };
    } catch (e) {}
  }

  // ---- every src / class / loading change on an attachment image ----
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (this.tagName === 'IMG' && this.classList.contains('att-img') && (name === 'src' || name === 'class' || name === 'loading')) {
        const rec = describe(this);
        if (rec) attr.push({ t: Date.now(), what: name, value: String(value || '').slice(0, 64), ...rec, site: site() });
      }
    } catch (e) {}
    return origSetAttribute.call(this, name, value);
  };
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (d && d.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set(v) {
          try {
            if (this.classList && this.classList.contains('att-img')) {
              const rec = describe(this);
              if (rec) attr.push({ t: Date.now(), what: 'img.src', value: String(v || '').slice(0, 64), ...rec, site: site() });
            }
          } catch (e) {}
          return d.set.call(this, v);
        },
      });
    }
  } catch (e) {}

  // ---- every full-list rebuild ----
  try {
    if (typeof renderMessages === 'function') {
      const orig = renderMessages;
      W.renderMessages = renderMessages = function () {
        const before = document.querySelectorAll('#messages img.att-img').length;
        const t0 = performance.now();
        const out = orig.apply(this, arguments);
        renders.push({
          t: Date.now(), ms: Math.round((performance.now() - t0) * 10) / 10,
          imgsBefore: before, imgsAfter: document.querySelectorAll('#messages img.att-img').length,
          site: site(),
        });
        return out;
      };
    }
  } catch (e) {}

  // ---- the socket frames, so a verdict can be lined up with the DOM ----
  const hookSocket = () => {
    const s = (W.S && W.S.ws) || null;
    if (!s || s.__cfHooked) return !!s;
    s.__cfHooked = true;
    s.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (!m || !/^(message|dm)-(new|updated)$/.test(m.t || '')) return;
        const atts = (m.message && m.message.attachments) || [];
        events.push({
          t: Date.now(), kind: 'ws:' + m.t, mid: String(m.message && m.message.id || '').slice(0, 8),
          atts: atts.map((a) => ({ id: String(a.id || '').slice(0, 8), scan: a.scan, url: String(a.url || '').slice(-14), size: a.size, w: a.w, h: a.h })),
        });
      } catch (e) {}
    });
    return true;
  };
  hookSocket();
  const timer = setInterval(hookSocket, 500);

  // ---- one sample per frame, and the moment a picture stops being painted ----
  let on = true;
  const last = new Map();
  const sample = () => {
    if (!on) return;
    let painted = 0;
    const rows = [];
    for (const b of document.querySelectorAll(BOXES)) {
      for (const img of b.querySelectorAll(IMGS)) {
        const rec = describe(img);
        if (!rec) continue;
        const ok = rec.visible && rec.natural > 0 && rec.w > 0;
        if (ok) painted++;
        if (img.classList.contains('att-img')) {
          const prev = last.get(rec.id);
          if (!ok && prev !== 'bad') hidden.push({ t: Date.now(), ...rec, ph: phState(img) });
          last.set(rec.id, ok ? 'ok' : 'bad');
        }
        rows.push([rec.where, rec.id, rec.kind, ok ? 'painted' : 'NOT-PAINTED', rec.w + 'x' + rec.h].join(':'));
      }
    }
    frames.push({ t: Date.now(), painted, rows });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  setTimeout(() => { on = false; clearInterval(timer); }, 30000);

  W.__cfMediaReport = function () {
    const gaps = [];
    for (let i = 1; i < frames.length; i++) if (frames[i - 1].painted > 0 && frames[i].painted === 0) gaps.push({ at: frames[i].t, before: frames[i - 1].rows, after: frames[i].rows });
    return {
      seconds: Math.round((Date.now() - W.__cfWatch.started) / 1000),
      build: BUILD,
      frames: frames.length,
      gaps: gaps.length,
      gapSamples: gaps.slice(0, 4),
      unpainted: hidden.slice(0, 12),
      attrChanges: attr.slice(0, 20),
      renders: renders.slice(0, 10),
      events: events.slice(0, 20),
      distinctRowStates: [...new Set(frames.flatMap((f) => f.rows))].slice(0, 24),
    };
  };
  console.log('[cf] watching for 30s — upload a photo now, then run __cfMediaReport()');
})();
