'use strict';
/* ================= frequent reactions + context menus ================= */
// The quick strips (the hover bar's and the long-press sheet's) offer the five
// reactions this account actually uses. `cf_freq` holds one row per emoji:
// { n: times reacted with, at: when it was last used }. A bare number is the
// older shape — a count with no timestamp — and still reads, so an existing
// browser keeps the history it already has.
function freqN(v) { return typeof v === 'number' ? v : ((v && +v.n) || 0); }
function freqAt(v) { return (v && typeof v === 'object' && +v.at) || 0; }
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢']; // a fresh account's strip
function topReactions() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('cf_freq') || '{}'); } catch {}
  // Most reacted-with first; EQUAL counts go to whichever was used most recently,
  // so a reaction somebody just started using takes its place instead of queueing
  // behind one they used the same number of times weeks ago. The defaults fill
  // whatever is left, so the strip is never short.
  const ranked = Object.entries(raw)
    .filter(([, v]) => freqN(v) > 0)
    .sort((a, b) => (freqN(b[1]) - freqN(a[1])) || (freqAt(b[1]) - freqAt(a[1])))
    .map(([k]) => k);
  return [...new Set([...ranked, ...QUICK_REACTIONS])].slice(0, 5);
}
// Count ONE reaction. An emoji typed into a message is text, never a reaction --
// the composer's picker used to feed this same list, which filled the strips with
// whatever somebody happens to chat with. Returns whether the strip changed, so
// the caller can repaint the ones already on screen (see paintQuickReacts).
function bumpFreq(e) {
  if (!e || typeof e !== 'string') return false;
  try {
    const before = topReactions().join('\u0000');
    let f = {};
    try { f = JSON.parse(localStorage.getItem('cf_freq') || '{}'); } catch {}
    f[e] = { n: freqN(f[e]) + 1, at: Date.now() };
    const keys = Object.keys(f);
    if (keys.length > 40) {
      // Drop the least used first, oldest among equals — the ranking read
      // backwards, so what survives is what topReactions would have offered.
      keys.sort((a, b) => (freqN(f[a]) - freqN(f[b])) || (freqAt(f[a]) - freqAt(f[b])));
      for (const k of keys.slice(0, keys.length - 40)) delete f[k];
    }
    localStorage.setItem('cf_freq', JSON.stringify(f));
    return topReactions().join('\u0000') !== before;
  } catch { return false; }
}
let ctxEl = null;
function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
// A long-press opens its sheet/menu while the finger is still down. Blink then
// paints the :hover background of whatever row sits under that finger (and keeps
// it sticky after the lift), so a row reads as pre-selected before anything was
// chosen. Track when the last touch began and hold hover off for anything opened
// out of it; the class clears on the next touch / real move, when a row under the
// finger is honest feedback again. A mouse-opened menu (>1500ms since any touch)
// is never affected.
let lastTouchAt = 0;
function suppressHoverFromTouch() {
  if (Date.now() - lastTouchAt < 1500) document.body.classList.add('touch-hold');
}
function noteTouchStart() { lastTouchAt = Date.now(); document.body.classList.remove('touch-hold'); }
function noteTouchMove() { document.body.classList.remove('touch-hold'); }
function openCtx(x, y, items) {
  suppressHoverFromTouch();
  closeCtx();
  const m = document.createElement('div');
  m.id = 'ctx-menu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); continue; }
    if (it.head) { const h = document.createElement('div'); h.className = 'ctx-head'; h.textContent = it.head; m.appendChild(h); continue; }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.innerHTML = (it.icon ? `<span class="ctx-ic">${it.icon}</span>` : '') + `<span>${esc(it.label)}</span>`;
    b.onclick = (ev) => { ev.stopPropagation(); closeCtx(); it.fn && it.fn(); };
    m.appendChild(b);
  }
  m.style.visibility = 'hidden';
  document.body.appendChild(m);
  const b = popupBox(m);
  m.style.left = Math.max(8, Math.min(x, innerWidth - b.w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - b.h - 8)) + 'px';
  m.style.visibility = '';
  ctxEl = m;
}
const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l1 7 3 3v2H5v-2l3-3z"/><path d="M12 16v5"/></svg>';
const GIF_STAR_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.6-4.5 4.2 1.2 6-5.5-3.1-5.5 3.1 1.2-6L3.2 9.2l6.1-.6z"/></svg>';
const REPORT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/></svg>';
const RX_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8"/><line x1="9" y1="9.5" x2="9" y2="9.6"/><line x1="15" y1="9.5" x2="15" y2="9.6"/></svg>';
function sysMenuItems(m) {
  return [{ label: 'Copy text', icon: '⧉', fn: () => { copyTextNow(m.content || ''); toast('Copied'); } }];
}
// The GIF a message carries, if it is one a favorite can name: a picker post
// keeps the Klipy item's slug on the attachment (see cleanGifMeta in
// server.js), and a GIF posted before the picker stamped that is keyed on the
// md.gif url it was posted with (gifFavKeyFor in messages.js). An uploaded .gif
// has neither — nothing to favorite, so no menu row.
function gifFavOf(m) {
  const a = (m.attachments || []).find((x) => gifFavKeyFor(x));
  if (!a) return null;
  return {
    slug: gifFavKeyFor(a),
    title: String(a.name || '').replace(/\.gif$/i, ''),
    gif: a.url,
    thumb: a.gif_thumb || a.url,
    mp4: a.gif_mp4 || null,
  };
}
const BOOKMARK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.2L5 21V4a1 1 0 0 1 1-1z"/></svg>';
const BOOKMARK_ON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.2L5 21V4a1 1 0 0 1 1-1z"/></svg>';
const CLOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9.5V13l2.5 1.6"/><path d="M9 2h6"/></svg>';
const UNREAD_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h13l5 6.5-5 6.5H3z"/><circle cx="19" cy="5" r="2.4" fill="currentColor" stroke="none"/></svg>';
const IMG_COPY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>';
const SAVE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
const LINK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
const OPEN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

/* ================= attachment rows =================
 * Media has no menu of its own: the rows that act on an attachment — copy it,
 * save it, copy its link, open its link, and ask what the scanner made of it —
 * are merged into the menu the MESSAGE already has, so a right-click or
 * long-press anywhere on a message with media carries both the message's actions
 * and its file's. Every rendering carries the attachment's identity (see attMeta
 * in messages.js), so one read from whatever the pointer is over — the wrap, the
 * image, the download chip, the GIF star, the spoiler veil, the audio player, a
 * file card, or the scanning/infected card that stands in for a file — resolves
 * to the same rows. A surface with no message around it (a pinned message's
 * media) still gets those rows alone, as its own menu. */
function attFromEl(el) {
  const w = el && el.closest ? el.closest('[data-att-id]') : null;
  if (!w) return null;
  const url = w.dataset.fbUrl || '';
  const kind = w.dataset.fbKind || 'file';
  return {
    id: w.dataset.attId || '',
    url,
    name: w.dataset.fbName || (kind === 'video' ? 'video' : 'file'),
    kind,
    // null when the rendering predates data-fb-size: an unknown size is not 0,
    // and the file card the error handler builds says nothing rather than "0 B".
    size: w.dataset.fbSize ? Number(w.dataset.fbSize) : null,
    scan: w.dataset.fbScan || 'clean',
  };
}
function absUrl(u) { try { return new URL(u, location.origin).href; } catch { return String(u || ''); } }
function sameOriginUrl(u) { try { return new URL(u, location.origin).origin === location.origin; } catch { return false; } }
function copyTextNow(text) {
  try {
    const p = navigator.clipboard && navigator.clipboard.writeText(String(text || ''));
    if (p && p.catch) p.catch(() => toast('Could not copy'));
    else if (!p) toast('Could not copy');
    return true;
  } catch { return false; }
}
// "Copy image" is the clipboard image flavour, which every engine that has one
// takes as image/png — anything else (a webp/gif upload, a Klipy gif) is drawn
// through a canvas first. Cross-origin media a fetch cannot read (no CORS on
// the CDN) and browsers with no async clipboard both end on the same plain
// advice rather than a silent no-op.
function pngBlobFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth || 1; cv.height = img.naturalHeight || 1;
        cv.getContext('2d').drawImage(img, 0, 0);
        cv.toBlob((b) => { URL.revokeObjectURL(src); b ? resolve(b) : reject(new Error('encode')); }, 'image/png');
      } catch (e) { URL.revokeObjectURL(src); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('decode')); };
    img.src = src;
  });
}
async function copyImageToClipboard(a) {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('unsupported');
    const res = await fetch(a.url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('fetch');
    const blob = await res.blob();
    const png = blob.type === 'image/png' ? blob : await pngBlobFromBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    try { haptic(8); } catch {}
    toast('Image copied');
  } catch { toast('Could not copy the image — try Save image'); }
}
function triggerDownload(href, name) {
  const link = document.createElement('a');
  link.href = href;
  link.download = name || 'file';
  link.target = '_blank';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
async function saveMediaFile(a) {
  try {
    if (sameOriginUrl(a.url)) {
      triggerDownload(a.url, a.name);
      toast('Saving ' + String(a.name || 'file').slice(0, 60) + '…');
      return;
    }
    // Cross-origin: the download attribute is ignored and the app wrapper's
    // WebView swallows target=_blank, so pull the bytes and hand a blob url to
    // the download; if CORS refuses, open the link rather than do nothing.
    const res = await fetch(a.url);
    if (!res.ok) throw new Error('fetch');
    const blob = await res.blob();
    const u = URL.createObjectURL(blob);
    triggerDownload(u, a.name);
    toast('Saving ' + String(a.name || 'file').slice(0, 60) + '…');
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  } catch { openMediaLink(a.url); }
}
// The same handoff the rest of the app uses for external links: the native
// shell opens it in the OS browser, a plain browser gets a new tab.
function openMediaLink(url) {
  try {
    const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (typeof inv === 'function') { inv('open_external', { url }).catch(() => {}); return; }
  } catch {}
  try { window.open(url, '_blank', 'noopener'); } catch {}
}
// The rows that act on ONE attachment, whatever shape it is. The clipboard
// flavour exists only for a picture (no engine takes video bytes as clipboard
// image), the link rows name what they copy/open, and the scanner's record is
// offered on every stored upload. Nothing to save or link to when the bytes were
// removed or are not published yet — the reader gets the explanation instead,
// and nothing that would 404 at them.
function attItemsFor(a) {
  if (!a) return [];
  const kind = a.kind || 'file';
  const img = kind === 'image', video = kind === 'video';
  const url = absUrl(a.url);
  const items = [];
  // Nothing to copy, save or link to when the bytes were removed or are not
  // published yet: the reader gets the explanation instead (Scan info), and
  // nothing that would 404 at them.
  if (a.scan !== 'infected' && a.scan !== 'pending' && a.url) {
    if (img) items.push({ label: 'Copy image', icon: IMG_COPY_SVG, fn: () => copyImageToClipboard(a) });
    items.push({ label: img ? 'Save image' : video ? 'Save video' : kind === 'audio' ? 'Save audio' : 'Save file', icon: SAVE_SVG, fn: () => saveMediaFile(a) });
    items.push({
      label: img ? 'Copy image link' : video ? 'Copy video link' : 'Copy link',
      icon: LINK_SVG, fn: () => { copyTextNow(url); toast('Link copied'); },
    });
    if (img || video) items.push({ label: img ? 'Open image link' : 'Open video link', icon: OPEN_SVG, fn: () => openMediaLink(url) });
  }
  const si = scanInfoItem(a);
  if (si) items.push(si);
  return items;
}
// An attachment's rows on their own, for a surface with no message menu to
// merge into (a pinned message's media in the pins panel).
function attMenuItems(el) {
  const a = attFromEl(el);
  if (!a) return null;
  const items = attItemsFor(a);
  return items.length ? items : null;
}
// The attachment rows for a MESSAGE, scoped by what the pointer is ON.
//
// A right-click or long-press on a picture, a player, a file card or the card
// standing in for a removed file gives THAT file's rows; a press on the
// message's own pixels gives none of them. Every attachment used to add its own
// heading + rows wherever the menu was opened, so a post with five photos buried
// the message actions under five identical "Save image" sections (reported) —
// and the rendering the reader actually pointed at is always the more precise
// target, since its identity is what the rows are built from either way.
//
// The heading survives for exactly the case it was written for: a message
// carrying MORE than the one file the pointer is on, where "Save image" would
// otherwise be indistinguishable from the sibling it did not mean (the message
// may well be showing four others right above the menu).
function msgAttItems(m, el) {
  const over = el ? attFromEl(el) : null;
  const items = over ? attItemsFor(over) : [];
  if (!items.length) return [];
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const listed = atts.some((x) => (over.id && x.id === over.id) || (!over.id && over.url && x.url === over.url));
  return (atts.length + (listed ? 0 : 1)) > 1 ? [{ head: over.name || 'attachment' }, ...items] : items;
}
function mediaSheetHead(el) {
  const a = attFromEl(el);
  if (!a) return null;
  const label = { image: 'Image', video: 'Video', audio: 'Audio' }[a.kind] || 'File';
  return { title: a.name, sub: label, glyph: a.kind === 'video' ? '▶' : a.kind === 'audio' ? '♪' : '■', color: 'var(--panel-3)' };
}

/* ================= "Scan info" =================
 * What the scanner concluded about one attachment, and why.
 *
 * The verdict is READ, never recomputed: it is stored when the scan runs (see
 * virus-scan.js), which is the only way to explain a file whose bytes are
 * already gone, and the only honest way to show a verdict beside the engine
 * generation that actually made it. The chat card can only ever say a file was
 * blocked — the reason lives here.
 */
const SCAN_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>';
function scanInfoItem(a) {
  // No attachment id means nothing the server could look up — an optimistic
  // local attachment, say. The rest of the menu still applies.
  if (!a || !a.id) return null;
  return { label: 'Scan info', icon: SCAN_SHIELD, fn: () => openScanInfo(a) };
}
// The verdict, as a tone (`ok`/`warn`/`bad`, which is all the CSS needs) and the
// words for it. `status` is the operational state and wins where it exists: a
// row can be `infected` or in `error` whatever the engine's own answer was.
function scanVerdictText(sc) {
  if (!sc) return { tone: '', text: 'No verdict recorded' };
  if (sc.status === 'infected') return { tone: 'bad', text: 'Malware detected' };
  if (sc.status === 'error') return { tone: 'warn', text: 'Could not be judged' };
  if (sc.status === 'pending') return { tone: '', text: 'Scanning…' };
  if (sc.verdict === 'malicious') return { tone: 'bad', text: 'Malware detected' };
  if (sc.verdict === 'clean') return { tone: 'ok', text: 'Clean' };
  return { tone: '', text: 'No verdict recorded' };
}
function scanNote(r, v) {
  const sc = r.scan;
  if (!r.local) return 'This attachment is not a stored upload, so there was nothing to scan.';
  if (!sc) {
    if (!r.scanningEnabled) return 'Scanning is off on this server right now, and no verdict was recorded for this file.';
    return 'No verdict is recorded for this file yet — it was stored before this scanner started judging uploads. '
      + 'The background bucket scan will pick it up on its next pass; until then it is served as it always was.';
  }
  if (sc.status === 'infected') return 'The file was removed and can no longer be downloaded.';
  if (sc.status === 'error') {
    return 'The scanner did not answer for this file' + (sc.attempts > 1 ? ` after ${sc.attempts} attempts` : '')
      + ', so it is served anyway — uploads fail open rather than being held back.'
      + (sc.error ? ` Last error: ${sc.error}` : '');
  }
  if (sc.background) return 'A background re-scan of the stored bucket is queued for this file. It stays available while the verdict is pending.';
  if (sc.status === 'pending') return 'Waiting for the verdict.';
  if (!r.scanningEnabled) return 'Scanning is off on this server right now; this is the verdict it recorded when it was on.';
  // A verdict is only meaningful beside the engine generation that produced it:
  // a file judged by an older engine is re-judged by the bucket sweep, and this
  // is where a reader can see which one actually looked at their file.
  if (r.engineNow && sc.engine && sc.engine !== r.engineNow) {
    return 'This verdict came from an earlier scanner generation (' + sc.engine + '); the background scan re-judges it with the current engine.';
  }
  return '';
}
function scanWhen(ts) {
  if (!ts) return '—';
  try { return agoStr(ts); } catch { return new Date(ts).toLocaleString(); }
}
function scanInfoHTML(r) {
  const sc = r.scan;
  const v = scanVerdictText(sc);
  const rows = [];
  rows.push(['Scanned', sc && sc.scannedAt ? scanWhen(sc.scannedAt) : 'not yet']);
  if (sc && sc.attempts > 1) rows.push(['Attempts', String(sc.attempts)]);
  // Derived from BOTH the key and `local`, so a missing field can never turn
  // into a false claim about where the file lives: no key AND no local flag
  // reads as "a stored upload" rather than "not a stored upload".
  const where = r.local ? (r.key || 'a stored upload') : 'not a stored upload';
  rows.push(['File', where + (r.size ? ' · ' + fmtSize(r.size) : '')]);
  // The engine generation, and the signature revision inside it — an operator's
  // "is this deployment current?" answered where the verdict is read.
  if (sc && sc.engine) rows.push(['Engine', sc.engine]);
  const sig = (sc && (sc.evidence || []).find((l) => /^signatures:\s/.test(l))) || '';
  if (sig) rows.push(['Signatures', sig.replace(/^signatures:\s*/, '')]);
  const findings = ((sc && sc.evidence) || []).filter((l) => !/^signatures:\s/.test(l));
  return `<div class="hb-head">
    <span class="hb-ic${v.tone ? ' ' + v.tone : ''}">${SCAN_SHIELD}</span>
    <span class="hb-t"><b>${esc(r.name || 'file')}</b><span class="hb-v${v.tone ? ' ' + v.tone : ''}">${esc(v.text)}</span></span>
  </div>
  <div class="hb-rows">${rows.map(([k, val]) => `<div class="hb-row"><span>${esc(k)}</span><span class="hb-val">${esc(val)}</span></div>`).join('')}</div>
  ${findings.length ? `<div class="hb-sect">Findings</div><ul class="hb-find">${findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
  ${(() => { const n = scanNote(r, v); return n ? `<div class="hb-note">${esc(n)}</div>` : ''; })()}`;
}
// One request per open, and the panel is dismissed (or replaced) freely while it
// is in flight: the sequence number is what stops a late answer painting into a
// dialog somebody else now owns.
let scanSeq = 0;
async function openScanInfo(a) {
  const seq = ++scanSeq;
  openModal('Scan info', '<p class="muted small">Reading the scan record…</p>', 'Close', null, { hideCancel: true });
  let r = null;
  try { r = await api('/api/attachments/' + encodeURIComponent(a.id) + '/scan'); }
  catch (e) {
    if (seq !== scanSeq) return;
    $('#modal-body').innerHTML = `<p class="muted small">Could not read the scan record (${esc(prettyError(e.message))}).</p>`;
    return;
  }
  if (seq !== scanSeq || $('#modal-backdrop').classList.contains('hidden')) return;
  $('#modal-body').innerHTML = scanInfoHTML(r);
}

function messageMenuItems(m, mid, x, y, el) {
  const dm = !!m._dm;
  const own = m.user && m.user.id === S.me.id;
  const items = [
    { label: 'Add reaction…', icon: plusSVG(14), fn: () => openPicker('react', mid, 'emoji', { x, y }) },
    { label: 'Reply', icon: '↩', fn: () => replyToMsg(m) },
    { label: 'Forward', icon: '↗', fn: () => openForward(mid) },
  ];
  // Starring the GIF sits with the other actions on the message's content; the
  // picture's own star (see attFavHTML in messages.js) writes the same favorite.
  const gifFav = gifFavOf(m);
  if (gifFav) {
    const on = gifFavMatch(S.gifFavs, gifFav.slug, gifFav.gif);
    items.push({ label: on ? 'Remove GIF from favorites' : 'Add GIF to favorites', icon: GIF_STAR_SVG, fn: () => toggleGifFav(gifFav) });
  }
  if (!dm && !m.threadRoot) items.push({ label: 'Open thread', icon: '💬', fn: () => openThread(mid) });
  if (m.reactions?.length) {
    const n = m.reactions.reduce((a, r) => a + (r.count || 0), 0);
    items.push({ label: `View reactions (${n})`, icon: RX_SVG, fn: () => openReactionsModal(mid) });
  }
  if (!m.threadRoot) items.push({ label: S.pinIds.has(mid) ? 'Unpin message' : 'Pin message', icon: PIN_SVG, fn: () => togglePin(mid) });
  items.push({ sep: true });
  if (own) items.push({ label: 'Edit message', icon: '✎', fn: () => startEdit(mid) });
  if (canMod(m)) items.push({ label: 'Delete message', icon: '🗑', danger: true, fn: () => api((dm ? '/api/dms/messages/' : '/api/messages/') + mid, { method: 'DELETE' }).catch(() => toast('Delete failed')) });
  items.push({ label: 'Copy text', icon: '⧉', fn: () => { copyTextNow(m.content || ''); toast('Copied'); } });
  // The file the pointer is on, in this same menu: its rows (copy/save/link, and
  // what the scanner made of it) ride between the content actions and the
  // reader's memory of the conversation. `el` is the element under the pointer,
  // so a press on the message itself carries none — the media is the target for
  // its own actions (see msgAttItems).
  const attItems = msgAttItems(m, el);
  if (attItems.length) items.push({ sep: true }, ...attItems, { sep: true });
  // The reader's own memory of a conversation: leave this message as the first
  // unread one, keep it (or drop it) from the bookmarks list, or set a nudge
  // hung off it. All three are account state, so they follow the reader to
  // every device like pins and unread do.
  items.push({ label: 'Mark unread', icon: UNREAD_SVG, fn: () => markMessageUnread(mid) });
  const saved = !!(S.bookmarkIds && S.bookmarkIds.has(mid));
  items.push({ label: saved ? 'Remove bookmark' : 'Bookmark message', icon: saved ? BOOKMARK_ON_SVG : BOOKMARK_SVG, fn: () => toggleBookmark(mid, !saved) });
  items.push({ label: 'Create reminder…', icon: CLOCK_SVG, fn: () => openReminderModal(mid) });
  // Reporting sits at the very bottom, set apart and in red: you cannot report
  // your own message, and it goes to site admins (never the author).
  if (!own && !m.sys) {
    items.push({ sep: true });
    items.push({ label: 'Report message', icon: REPORT_SVG, danger: true, fn: () => openReportModal(mid) });
  }
  return items;
}
// Report composer: reason + optional details. The server snapshots the message
// so the admins can still review it if it is deleted afterwards.
function openReportModal(mid) {
  const m = msgById(mid);
  if (!m || m.sys) return;
  const dm = !!m._dm;
  const who = m.user ? m.user.display_name : (m.webhook ? (m.webhook.name || 'this webhook') : 'the author');
  openModal('Report message', `
    <p class="muted small">This goes to the site admins only. ${esc(who)} is never told who reported, and a copy of the message is attached so it can still be reviewed if it is deleted.</p>
    <label style="margin-top:.7rem;display:block">Reason
      <select id="m-rep-reason">
        <option value="spam">Spam</option>
        <option value="harassment">Harassment or bullying</option>
        <option value="hate">Hate speech</option>
        <option value="sexual">Sexual content</option>
        <option value="violence">Violence or threats</option>
        <option value="illegal">Illegal content</option>
        <option value="other">Other</option>
      </select>
    </label>
    <label style="margin-top:.6rem;display:block">Details <span class="muted">(optional)</span>
      <textarea id="m-rep-details" rows="3" maxlength="1000" placeholder="What is wrong with this message?"></textarea>
    </label>
  `, 'Report', async () => {
    const reason = $('#m-rep-reason')?.value || 'other';
    const details = $('#m-rep-details')?.value || '';
    try {
      await api('/api/reports', { method: 'POST', body: JSON.stringify({ messageId: mid, kind: dm ? 'dm' : 'server', reason, details }) });
      toast('Report sent to site admins');
    } catch (err) {
      if (err.message === 'already_reported') toast('You already reported this message');
      else toast('Report failed: ' + prettyError(err.message));
    }
  }, { danger: true });
}
function messageCtxMenu(mid, x, y, el) {
  const m = msgById(mid);
  if (!m) return;
  if (m.sys) { openCtx(x, y, sysMenuItems(m)); return; }
  openCtx(x, y, messageMenuItems(m, mid, x, y, el));
}
/* ================= bookmarks + reminders (the reader's own memory) ================= */
// Bookmarked message ids, for the menu's Bookmark/Remove bookmark wording. The
// rows themselves live on the server (they must survive a reload, and the inbox
// reads them back); this set is only the toggle state.
async function loadBookmarks() {
  if (!S.me || !store.token) return;
  try { const { ids } = await api('/api/bookmarks/ids'); S.bookmarkIds = new Set(ids || []); }
  catch { if (!S.bookmarkIds) S.bookmarkIds = new Set(); }
}
async function toggleBookmark(mid, on) {
  if (!S.bookmarkIds) S.bookmarkIds = new Set();
  const m = msgById(mid);
  try {
    if (on) {
      await api('/api/bookmarks', { method: 'POST', body: JSON.stringify({ messageId: mid, kind: (m && m._dm) ? 'dm' : 'server' }) });
      S.bookmarkIds.add(mid);
      haptic(8);
      toast('Saved to bookmarks');
    } else {
      await api('/api/bookmarks/' + encodeURIComponent(mid), { method: 'DELETE' });
      S.bookmarkIds.delete(mid);
      toast('Bookmark removed');
    }
  } catch (err) {
    if (err && err.message === 'already_bookmarked') { S.bookmarkIds.add(mid); toast('Already bookmarked'); return; }
    toast('Could not update the bookmark');
  }
}
// Unread is a watermark on the server (see the route), so this both lights the
// conversation here and remembers it for every other device.
async function markMessageUnread(mid) {
  try {
    const r = await api('/api/messages/' + encodeURIComponent(mid) + '/unread', { method: 'POST' });
    if (r && r.kind === 'dm') {
      S.dmUnread.set(r.threadId, r.unread || 1);
      try { renderDmLists(); } catch {}
      try { paintHomeBadge(); } catch {}
    } else if (r) {
      try { markChanUnread(r.serverId, r.channelId); } catch {}
      try { paintServerUnread(r.serverId); } catch {}
    }
    haptic(8);
    toast('Marked unread');
  } catch { toast('Could not mark it unread'); }
}
// Fan-out time choices. The first is the default; Custom is the same row family
// so picking a time is one tap and a typed time is one more field, never a mode
// switch.
const REMIND_PRESETS = [
  { label: 'In 20 minutes', ms: 20 * 60 * 1000 },
  { label: 'In an hour', ms: 60 * 60 * 1000 },
  { label: 'In 3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: 'Tomorrow', ms: 24 * 60 * 60 * 1000 },
  { label: 'Next week', ms: 7 * 24 * 60 * 60 * 1000 },
];
function remindWhenText(ts) {
  try {
    return new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
// `datetime-local` wants a local wall-clock string, not an ISO instant.
function localDatetimeValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function openReminderModal(mid) {
  const m = mid ? msgById(mid) : null;
  const dm = !!(m && m._dm);
  const where = dm ? 'this conversation' : 'this channel';
  const snip = m ? String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const pick = { at: Date.now() + REMIND_PRESETS[1].ms, label: REMIND_PRESETS[1].label, custom: 0 };
  const chips = REMIND_PRESETS.map((p, i) =>
    `<button type="button" class="rem-chip${i === 1 ? ' sel' : ''}" data-i="${i}">${esc(p.label)}</button>`).join('');
  openModal('Create reminder', `
    ${snip ? `<p class="muted small rem-ctx">“${esc(snip)}”</p>` : `<p class="muted small rem-ctx">Reminder for ${esc(where)}.</p>`}
    <label style="display:block;margin-top:.5rem">Remind me about
      <input id="rem-text" maxlength="300" placeholder="e.g. reply to this" />
    </label>
    <div class="rem-label">When</div>
    <div class="rem-chips" id="rem-chips">${chips}</div>
    <label style="display:block;margin-top:.6rem">Custom time
      <input type="datetime-local" id="rem-custom" value="${esc(localDatetimeValue(new Date(pick.at)))}" />
    </label>
    <p class="muted small" id="rem-when" style="margin-top:.5rem"></p>
  `, 'Create reminder', async () => {
    const text = ($('#rem-text')?.value || '').trim();
    const remindAt = pick.custom || pick.at;
    if (!(remindAt > Date.now() - 1000)) { toast('Pick a time in the future'); return; }
    try {
      await api('/api/reminders', { method: 'POST', body: JSON.stringify({ text, remindAt, messageId: mid || undefined }) });
      toast('Reminder set for ' + remindWhenText(remindAt));
    } catch (err) {
      toast('Could not set the reminder: ' + prettyError(err && err.message));
    }
  });
  const paintWhen = () => {
    const at = pick.custom || pick.at;
    const el = $('#rem-when');
    if (el) el.textContent = 'Reminds you ' + remindWhenText(at) + (pick.custom ? ' (custom)' : ' · ' + pick.label);
  };
  paintWhen();
  const chipsEl = $('#rem-chips');
  if (chipsEl) {
    chipsEl.querySelectorAll('.rem-chip').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i) || 0;
        const p = REMIND_PRESETS[i] || REMIND_PRESETS[0];
        pick.at = Date.now() + p.ms;
        pick.label = p.label;
        // A preset is a time in its own right: touching one takes the custom
        // field back out of the running (and puts its clock back in step) so
        // there is never a hidden second answer to "when".
        pick.custom = 0;
        const cu = $('#rem-custom');
        if (cu) cu.value = localDatetimeValue(new Date(pick.at));
        chipsEl.querySelectorAll('.rem-chip').forEach((x) => x.classList.toggle('sel', x === b));
        paintWhen();
      };
    });
  }
  const cu = $('#rem-custom');
  if (cu) {
    cu.oninput = () => {
      const ts = Date.parse(cu.value);
      pick.custom = Number.isFinite(ts) ? ts : 0;
      if (pick.custom) { chipsEl?.querySelectorAll('.rem-chip').forEach((x) => x.classList.remove('sel')); }
      paintWhen();
    };
  }
  setTimeout(() => { try { $('#rem-text')?.focus(); } catch {} }, 0);
}
function reactLabel(e) {
  const em = S.emojiAll[e.slice(1, -1)];
  return (e.startsWith(':') && e.endsWith(':') && em)
    ? `<img class="cemoi" src="${em.url}" alt="${esc(e)}">` : esc(e);
}
function closeMsgSheet(instant) {
  const bd = document.querySelector('#sheet-backdrop'), sh = document.querySelector('#sheet');
  if (!bd && !sh) return;
  if (instant) { bd?.remove(); sh?.remove(); return; }
  bd?.classList.remove('open'); sh?.classList.remove('open');
  setTimeout(() => { document.querySelector('#sheet-backdrop')?.remove(); document.querySelector('#sheet')?.remove(); }, 240);
}
function openMsgSheet(mid, el) {
  const m = msgById(mid);
  if (!m) return;
  suppressHoverFromTouch();
  closeCtx();
  closePicker();
  closeMsgSheet(true);
  const bd = document.createElement('div');
  bd.id = 'sheet-backdrop';
  bd.onclick = () => closeMsgSheet();
  const sh = document.createElement('div');
  sh.id = 'sheet';
  sh.setAttribute('role', 'dialog');
  sh.innerHTML = '<div class="sheet-handle"></div>';
  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = '<span class="avatar"></span><div style="min-width:0;flex:1"><div class="sheet-who"></div><div class="sheet-snip"></div></div>';
  if (m.sys) {
    paintAvatar(head.querySelector('.avatar'), null);
    head.querySelector('.sheet-who').textContent = 'Message';
    head.querySelector('.sheet-snip').textContent = m.content || '';
  } else {
    const au = msgAuthor(m);
    paintAvatar(head.querySelector('.avatar'), au);
    head.querySelector('.sheet-who').innerHTML = `<span style="${nameStyleFor(au)}">${esc(au ? au.display_name : 'deleted')}</span>${m.webhook ? '<span class="bot-tag">BOT</span>' : tagHTML(au)}<span class="when" title="${esc(fmtFull(m.created_at))}">${fmtTime(m.created_at)}</span>`;
    head.querySelector('.sheet-snip').textContent = m.content
      ? (m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content)
      : (m.attachments?.length ? `[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]` : '');
  }
  sh.appendChild(head);
  if (!m.sys) {
    const reacts = document.createElement('div');
    reacts.className = 'sheet-reacts';
    for (const e of topReactions()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = reactLabel(e);
      b.onclick = () => { closeMsgSheet(); toggleReaction(mid, e); };
      reacts.appendChild(b);
    }
    sh.appendChild(reacts);
  }
  const rows = document.createElement('div');
  rows.className = 'sheet-rows';
  for (const it of (m.sys ? sysMenuItems(m) : messageMenuItems(m, mid, 0, 0, el))) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sheet-sep'; rows.appendChild(s); continue; }
    if (it.head) { const h = document.createElement('div'); h.className = 'ctx-head'; h.textContent = it.head; rows.appendChild(h); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-row' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span class="ctx-ic">${it.icon || ''}</span>`;
    const lb = document.createElement('span');
    lb.textContent = it.label;
    b.appendChild(lb);
    b.onclick = () => { closeMsgSheet(); it.fn && it.fn(); };
    rows.appendChild(b);
  }
  sh.appendChild(rows);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sheet-cancel';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => closeMsgSheet();
  sh.appendChild(cancel);
  document.body.appendChild(bd);
  document.body.appendChild(sh);
  swipeDownToClose(sh, () => closeMsgSheet(), { dragClass: 'sheet-dragging', scroller: () => sh.querySelector('.sheet-rows'), enabled: () => sh.classList.contains('open') });
  sheetDragExpand(sh, { enabled: () => sh.classList.contains('open') });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bd.classList.add('open'); sh.classList.add('open');
  }));
}
/* generic slide-up bottom sheet for right-click-style menus (mobile long-press) */
function closeCtxSheet() {
  document.querySelector('#sheet-backdrop')?.remove();
  document.querySelector('#sheet')?.remove();
}
function openServerSheet(sid) {
  const s = S.servers.find((v) => v.id === sid);
  if (!s) return;
  openCtxSheet(serverMenuItems(sid), { title: s.name, sub: '', serverUser: { display_name: s.name, avatar_color: '#5865f2', avatar_url: s.icon_url || null } });
}
function openChannelSheet(cid, ctype) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  if (!c) return;
  openCtxSheet(channelMenuItems(cid, ctype), { title: c.name, sub: ctype === 'voice' ? 'Voice channel' : 'Text channel', glyph: ctype === 'voice' ? '♪' : '#', color: 'var(--panel-3)' });
}
function openFolderSheet(fid) {
  const f = folderById(fid);
  if (!f) return;
  // The slide-up sheet owns the touch experience: kill the desktop flyout
  // first so the two can never stack (long-press also fires contextmenu).
  try { if (typeof closeFolderFlyout === 'function') closeFolderFlyout(); } catch {}
  const colors = (typeof FOLDER_COLORS !== 'undefined' && FOLDER_COLORS) || ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
  openCtxSheet(folderSheetItems(fid), {
    title: f.name || 'Folder',
    sub: (f.servers || []).length + ' server' + ((f.servers || []).length === 1 ? '' : 's'),
    glyph: (f.name || 'F').trim().charAt(0).toUpperCase(),
    color: f.color || '#5865f2',
    swatches: {
      label: 'Folder color',
      colors,
      selected: f.color,
      onPick: (c) => { f.color = c; try { saveLayout(); } catch {} try { renderServerList(); } catch {} },
    },
  });
}
function openCtxSheet(items, head) {
  if (!items || !items.length) return;
  suppressHoverFromTouch();
  closeCtx();
  closePicker();
  closeMsgSheet(true);
  closeCtxSheet();
  const bd = document.createElement('div');
  bd.id = 'sheet-backdrop';
  bd.onclick = () => closeCtxSheet();
  const sh = document.createElement('div');
  sh.id = 'sheet';
  sh.setAttribute('role', 'dialog');
  sh.innerHTML = '<div class="sheet-handle"></div>';
  if (head && (head.title || head.sub)) {
    const h = document.createElement('div');
    h.className = 'sheet-head';
    h.innerHTML = '<span class="avatar"></span><div style="min-width:0;flex:1"><div class="sheet-who"></div><div class="sheet-snip"></div></div>';
    const av = h.querySelector('.avatar');
    if (head.serverUser) paintAvatar(av, head.serverUser);
    else if (head.avatarEl) av.appendChild(head.avatarEl);
    else { av.textContent = head.glyph || (head.title ? head.title.trim().charAt(0).toUpperCase() : '?'); av.style.background = head.color || 'var(--panel-3)'; }
    h.querySelector('.sheet-who').textContent = head.title || '';
    h.querySelector('.sheet-snip').textContent = head.sub || '';
    sh.appendChild(h);
  }
  if (head && head.swatches && head.swatches.colors) {
    const sw = document.createElement('div');
    sw.className = 'sheet-swatches';
    const lab = document.createElement('div');
    lab.className = 'sheet-swlabel';
    lab.textContent = head.swatches.label || 'Color';
    sw.appendChild(lab);
    const row = document.createElement('div');
    row.className = 'sheet-swrow';
    for (const c of head.swatches.colors) {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'sheet-sw' + (head.swatches.selected === c ? ' sel' : '');
      d.style.background = c;
      d.setAttribute('aria-label', c);
      d.onclick = () => {
        haptic(10); // picking a swatch is a selection — keep the tick
        try { head.swatches.onPick && head.swatches.onPick(c); } catch {}
        head.swatches.selected = c;
        row.querySelectorAll('.sheet-sw').forEach((el) => el.classList.toggle('sel', el === d));
        const av = sh.querySelector('.sheet-head .avatar');
        if (av) av.style.background = c;
      };
      row.appendChild(d);
    }
    sw.appendChild(row);
    sh.appendChild(sw);
  }
  const rows = document.createElement('div');
  rows.className = 'sheet-rows';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sheet-sep'; rows.appendChild(s); continue; }
    if (it.head) { const h = document.createElement('div'); h.className = 'ctx-head'; h.textContent = it.head; rows.appendChild(h); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-row' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span class="ctx-ic">${it.icon || ''}</span>`;
    const lb = document.createElement('span');
    lb.textContent = it.label;
    b.appendChild(lb);
    b.onclick = () => { closeCtxSheet(); it.fn && it.fn(); };
    rows.appendChild(b);
  }
  sh.appendChild(rows);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sheet-cancel';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => closeCtxSheet();
  sh.appendChild(cancel);
  document.body.appendChild(bd);
  document.body.appendChild(sh);
  swipeDownToClose(sh, () => closeMsgSheet(), { dragClass: 'sheet-dragging', scroller: () => sh.querySelector('.sheet-rows'), enabled: () => sh.classList.contains('open') });
  sheetDragExpand(sh, { enabled: () => sh.classList.contains('open') });
  requestAnimationFrame(() => requestAnimationFrame(() => { bd.classList.add('open'); sh.classList.add('open'); }));
}
function folderSheetItems(fid) {
  const f = folderById(fid); if (!f) return [];
  return [
    { label: S.openFolderId === fid ? 'Collapse folder' : 'Expand folder', icon: S.openFolderId === fid ? '▴' : '▾', fn: () => toggleFolder(fid) },
    // Same action the folder's own desktop flyout carries (see openFolderMenu).
    ...(typeof folderUnreadCount === 'function' && folderUnreadCount(f) ? [{ label: 'Mark all as read', icon: '✓', fn: () => markFolderRead(fid) }] : []),
    { label: 'Rename folder', icon: '✎', fn: () => renameFolder(fid) },
    ...(typeof folderMoveOrderItems === 'function' ? folderMoveOrderItems(fid) : []),
    { label: 'Delete folder', icon: '🗑', danger: true, fn: () => deleteFolder(fid) },
  ];
}
/* ================= forward messages ================= */
S.fwdSrc = null; S.fwdPick = null;
let fwdDestCache = null;
async function loadFwdDests() {
  if (fwdDestCache && Date.now() - fwdDestCache.at < 30000) return fwdDestCache;
  const chans = [];
  const details = await Promise.all((S.servers || []).map((s) => api(`/api/servers/${s.id}`).then((d) => d.server).catch(() => null)));
  for (const d of details) {
    if (!d) continue;
    for (const c of (d.channels || []).filter((x) => x.type === 'text')) chans.push({ kind: 'server', serverId: d.id, serverName: d.name, id: c.id, name: c.name });
  }
  let dms = S.dms || [];
  if (!dms.length) { try { ({ threads: dms } = await api('/api/dms')); S.dms = dms; } catch { dms = []; } }
  fwdDestCache = { at: Date.now(), chans, dms };
  return fwdDestCache;
}
function renderFwdDests(filter = '') {
  const box = document.querySelector('#fwd-dests');
  if (!box || !fwdDestCache) return;
  const q = filter.trim().toLowerCase();
  const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
  box.innerHTML = '';
  const mkRow = (pick, avText, name, sub, peer) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fwd-dest' + (S.fwdPick && S.fwdPick.kind === pick.kind && S.fwdPick.id === pick.id ? ' sel' : '');
    b.innerHTML = '<span class="avatar"></span><span class="fwd-main"><span class="fwd-name"></span><br/><span class="fwd-sub"></span></span><span class="fwd-check">✓</span>';
    const av = b.querySelector('.avatar');
    if (peer) paintAvatar(av, peer);
    else { av.textContent = avText; av.style.background = 'var(--panel-3)'; }
    b.querySelector('.fwd-name').textContent = name;
    b.querySelector('.fwd-sub').textContent = sub;
    b.onclick = () => { S.fwdPick = pick; renderFwdDests(document.querySelector('#fwd-search')?.value || ''); };
    return b;
  };
  const sec = (t) => { const e = document.createElement('div'); e.className = 'fwd-sec'; e.textContent = t; box.appendChild(e); };
  const chanHits = fwdDestCache.chans.filter((c) => !sameCtx(S.fwdSrcCtx, c) && (hit(c.name) || hit(c.serverName)));
  if (chanHits.length) {
    sec('CHANNELS');
    for (const c of chanHits) box.appendChild(mkRow(c, '#', '#' + c.name, c.serverName, null));
  }
  const dmHits = fwdDestCache.dms.filter((t) => !sameCtx(S.fwdSrcCtx, { kind: 'dm', id: t.id }) && hit(dmTitle(t)));
  if (dmHits.length) {
    sec('DIRECT MESSAGES');
    for (const t of dmHits) {
      const peer = t.isGroup ? null : dmPeer(t);
      box.appendChild(mkRow({ kind: 'dm', id: t.id }, t.isGroup ? '#' : '', dmTitle(t), t.isGroup ? 'Group chat' : ('@' + (peer?.username || '')), peer));
    }
  }
  if (!chanHits.length && !dmHits.length) box.innerHTML = '<p class="muted small" style="text-align:center;padding:.6rem">No chats match.</p>';
}
async function openForward(mid) {
  const m = msgById(mid);
  if (!m || m.sys) return;
  S.fwdSrc = m;
  const ctx = pinsCtx();
  S.fwdSrcCtx = ctx;
  S.fwdPick = null;
  const au0 = msgAuthor(m);
  // A deleted account keeps its messages; name the state, never a made-up
  // person (the same reason search says "Deleted user", not "Someone").
  const author = au0 ? au0.display_name : 'Deleted user';
  const snip = m.content ? (m.content.length > 140 ? m.content.slice(0, 140) + '…' : m.content)
    : (m.attachments?.length ? `[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]` : '[no text]');
  openModal('Forward message', `
    <div class="fwd-preview"><span class="avatar"></span><div class="fwd-pmain"><div class="fwd-from"></div><div class="fwd-snip"></div></div></div>
    <label class="fwd-label">Add a message <span class="muted">(optional)</span><textarea id="fwd-comment" maxlength="2000" rows="2" placeholder="Say something about this…"></textarea></label>
    <input id="fwd-search" placeholder="Search chats…" autocomplete="off" />
    <div id="fwd-dests"><p class="muted small" style="text-align:center;padding:.6rem">Loading chats…</p></div>
  `, 'Forward', () => sendForward(), { wide: true });
  const pv = document.querySelector('#modal-body .fwd-preview');
  if (pv) {
    paintAvatar(pv.querySelector('.avatar'), au0);
    pv.querySelector('.fwd-from').textContent = author;
    pv.querySelector('.fwd-snip').textContent = snip;
  }
  document.querySelector('#fwd-search')?.addEventListener('input', (e) => renderFwdDests(e.target.value));
  try {
    await loadFwdDests();
    if (!S.fwdPick) {
      const firstChan = (fwdDestCache.chans || []).find((c) => !sameCtx(S.fwdSrcCtx, c));
      const firstDm = (fwdDestCache.dms || []).map((t) => ({ kind: 'dm', id: t.id })).find((p) => !sameCtx(S.fwdSrcCtx, p));
      S.fwdPick = firstChan || firstDm || null;
    }
    renderFwdDests();
  } catch { renderFwdDests(); }
}
function sendForward() {
  const pick = S.fwdPick, src = S.fwdSrc;
  if (!pick || !src) { toast('Pick a chat first'); return; }
  if (sameCtx(S.fwdSrcCtx, pick)) { toast('Pick a different chat'); return; }
  const comment = (document.querySelector('#fwd-comment')?.value || '').trim().slice(0, 2000);
  const orig = src.content || '';
  let content = comment ? (orig ? comment + '\n\n' + orig : comment) : orig;
  content = content.slice(0, 5000);
  // A forwarded GIF stays starrable in its new home, so the picker identity
  // (and the measured shape) rides along with the bytes.
  const atts = (src.attachments || []).slice(0, 5).map((a) => ({
    url: a.url, name: a.name, mime: a.mime, size: a.size, kind: a.kind, spoiler: !!a.spoiler,
    gifSlug: a.gif_slug || '', gifThumb: a.gif_thumb || '', gifMp4: a.gif_mp4 || '', w: a.w || 0, h: a.h || 0,
  }));
  if (!content && !atts.length) { toast('Nothing to forward'); return; }
  if (!S.ws || S.ws.readyState !== 1) { toast('Reconnecting… try again in a second'); return; }
  const fwdFrom = src.fwdFrom || (src.user ? src.user.display_name : 'Deleted user');
  if (pick.kind === 'dm') {
    S.ws.send(JSON.stringify({ t: 'dm', threadId: pick.id, content, attachments: atts, replyTo: null, fwdFrom }));
  } else {
    S.ws.send(JSON.stringify({ t: 'message', serverId: pick.serverId, channelId: pick.id, content, attachments: atts, replyTo: null, threadRoot: null, fwdFrom }));
  }
  toast('Forwarded');
}
function memberCtxMenu(uid, x, y) {
  const u = memberById(uid);
  if (!u) return;
  const items = [
    { label: 'View profile', icon: '👤', fn: () => openMemberCard(uid, null, y) },
    { label: `Mention @${u.username}`, icon: '@', fn: () => { insertAtCursor($('#in-message'), '@' + u.username + ' '); $('#in-message').focus(); } },
  ];
  if (S.me && uid !== S.me.id) {
    if (S.view === 'server' && S.serverDetail && canManage() && uid !== S.serverDetail.owner_id) {
      items.push({ label: `Kick @${u.username}`, icon: '→', danger: true, fn: () => modServerMember('kick', u) });
      items.push({ label: `Ban @${u.username}`, icon: '⊘', danger: true, fn: () => modServerMember('ban', u) });
    } else if (S.view === 'home' && S.dmThreadId) {
      const t = S.dms.find((t) => t.id === S.dmThreadId);
      if (t && t.isGroup) modGroupItems(items, t, u);
    }
    if (isBlocked(uid)) items.push({ label: `Unblock @${u.username}`, icon: '⊘', fn: () => unblockUser(uid) });
    else items.push({ label: `Block @${u.username}`, icon: '⊘', danger: true, fn: () => blockUser(uid, u.username) });
  }
  openCtx(x, y, items);
}
async function modServerMember(kind, u) {
  const d = S.serverDetail;
  if (!d) return;
  const ok = await openConfirmModal({
    title: `${kind === 'ban' ? 'Ban' : 'Kick'} @${u.username}?`,
    message: kind === 'ban' ? 'They will be removed and blocked from rejoining with invites.' : 'They will be removed from the server.',
    okLabel: kind === 'ban' ? 'Ban' : 'Kick',
  });
  if (!ok) return;
  try {
    await api(`/api/servers/${d.id}/members/${u.id}/${kind}`, { method: 'POST' });
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
// Group chats have no moderator roles: the creator — and only the creator — may
// remove someone, the same rule the server route re-checks (`creator_only`).
// Shared by the member row's right-click / long-press menu and the user card's
// Remove tab so the two can never disagree about who may do it.
function canRemoveGroupMember(t, uid) {
  return !!(t && t.isGroup && t.created_by && S.me && t.created_by === S.me.id
    && uid && uid !== S.me.id && uid !== t.created_by);
}
// The user card's Remove tab (groupRemoveTabHTML in pickers.js, beside
// ucTabHTML) goes through this same predicate.
function modGroupItems(items, t, u) {
  if (!canRemoveGroupMember(t, u && u.id)) return;
  items.push({ label: `Remove @${u.username}`, icon: '→', danger: true, fn: () => modGroupMember(t, u) });
}
/* ================= channel settings (General + Webhooks tabs) ============== */
async function openChannelSettings(sid, c, tab) {
  S.chanSet = { sid, cid: c.id };
  S.chanSetTab = tab === 'webhooks' && c.type === 'text' ? 'webhooks' : 'general';
  renderChanSettings();
  $('#chan-settings-backdrop').classList.remove('hidden');
}
function closeChannelSettings() { S.chanSet = null; $('#chan-settings-backdrop')?.classList.add('hidden'); }
function renderChanSettings() {
  const box = $('#chanset-body');
  if (!box || !S.chanSet) return;
  const d = S.serverDetail;
  const c = d && d.id === S.chanSet.sid ? d.channels.find((v) => v.id === S.chanSet.cid) : null;
  if (!c) { closeChannelSettings(); return; } // channel deleted while open
  $('#chan-settings-title').textContent = `#${c.name} settings`;
  const tabs = [['general', 'General']];
  if (c.type === 'text') tabs.push(['webhooks', 'Webhooks']);
  let sub = S.chanSetTab || 'general';
  if (!tabs.some(([id]) => id === sub)) sub = 'general';
  S.chanSetTab = sub;
  box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'srvset-wrap';
  box.appendChild(wrap);
  const content = document.createElement('div');
  content.className = 'srvset-content';
  if (tabs.length > 1) {
    const rail = document.createElement('div');
    rail.className = 'srv-subtabs vertical';
    for (const [id, label] of tabs) {
      const b = document.createElement('button');
      b.className = 'ftab' + (sub === id ? ' active' : '');
      b.textContent = label;
      b.onclick = () => {
        S.chanSetTab = id;
        rail.querySelectorAll('.ftab').forEach((x) => x.classList.toggle('active', x === b));
        content.querySelectorAll('[data-csub]').forEach((x) => (x.style.display = x.dataset.csub === id ? '' : 'none'));
      };
      rail.appendChild(b);
    }
    wrap.appendChild(rail);
  }
  wrap.appendChild(content);
  const sec = (id) => { const el = document.createElement('div'); el.dataset.csub = id; el.style.display = sub === id ? '' : 'none'; content.appendChild(el); return el; };
  // general
  const g = sec('general');
  const slows = [[0, 'Off'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes']];
  g.innerHTML = `
    <label>Channel name<input id="chanset-name" maxlength="32" value="${esc(c.name)}" /></label>
    <label style="margin-top:.6rem;display:block">Description<input id="chanset-desc" maxlength="200" placeholder="What's this channel about?" value="${esc(c.description || '')}" /></label>
    <label style="margin-top:.6rem;display:block">Slow mode<select id="chanset-slow">${slows.map(([v, l]) => `<option value="${v}"${(c.slowmode || 0) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="nsfw-row"><input type="checkbox" id="chanset-nsfw" class="gcheck"${c.nsfw ? ' checked' : ''} /><span><b>NSFW channel</b><span class="muted small">Members must confirm they are 18 or older before entering. Asked once per account.</span></span></label>
    <div class="row" style="margin-top:.8rem"><button type="button" class="btn small primary" id="chanset-save">Save</button></div>`;
  g.querySelector('#chanset-save').onclick = async () => {
    const name = g.querySelector('#chanset-name').value.trim().replace(/\s+/g, '-');
    if (!name) { toast('Give the channel a name'); return; }
    const { sid, cid } = S.chanSet || {};
    try {
      await api(`/api/servers/${sid}/channels/${cid}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description: g.querySelector('#chanset-desc').value.trim(), slowmode: Number(g.querySelector('#chanset-slow').value), nsfw: g.querySelector('#chanset-nsfw').checked }),
      });
      toast('Channel saved');
    } catch (err) { toast('Save failed: ' + prettyError(err.message)); return; }
    renderServerTab();
    if (sid === S.serverId) {
      // Preserve whatever channel the admin was viewing — selectServer()
      // otherwise jumps to the first text channel after every save.
      const keep = S.channelId;
      await selectServer(sid);
      if (keep && S.serverDetail?.channels.find((x) => x.id === keep && x.type === 'text') && S.channelId !== keep) {
        selectChannel(keep, { keepNav: true });
      }
    }
  };
  // webhooks (text channels only)
  if (c.type === 'text') renderChanWebhooks(sec('webhooks'), S.chanSet.sid, c.id);
}
/* ================= channel webhooks ================= */
// Admins mint webhooks per text channel: each gets its own name + avatar
// and a secret URL that posts into the channel with no account (bots,
// feeds, CI). Posting can override the name/avatar per message.
// Lives as a tab inside channel settings (renderChanSettings above).
async function renderChanWebhooks(box, sid, cid) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  box.innerHTML = '<p class="muted small">Loading…</p>';
  let hooks = [];
  try {
    ({ webhooks: hooks } = await api(`/api/servers/${sid}/channels/${cid}/webhooks`));
  } catch { box.innerHTML = '<p class="muted small">Could not load webhooks.</p>'; return; }
  if (!box.isConnected) return;
  const refresh = () => renderChanWebhooks(box, sid, cid);
  box.innerHTML = '';
  const intro = document.createElement('p');
  intro.className = 'muted small';
  intro.innerHTML = `Each webhook posts into <b>#${esc(c ? c.name : '')}</b> through its own secret URL — no account needed. Anyone with a URL can post, so share them carefully. A post may override the name and avatar per message (<b>username</b> / <b>avatar_url</b>); past messages keep whatever they were sent with.`;
  box.appendChild(intro);
  const list = document.createElement('div');
  list.id = 'wh-list';
  box.appendChild(list);
  if (!hooks.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.textAlign = 'center';
    p.textContent = 'No webhooks yet — create one below.';
    list.appendChild(p);
  }
  for (const w of hooks) list.appendChild(webhookRow(sid, w, refresh));
  const add = document.createElement('div');
  add.className = 'wh-create';
  add.innerHTML = `<input maxlength="32" placeholder="New webhook name, e.g. Deploy Bot" />`;
  const nameInp = add.querySelector('input');
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn small primary';
  go.textContent = 'Create';
  go.onclick = async () => {
    const name = nameInp.value.trim() || 'Webhook';
    try {
      await api(`/api/servers/${sid}/channels/${cid}/webhooks`, { method: 'POST', body: JSON.stringify({ name }) });
      toast('Webhook created — copy its URL');
    } catch (err) { toast('Create failed: ' + prettyError(err.message)); return; }
    refresh();
  };
  add.appendChild(go);
  box.appendChild(add);
}
let whAvatarTarget = null; // {sid, wid, cid} awaiting the shared file picker
function webhookRow(sid, w, refresh) {
  const row = document.createElement('div');
  row.className = 'wh-row';
  const fullUrl = location.origin + w.url;
  row.innerHTML = `
    <span class="avatar wh-av"></span>
    <div class="wh-main">
      <input class="wh-name" maxlength="32" value="${esc(w.name)}" />
      <div class="wh-urlrow"><input class="wh-url" readonly value="${esc(fullUrl)}" /><button type="button" class="mini wh-copy">Copy</button></div>
    </div>
    <div class="wh-btns">
      <button type="button" class="mini wh-save">Save</button>
      <button type="button" class="mini wh-avatar">Avatar</button>
      <button type="button" class="mini wh-regen" title="Issue a new URL (the current one stops working)">New URL</button>
      <button type="button" class="mini danger wh-del">Delete</button>
    </div>`;
  paintAvatar(row.querySelector('.wh-av'), { display_name: w.name, avatar_url: w.avatar_url });
  row.querySelector('.wh-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(fullUrl); toast('Webhook URL copied'); }
    catch {
      const inp = row.querySelector('.wh-url');
      try { inp.focus(); inp.select(); document.execCommand('copy'); toast('Webhook URL copied'); }
      catch { toast('Copy failed — select the URL manually'); }
    }
  };
  row.querySelector('.wh-save').onclick = async () => {
    const name = row.querySelector('.wh-name').value.trim();
    if (!name) { toast('Give the webhook a name'); return; }
    try {
      await api(`/api/servers/${sid}/webhooks/${w.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      toast('Webhook saved');
    } catch (err) { toast('Save failed: ' + prettyError(err.message)); return; }
    refresh();
  };
  row.querySelector('.wh-avatar').onclick = () => {
    whAvatarTarget = { sid, wid: w.id, cid: w.channel_id };
    let fi = $('#wh-file');
    if (!fi) {
      fi = document.createElement('input');
      fi.type = 'file'; fi.id = 'wh-file'; fi.accept = 'image/*'; fi.style.display = 'none';
      fi.onchange = uploadWebhookAvatar;
      document.body.appendChild(fi);
    }
    fi.value = '';
    fi.click();
  };
  row.querySelector('.wh-regen').onclick = async () => {
    const ok = await openConfirmModal({ title: `New URL for “${w.name}”?`, message: 'The current URL stops working immediately. Update anything posting to it.', okLabel: 'Issue new URL' });
    if (!ok) return;
    try {
      await api(`/api/servers/${sid}/webhooks/${w.id}/regenerate`, { method: 'POST' });
      toast('New webhook URL issued');
    } catch (err) { toast('Failed: ' + prettyError(err.message)); return; }
    refresh();
  };
  row.querySelector('.wh-del').onclick = async () => {
    const ok = await openConfirmModal({ title: `Delete “${w.name}”?`, message: 'Its URL stops working immediately. Messages it already posted stay in chat.', okLabel: 'Delete' });
    if (!ok) return;
    try { await api(`/api/servers/${sid}/webhooks/${w.id}`, { method: 'DELETE' }); toast('Webhook deleted'); }
    catch (err) { toast('Delete failed: ' + prettyError(err.message)); return; }
    refresh();
  };
  return row;
}
async function uploadWebhookAvatar() {
  const fi = $('#wh-file');
  const t = whAvatarTarget;
  const f = fi && fi.files && fi.files[0];
  whAvatarTarget = null;
  if (!f || !t) return;
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await fetch(`/api/servers/${t.sid}/webhooks/${t.wid}/avatar`, { method: 'POST', headers: store.token ? { Authorization: 'Bearer ' + store.token } : {}, body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('http_' + r.status));
    toast('Webhook avatar updated');
  } catch (err) { toast('Avatar failed: ' + prettyError(err.message || 'upload_failed')); return; }
  // Refresh the webhooks tab in place when it is still open (a full panel
  // re-render would also wipe any unsaved General-tab edits).
  try {
    if (S.chanSet && S.chanSet.sid === t.sid && S.chanSet.cid === t.cid && !$('#chan-settings-backdrop')?.classList.contains('hidden')) {
      const secEl = $('#chanset-body [data-csub="webhooks"]');
      if (secEl) renderChanWebhooks(secEl, t.sid, t.cid);
    }
  } catch {}
}
async function modGroupMember(t, u) {
  const ok = await openConfirmModal({
    title: `Remove @${u.username}?`,
    message: 'They will be removed from the group.',
    okLabel: 'Remove',
  });
  if (!ok) return;
  try {
    await api(`/api/dms/${t.id}/members/${u.id}/remove`, { method: 'POST' });
    refreshDms().then(() => renderDmMembers());
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
const BELL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
const MUTE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
// Effective notification mode for the current user: first stored pref in the
// chain wins (channel → server → global), defaulting to 'all'.
function notifEffective(...scopes) {
  for (const s of scopes) if (notifPrefsCache[s]) return notifPrefsCache[s];
  return 'all';
}
function serverMuted(sid) {
  return notifEffective('s:' + sid) === 'muted';
}
function chanMuted(cid) {
  return notifEffective('c:' + cid, 's:' + S.serverId) === 'muted';
}
// Toggle item for a mute/unmute row: unmuting clears your own override, or
// overrides an inherited mute with an explicit 'all'.
function muteToggleItem(muted, ownMuted, labelBase, scope) {
  return {
    label: (muted ? 'Unmute ' : 'Mute ') + labelBase, icon: MUTE_SVG,
    fn: async () => { await setNotifPref(scope, muted ? (ownMuted ? 'inherit' : 'all') : 'muted'); renderServerList(); renderChannels(); },
  };
}
async function openServerNotifSettings(sid) {
  const s = S.servers.find((v) => v.id === sid);
  if (!s) return;
  await refreshNotifPrefs();
  const cur = notifPrefsCache['s:' + sid] || '';
  const glob = notifEffective('global');
  const opt = (v, l) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`;
  openModal(`${esc(s.name)} notifications`, `
    <p class="muted small">How should <b>${esc(s.name)}</b> notify you? This is personal — it does not change anything for other members.</p>
    <label style="margin-top:.6rem;display:block">Notify me<select id="m-notif-mode">
      ${opt('', `Use global default (currently ${NOTIF_LABEL[glob]})`)}
      ${opt('all', 'All messages')}
      ${opt('mentions', 'Mentions only')}
      ${opt('muted', 'Muted')}
    </select></label>
  `, 'Save', async () => {
    await setNotifPref('s:' + sid, $('#m-notif-mode').value || 'inherit');
    renderServerList(); renderChannels();
  });
}
async function openChannelNotifSettings(cid) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  if (!c) return;
  await refreshNotifPrefs();
  const cur = notifPrefsCache['c:' + cid] || '';
  const srv = notifEffective('s:' + S.serverId);
  const opt = (v, l) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`;
  openModal(`#${esc(c.name)} notifications`, `
    <p class="muted small">How should <b>#${esc(c.name)}</b> notify you? This is personal — it does not change anything for other members.</p>
    <label style="margin-top:.6rem;display:block">Notify me<select id="m-notif-mode">
      ${opt('', `Use server default (currently ${NOTIF_LABEL[srv]})`)}
      ${opt('all', 'All messages')}
      ${opt('mentions', 'Mentions only')}
      ${opt('muted', 'Muted')}
    </select></label>
  `, 'Save', async () => {
    await setNotifPref('c:' + cid, $('#m-notif-mode').value || 'inherit');
    renderChannels();
  });
}
function folderMoveItems(sid) {
  const current = serverFolder(sid);
  const items = [{ label: 'New folder', icon: '＋', fn: () => createFolderFromServers([sid]) }];
  if (current) items.push({ label: 'Remove from folder', icon: '↩', fn: () => removeServerFromFolder(sid) });
  const others = S.layoutFolders.filter((f) => f.id !== (current && current.id));
  if (others.length) {
    items.push({ sep: true });
    for (const f of others) items.push({ label: 'Move to ' + (f.name || 'Folder'), icon: '▸', fn: () => moveServerToFolder(sid, f.id) });
  }
  return items;
}
function serverMenuItems(sid) {
  const s = S.servers.find((v) => v.id === sid);
  if (!s) return [];
  const own = notifPrefsCache['s:' + sid] || '';
  return [
    { label: 'Open', icon: '→', fn: () => selectServer(sid) },
    { label: 'Invite links', icon: '⧉', fn: async () => { if (sid !== S.serverId) await selectServer(sid); S.serverSubTab = 'invites'; openServerSettings(); } },
    { label: 'Server settings', icon: '⚙', fn: async () => { if (sid !== S.serverId) await selectServer(sid); openServerSettings(); } },
    { sep: true },
    ...(typeof serverMoveItems === 'function' ? serverMoveItems(sid) : []),
    ...folderMoveItems(sid),
    { sep: true },
    muteToggleItem(serverMuted(sid), own === 'muted', 'server', 's:' + sid),
    { label: 'Notification settings', icon: BELL_SVG, fn: () => openServerNotifSettings(sid) },
    // Only offered when there is something to clear — like "Remove from folder".
    ...(typeof serverUnreadCount === 'function' && serverUnreadCount(sid) ? [{ label: 'Mark all as read', icon: '✓', fn: () => markServerRead(sid) }] : []),
  ];
}
function serverCtxMenu(sid, x, y) { openCtx(x, y, serverMenuItems(sid)); }
function channelMenuItems(cid, ctype) {
  const c = S.serverDetail?.channels.find((v) => v.id === cid);
  if (!c) return [];
  const owner = canManage();
  const items = ctype === 'voice'
    ? [{ label: 'Join voice', icon: '→', fn: () => openVoiceChannel(S.serverId, cid) }]
    : [{ label: 'Open channel', icon: '→', fn: () => selectChannel(cid) }];
  if (ctype === 'text') {
    const own = notifPrefsCache['c:' + cid] || '';
    items.push({ sep: true });
    items.push(muteToggleItem(chanMuted(cid), own === 'muted', '#' + c.name, 'c:' + cid));
    items.push({ label: 'Notification settings', icon: BELL_SVG, fn: () => openChannelNotifSettings(cid) });
  }
  if (owner) {
    items.push({ sep: true });
    items.push({ label: 'Move up', icon: '↑', fn: () => moveChannelRail(cid, -1) });
    items.push({ label: 'Move down', icon: '↓', fn: () => moveChannelRail(cid, 1) });
    items.push({ label: 'Channel settings', icon: '⚙', fn: () => openChannelSettings(S.serverId, c) });
    items.push({ label: 'Delete channel', icon: '🗑', danger: true, fn: () => confirmDeleteChannel(c) });
  }
  return items;
}
function channelCtxMenu(cid, ctype, x, y) { openCtx(x, y, channelMenuItems(cid, ctype)); }
function ctxFor(el, x, y) {
  if (!el || !el.closest) return false;
  // A message owns every pixel of itself, media included: an attachment's rows
  // ride in the message's own menu rather than in a menu of their own, scoped to
  // the file the pointer is actually on (see msgAttItems) — so a right-click on
  // a picture, a player or a file card opens THAT menu with that one file's rows
  // in it, and a right-click on the message's own pixels opens it with none.
  const msg = el.closest('.msg[data-mid]');
  if (msg && msgById(msg.dataset.mid)) { messageCtxMenu(msg.dataset.mid, x, y, el); return true; }
  // An attachment with no message around it — a pinned message's media in the
  // pins panel — has no message menu to merge into, so it keeps its own rows.
  const att = attMenuItems(el);
  if (att) { openCtx(x, y, att); return true; }
  const vu = el.closest('.vuser[data-uid]');
  if (vu && vu.dataset.uid) { openUserCard(vu.dataset.uid, x, y); return true; }
  const mem = el.closest('.member[data-uid]');
  if (mem && mem.dataset.uid) { memberCtxMenu(mem.dataset.uid, x, y); return true; }
  const sb = el.closest('.server-btn');
  if (sb && sb.dataset.sid) { serverCtxMenu(sb.dataset.sid, x, y); return true; }
  const dmr = el.closest('[data-dmthread]');
  if (dmr && dmr.dataset.dmthread) { dmCtxMenu(dmr.dataset.dmthread, x, y); return true; }
  const ch = el.closest('.chan');
  if (ch && ch.dataset.cid) { channelCtxMenu(ch.dataset.cid, ch.dataset.ctype || 'text', x, y); return true; }
  return false;
}
document.addEventListener('contextmenu', (e) => {
  // A link is the browser's (open in new tab, copy link) — except an attachment,
  // which carries its own identity and has its own menu.
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], a:not([data-att-id])')) return;
  // On touch-primary devices the long-press is owned by the bottom-sheet/popup
  // handler below. Suppress the native menu AND the desktop-style popup here so
  // they don't both appear alongside the slide-up sheet. Desktop right-click
  // keeps the ctxFor popup.
  if (isCoarse()) { e.preventDefault(); return; }
  if (ctxFor(e.target, e.clientX, e.clientY)) e.preventDefault();
});
// touch-hold (long press): bottom sheet for messages, popup menus elsewhere
let holdT = null;
let holdSheet = false; // long-press opened the sheet: swallow the lift-off click
let holdMenu = false; // long-press opened a ctx menu: swallow the lift-off click too
let holdX = 0, holdY = 0; // finger jitter must not cancel a hold; only real moves do
// (non-passive so preventDefault() can cancel the synthetic click)
document.addEventListener('touchend', (e) => {
  if (holdSheet) { holdSheet = false; try { e.preventDefault(); } catch {} }
  if (holdMenu) { holdMenu = false; try { e.preventDefault(); } catch {} }
}, { passive: false });
document.addEventListener('touchstart', (e) => {
  noteTouchStart();
  // A link is the browser's (its own long-press sheet) — except an attachment's
  // own link: the plain file card IS an `<a data-att-id>`, and its rows now live
  // behind the pointer alone, so it has to be holdable like every other
  // rendering of an attachment. The download chip inside a wrap (a link with no
  // identity of its own) is still the browser's.
  if (!e.target.closest || e.target.closest('input, textarea, select, a:not([data-att-id])')) return;
  const t = e.target.closest('.msg,.chan,.member,.server-btn,.folder-btn,.vuser,[data-dmthread],.att-wrap,[data-att-id]');
  if (!t) return;
  const touch = e.touches[0];
  const x = touch.clientX, y = touch.clientY;
  holdX = x; holdY = y;
  holdMenu = false;
  holdT = setTimeout(() => {
    holdT = null;
    haptic(12); // the long-press that opens a menu is one of the few beats left
    // A message takes the hold on any of its pixels: holding a picture slides up
    // the same sheet the message body opens, with THAT file's rows in it (and
    // holding the body itself opens it with none — see msgAttItems).
    const mt = t.closest('.msg[data-mid]');
    if (mt && isCoarse() && msgById(mt.dataset.mid)) { holdSheet = true; openMsgSheet(mt.dataset.mid, t); return; }
    // An attachment with no message around it (a pinned message's media) still
    // gets the attachment's own sheet — the same rows, headed by the file.
    const aw = t.closest('[data-att-id]');
    if (aw && isCoarse()) {
      const att = attMenuItems(aw);
      if (att) { holdSheet = true; openCtxSheet(att, mediaSheetHead(aw)); return; }
    }
    const ch = t.closest('.chan[data-cid]');
    if (ch && isCoarse()) { holdSheet = true; openChannelSheet(ch.dataset.cid, ch.dataset.ctype); return; }
    const sb = t.closest('.server-btn[data-sid]');
    if (sb && isCoarse()) { holdSheet = true; openServerSheet(sb.dataset.sid); return; }
    const fb = t.closest('.folder-btn[data-fid]');
    if (fb && isCoarse()) { holdSheet = true; openFolderSheet(fb.dataset.fid); return; }
    // DM / group rows get their own slide-up sheet (open, pin, group settings,
    // add members, leave) — never the desktop popup the generic ctxFor path
    // would open on a touch screen.
    const dmr = t.closest('[data-dmthread]');
    if (dmr && isCoarse()) { holdSheet = true; openDmSheet(dmr.dataset.dmthread); return; }
    if (ctxFor(t, x, y)) holdMenu = true;
  }, 550);
}, { passive: true });
['touchend', 'touchcancel'].forEach((ev) => document.addEventListener(ev, () => { clearTimeout(holdT); holdT = null; }, { passive: true }));
// touchmove only cancels a hold on a real move (finger jitter is normal)
document.addEventListener('touchmove', (e) => {
  const t = e.touches && e.touches[0];
  if (t && Math.hypot(t.clientX - holdX, t.clientY - holdY) > 12) {
    clearTimeout(holdT);
    holdT = null;
    noteTouchMove(); // the finger is exploring: hover is real feedback now
  }
}, { passive: true });
// A real mouse move means we are back to a pointer that can hover (hybrid
// devices) — touch→mouse compatibility events are MouseEvents, not pointer
// events, so this cannot fire spuriously after a touch.
document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') noteTouchMove(); }, { passive: true });

