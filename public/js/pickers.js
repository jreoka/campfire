'use strict';
/* ================= v2 features: emoji, GIFs, replies, threads, reactions, cards, settings ================= */
const EMOJI = [
 ['sec','Smileys & people'],
 ['😀','grinning smile happy'],['😁','grin happy'],['😂','joy laugh lol tears'],['🤣','rofl laugh'],['😊','smile blush'],['😍','heart eyes love'],['😘','kiss'],['😎','cool sunglasses'],['🤔','thinking hmm'],['😴','sleep tired'],['🤯','mind blown'],['🥳','party celebrate'],['😢','cry sad tears'],['😭','sob cry'],['😡','angry rage'],['💀','skull dead lol'],['👍','thumbs up yes'],['👎','thumbs down no'],['👏','clap applause'],['🙏','pray thanks please'],['👋','wave hi hello'],['👀','eyes look'],['💪','muscle strong'],
 ['sec','Hearts & fun'],
 ['❤️','heart love red'],['💔','broken heart'],['💯','100 hundred'],['✨','sparkles new'],['🔥','fire lit'],['🎉','party tada celebrate'],['⭐','star'],['🌈','rainbow'],['🎮','game controller gaming'],['🚀','rocket ship'],['🎁','gift present'],['🏆','trophy win'],['🎵','music note'],['💡','idea lightbulb'],['✅','check yes'],['❌','cross no'],['❓','question'],['💩','poop'],['👻','ghost'],['🤖','robot'],['🍕','pizza'],['☕','coffee'],['🐱','cat kitten'],['🐶','dog puppy'],
];
S.picker = null; // {mode:'insert'|'react'|'tag'|'field', mid?, input?}
S.pickerReturnFocus = null; // the field a phone picker took the caret from
// The dialog layers a profile field can live in. A picker opened from one has to
// beat it (see #picker.pk-over in styles.css): #picker is z-index 150 and the
// dialog layer reaches 175, so without the lift the picker for a status would
// open BEHIND the very dialog holding the field.
const PICKER_DIALOG_SEL = '#modal-backdrop,#settings-backdrop,#srv-settings-backdrop,#chan-settings-backdrop,#profile-backdrop,#story-new';

// ---------- emoji / GIF picker ----------
// `input` names the composer field a pick belongs to: 'main' (the chat bar, the
// default) or 'thread' (the thread bar). Both bars are on screen at once, so the
// picker cannot ask "which composer is open" — it has to be told.
//
// ON A PHONE THE PICKER TAKES THE KEYBOARD'S PLACE, it does not sit on top of it.
// Opening it dismisses the keyboard (the caret is remembered and handed back
// when the picker closes) and the sheet then fills the room the keys gave up,
// measured rather than guessed — see sizePicker and the phone block in
// styles.css. Keyboard-down is the normal state, which is the whole point: a
// picker and a keyboard competing for a 400px screen leaves neither usable.
function openPicker(mode = 'insert', mid = null, tab = 'emoji', anchor = null, input = null, opts = null) {
  S.picker = { mode, mid, input, ...(opts || {}) };
  const pk = $('#picker');
  pk.classList.remove('hidden');
  const phone = phoneLayout();
  // `field` (a status / bio box) carries the ELEMENT it is inserting into, not a
  // bar name, and that element lives in a dialog the picker has to sit over.
  pk.classList.toggle('pk-over', !!(input && input.closest && input.closest(PICKER_DIALOG_SEL)));
  // The caret the phone picker is about to take (the field that opened it), so
  // closing the picker can hand it straight back — see closePicker. Only an
  // editable counts: a phone has no caret to return when nothing was focused,
  // and the picker's own search field is never the answer.
  S.pickerReturnFocus = phone ? (cfEditable(document.activeElement) ? document.activeElement : null) : null;
  if (anchor && !phone) {
    // The reaction/field picker floats near the button that opened it
    // (desktop only; mobile keeps the bottom-sheet). Prefer above, fall back
    // below, clamped. The composer picker (insert mode) is different: it only
    // borrows the anchor's x for horizontal placement — vertically it parks
    // above the composer via sizePicker's desktop branch, so it never slides
    // over the message input or gets its bottom cut off.
    const w = Math.min(460, innerWidth - 32);
    const left = Math.min(Math.max(8, anchor.x - w / 2), Math.max(8, innerWidth - w - 8));
    pk.style.left = left + 'px';
    if (mode === 'insert') {
      pk.classList.remove('anchored');
      pk.style.top = '';
    } else {
      pk.classList.add('anchored');
      const h = 380;
      let top = anchor.y - h - 10;
      if (top < 8) top = anchor.y + 12;
      if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
      pk.style.top = top + 'px';
    }
  } else {
    pk.classList.remove('anchored');
    pk.style.left = ''; pk.style.top = '';
  }
  // Blur the composer AFTER the anchor has been measured (blurring collapses the
  // keyboard, which moves the composer, which would move the anchor). Never
  // focus the search field here: a phone must not answer an emoji key with a
  // keyboard, and the field is one tap away for anyone who wants to search.
  if (phone) { try { document.activeElement && document.activeElement.blur(); } catch {} }
  setPickerTab(tab);
  document.querySelector('#picker .pk-tabs').style.display = mode === 'react' ? 'none' : '';
  // The GIF tab POSTS into the conversation, so it only ever belongs to a
  // composer pick: from a profile field (or the server-tag editor) the button
  // would have nowhere to go and clicking a GIF would post to chat.
  const gifTab = document.querySelector('#picker .pk-tab[data-ptab="gifs"]');
  if (gifTab) gifTab.classList.toggle('hidden', mode !== 'insert');
  $('#pk-search').value = '';
  renderEmojiRail();
  renderEmojiGrid('');
  ensureEmojiData().then(() => { if (S.picker) renderEmojiGrid($('#pk-search').value); });
  if (mode === 'insert') loadGifTrending();
  loadGifFavs();
  sizePicker();
  if (!phone) setTimeout(() => { const s = $('#pk-search'); if (S.picker) s.focus(); }, 0);
}

// How much room the picker is actually allowed, measured from live geometry
// instead of assumed from a vh (see the phone block in styles.css). Applies the
// cap inline so it wins over the stylesheet, and clears it if anything cannot be
// measured — a missing number must fall back to the stylesheet, never collapse
// the sheet to nothing.
//
// The base is the VISUAL viewport, never the layout box: on a resizes-content
// viewport (Android) the layout box has already shrunk for the keys, and on a
// visual-only one (iOS / a WebView that ignores the hint) it has not — the
// visual viewport is the only surface height that is right in both. --kb is
// deliberately NOT subtracted here: it is what puts the sheet's bottom edge on
// the keyboard's top edge (the `bottom` in styles.css), and taking it off the
// height too would charge the composer's height twice.
function sizePicker() {
  const pk = $('#picker');
  if (!pk || pk.classList.contains('hidden')) return;
  const vvh = (window.visualViewport && window.visualViewport.height) || innerHeight;
  const comp = $('#composer');
  const strip = $('#typing-bar');
  let max;
  let stackTop = Infinity, layoutH = 0; // desktop branch fills these; debug readout below needs them
  if (phoneLayout() && comp && comp.offsetHeight) {
    pk.style.bottom = '';
    // With the keyboard up (the sheet is in its .pk-kb mode) the room above the
    // composer is the whole point, so the 18vh of chat kept visible while the
    // keyboard is DOWN no longer applies — it would push the sheet off the top.
    const forChat = pk.classList.contains('pk-kb') ? 8 : Math.round(vvh * 0.18);
    max = vvh - comp.offsetHeight - (strip ? strip.offsetHeight : 0) - forChat;
  } else if (pk.classList.contains('anchored')) {
    // The reaction picker floats near its anchor button: openPicker sets its
    // top/left and the stylesheet keeps bottom:auto, so only the height is
    // capped here and the inline footing below must not touch it.
    pk.style.bottom = '';
    max = Math.min(560, vvh - 16);
  } else {
    // Desktop composer pick: the sheet floats above the composer, so its
    // footing is anchored to the REAL top of the bottom stack — the composer
    // (which grows with multi-line drafts), the typing strip, and any visible
    // staged-attachment / upload rows — measured with getBoundingClientRect,
    // which reports visual-viewport coords from the actual layout. Summing
    // offsetHeights into a `bottom` offset breaks when the layout viewport is
    // stale/taller than the visible window (some WebViews): the offset lands
    // the sheet too low, it slides over the message input, and its own bottom
    // rows get cut off. Anchoring to the stack's measured top keeps it parked
    // above the input in every case.
    stackTop = Infinity;
    for (const sel of ['#attach-preview', '#upload-list', '#typing-bar', '#composer']) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 0) stackTop = Math.min(stackTop, el.getBoundingClientRect().top);
    }
    if (!isFinite(stackTop)) stackTop = vvh - 80; // shouldn't happen; assume an 80px composer
    // `bottom` resolves against the layout viewport while the rect is in
    // visual-viewport coords; the two share their top edge, so converting via
    // the layout height parks the sheet exactly GAP px above the stack.
    layoutH = document.documentElement.clientHeight || window.innerHeight;
    const GAP = 8;
    pk.style.bottom = Math.max(0, Math.round(layoutH - stackTop + GAP)) + 'px';
    // 480px keeps it a comfortable size on tall screens; stackTop is the room
    // above the stack, so this also keeps it off the viewport's top edge.
    max = Math.min(480, stackTop - GAP - 16);
  }
  if (!(max > 0)) { pk.style.maxHeight = ''; return; }
  pk.style.maxHeight = Math.max(180, Math.round(max)) + 'px';
}

// A phone's picker is the keyboard's stand-in, and the user sizes it the way
// they size a sheet: dragging it by its top edge/header. Reuses the same
// "settle on the side the finger was on" feel as #sheet, but the decision is a
// measured max-height rather than a class, because the sheet is already as tall
// as it can sensibly be. Deliberately only from the chrome (the tabs row and the
// empty space beside it) — a drag that starts on a tile is a scroll of that tile
// list, and must never turn into a resize.
function pickerDragResize(pk) {
  let startY = 0, startH = 0, active = false, dir = 0;
  const onGrab = (t) => !!t.closest('.pk-tabs, .pk-resize-grip');
  pk.addEventListener('touchstart', (e) => {
    active = false; dir = 0;
    if (e.touches.length !== 1 || !phoneLayout() || !onGrab(e.target)) return;
    active = true;
    startY = e.touches[0].clientY;
    startH = pk.offsetHeight;
  }, { passive: true });
  pk.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const d = startY - e.touches[0].clientY; // up is positive (taller)
    if (!dir) {
      if (Math.abs(d) < 6) return;
      dir = d > 0 ? 1 : -1;
    }
    e.preventDefault();
    pk.classList.add('pk-resizing');
    const vvh = (window.visualViewport && window.visualViewport.height) || innerHeight;
    pk.style.height = Math.max(160, Math.min(vvh - 60, startH + d)) + 'px';
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false; dir = 0;
    pk.classList.remove('pk-resizing');
    const h = parseFloat(pk.style.height) || 0;
    pk.style.height = '';
    pk.style.maxHeight = '';
    sizePicker();
    // Never shorter than the search row plus one row of tiles: a sheet dragged
    // to nothing is a sheet the reader cannot get back without closing it.
    if (h && h < 200) pk.style.maxHeight = '200px';
  };
  pk.addEventListener('touchend', end);
  pk.addEventListener('touchcancel', end);
}

// `focusBack` names the field to hand the caret to, and defaults to the one the
// picker took it from. A pick passes BOTH: `restoreFocus` picks the behaviour
// (a pick hands the caret back, a dismissal never does) and the element decides
// WHICH bar — an emoji can be tapped before its composer ever had the caret, so
// the stashed node is not always there to return to.
function closePicker(restoreFocus = true, focusBack = undefined) {
  const pk = $('#picker');
  if (!pk || pk.classList.contains('hidden')) return;
  pk.classList.add('hidden');
  pk.style.maxHeight = '';
  pk.style.height = '';
  pk.classList.remove('pk-resizing');
  pk.classList.remove('pk-kb');
  S.picker = null;
  S.gifPick = null;
  // A phone picker took the caret to give the keyboard back, so a pick hands the
  // caret back — without this, every emoji change costs a tap on the field you
  // were already typing in. preventScroll: focusing the composer at the bottom
  // of the document would otherwise scroll the pane and knock the sheet off
  // screen mid-close.
  //
  // Only a PICK does that. Dismissing the sheet (its ✕, a tap outside, Escape,
  // the back gesture) is the reader asking for the sheet to GO, and handing the
  // caret back would answer that by raising the keyboard straight away.
  const back = focusBack === undefined ? S.pickerReturnFocus : focusBack;
  S.pickerReturnFocus = null;
  if (restoreFocus && back && back.isConnected) {
    try { back.focus({ preventScroll: true }); } catch { try { back.focus(); } catch {} }
  }
}
S.gifPick = null; // 'avatar'|'banner' when the GIF picker is choosing profile media
S.tagEmojiInput = null; // target button when the picker is choosing a server-tag emoji
S.tagEmojiDone = null; // repaint callback after a tag-emoji pick

// ---------- keyboard-aware sizing ----------
// The picker has to be sized against the space that really exists on screen. The
// viewport meta asks for interactive-widget=resizes-content, so on Android the
// LAYOUT viewport normally shrinks with the keyboard and dvh/vh already reflect
// it — but iOS always resizes only the visual viewport, and a WebView may ignore
// the hint entirely. Measuring both viewports is what tells them apart: if the
// layout box is materially taller than the visible one, the difference IS the
// keyboard, and everything anchored to the layout box is about to sit behind it.
// (voice.js keeps --vvh in sync off the same measurements; this is the other
// half of that contract.)
//
// --kb and --vv-top are those two viewports reduced to the numbers the CSS
// needs: --kb is how much of the layout box the keys cover at the BOTTOM, and
// --vv-top is how far the visible area sits below the layout box's top (a
// visual-only engine PANS the page instead of resizing it, and then the visible
// strip is not at y=0). --vvh is the visible height. A fixed layer that wants to
// BE the visible strip is `top:var(--vv-top);bottom:var(--kb)` — nothing else
// gets that right in both models (see #modal-backdrop and #usercard.sheet).
function keyboardOffset() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const doc = document.documentElement;
  const layoutH = Math.max(doc ? doc.clientHeight : 0, window.innerHeight || 0);
  return Math.max(0, Math.round(layoutH - vv.height - vv.offsetTop));
}
function wirePickerViewport() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  let raf = 0;
  const sync = () => {
    const root = document.documentElement.style;
    root.setProperty('--kb', keyboardOffset() + 'px');
    root.setProperty('--vv-top', Math.max(0, Math.round(vv.offsetTop)) + 'px');
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; try { sizePicker(); } catch {} });
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', sync);
  sync();
}
wirePickerViewport();
// The finger owns the height while it is down; the measured cap comes back after
// (see pickerDragResize, which clears both inline values before re-measuring).
pickerDragResize($('#picker'));
// Focusing the picker's own search field is the one moment the keyboard is
// welcome back — while it is up the sheet becomes a fixed box whose bottom edge
// is the keyboard's top (see #picker.pk-kb). A CLASS, not :has(#pk-search:focus):
// :focus only applies while the DOCUMENT itself is focused, which is not always
// true of an embedded WebView, and this decision must not depend on that.
function paintPickerKeyboard() {
  const pk = $('#picker');
  if (!pk) return;
  const on = document.activeElement === $('#pk-search');
  pk.classList.toggle('pk-kb', on);
  try { sizePicker(); } catch {}
}
$('#pk-search').addEventListener('focus', paintPickerKeyboard);
$('#pk-search').addEventListener('blur', paintPickerKeyboard);
// The close key the sheet's own chrome carries (phones have no Escape and the
// chat behind the sheet is mostly covered, so outside-click is a thin target).
$('#pk-close').onclick = (e) => { e.stopPropagation(); S.pickerReturnFocus = null; closePicker(false); };
function setPickerTab(t) {
  document.querySelectorAll('.pk-tab').forEach((b) => b.classList.toggle('active', b.dataset.ptab === t));
  $('#pk-emoji').classList.toggle('hidden', t !== 'emoji');
  $('#picker .pk-body').classList.toggle('hidden', t !== 'emoji');
  $('#pk-gifs').classList.toggle('hidden', t !== 'gifs');
  $('#pk-klipy').classList.toggle('hidden', t !== 'gifs');
  $('#pk-search').placeholder = t === 'gifs' ? 'Search KLIPY' : 'Search emoji';
  if (t === 'emoji') renderEmojiRail();
  if (t === 'gifs') { gifSubView = 'all'; renderGifTab(); }
}
document.querySelectorAll('.pk-tab').forEach((b) => (b.onclick = () => { setPickerTab(b.dataset.ptab); applyPickerSearch($('#pk-search').value || ''); }));
let emojiData = null, emojiLoadP = null;
function ensureEmojiData() {
  if (emojiData) return Promise.resolve(emojiData);
  if (!emojiLoadP) {
    emojiLoadP = fetch('/emoji.json').then((r) => {
      if (!r.ok) throw new Error('no dataset');
      return r.json();
    }).then((j) => { emojiData = j; return j; }).catch(() => null);
  }
  return emojiLoadP;
}
// Load the full emoji dataset (if needed) and build the :shortcode: -> char
// map used by renderRich. Awaited in boot() before first message render.
function warmStdEmoji() {
  return ensureEmojiData().then(() => {
    S.stdEmoji = {};
    const sc = emojiData && emojiData.shortcodes;
    if (sc) for (const [name, ch] of Object.entries(sc)) S.stdEmoji[name] = ch;
  });
}
function emojiButton(box, ch, label, onclick) {
  const b = document.createElement('button');
  b.className = 'pk-emoji-btn';
  b.textContent = ch;
  if (label) b.title = label;
  b.onclick = onclick;
  box.appendChild(b);
}
// Emoji tab navigation: 'Emoji' (standard) or a joined server's custom
// emoji (Discord-style server rail). Search spans all servers + standard.
let emojiPickServer = null; // server id in the rail (null = standard view)
function emojiCustomBtn(box, n, url) {
  const b = document.createElement('button');
  b.className = 'pk-emoji-btn'; b.title = ':' + n + ':';
  b.innerHTML = `<img class="pk-custom" src="${esc(url)}" alt=":${esc(n)}:" />`;
  b.onclick = () => pickEmoji(':' + n + ':');
  box.appendChild(b);
}
function renderStdGroups(box, f) {
  let shown = 0;
  if (emojiData) {
    for (const g of emojiData.groups) {
      const items = f ? g.items.filter((it) => it[1].includes(f)) : g.items;
      if (!items.length) continue;
      const capped = f ? items.slice(0, 120) : items;
      box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(g.name)}${f && items.length > capped.length ? ` (${items.length})` : ''}</div>`);
      for (const [ch] of capped) {
        emojiButton(box, ch, null, () => pickEmoji(ch));
        if (f && ++shown >= 400) break;
      }
      if (f && shown >= 400) break;
    }
  } else {
    for (const [ch, kw] of EMOJI) {
      if (ch === 'sec') { box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(kw)}</div>`); continue; }
      if (f && !(kw || '').includes(f)) continue;
      emojiButton(box, ch, null, () => pickEmoji(ch));
    }
  }
}
function renderEmojiRail() {
  const rail = $('#pk-server-rail');
  if (!rail) return;
  rail.innerHTML = '';
  const mk = (ico, name, active, fn) => {
    const b = document.createElement('button');
    b.className = 'pk-rail-btn' + (active ? ' active' : '');
    b.innerHTML = `<span class="pk-rail-ico">${ico}</span><span class="pk-rail-name">${esc(name)}</span>`;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    rail.appendChild(b);
  };
  mk('<span class="pk-rail-std">😀</span>', 'Emoji', emojiPickServer === null, () => { emojiPickServer = null; renderEmojiRail(); renderEmojiGrid($('#pk-search').value); });
  for (const s of S.serverEmojis || []) {
    const sv = (S.servers || []).find((x) => x.id === s.id);
    const letter = (s.name || 'S').trim().charAt(0).toUpperCase();
    const ico = sv && sv.icon_url
      ? `<img src="${esc(sv.icon_url)}" alt="" loading="lazy" draggable="false" onerror="this.replaceWith(document.createTextNode('${letter}'))" />`
      : letter;
    mk(ico, s.name, emojiPickServer === s.id, () => { emojiPickServer = s.id; renderEmojiRail(); renderEmojiGrid($('#pk-search').value); });
  }
}
function renderEmojiGrid(filter) {
  const box = $('#pk-emoji');
  box.innerHTML = '';
  const f = filter.trim().toLowerCase();
  if (f) {
    // search spans every joined server's custom emoji + standard
    for (const s of S.serverEmojis || []) {
      const hits = s.emoji.filter((e) => e.name.toLowerCase().includes(f));
      if (!hits.length) continue;
      box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(s.name)}</div>`);
      for (const e of hits) emojiCustomBtn(box, e.name, e.url);
    }
    renderStdGroups(box, f);
  } else if (emojiPickServer) {
    const s = (S.serverEmojis || []).find((x) => x.id === emojiPickServer);
    if (!s || !s.emoji.length) box.innerHTML = '<div class="pk-empty">No custom emoji in this server yet.</div>';
    else {
      box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${esc(s.name)}</div>`);
      for (const e of s.emoji) emojiCustomBtn(box, e.name, e.url);
    }
  } else {
    renderStdGroups(box, '');
  }
  if (!box.children.length) box.innerHTML = '<div class="pk-empty">No emoji match.</div>';
}
// The field the open picker belongs to (see openPicker). The elements are never
// re-created, so naming the bar is enough — and safer than holding a node. A
// `field` pick carries the element itself (a status / bio box), which is not a
// composer at all.
function pickerBar() { return S.picker && S.picker.input === 'thread' ? 'thread' : 'main'; }
function pickerInputEl() {
  if (S.picker && S.picker.mode === 'field' && S.picker.input && S.picker.input.isConnected) return S.picker.input;
  return pickerBar() === 'thread' ? $('#in-thread') : $('#in-message');
}
// Is this the unicode emoji a plain-text surface can hold? A custom `:name:` is
// an image in a message, and neither a server tag (a name suffix) nor a status
// (escaped text) can show one.
function isStdEmoji(e) { return /\p{Extended_Pictographic}/u.test(e) && !/^:[\w+-]+:$/.test(e); }
function pickEmoji(e) {
  haptic(10); // picking an option ticks; merely opening the picker does not
  if (S.picker?.mode === 'tag') {
    // Server-tag emoji: standard unicode emoji only (no custom :shortcodes:).
    // Done (auto-save) runs only on a valid pick.
    if (!isStdEmoji(e)) { toast('Tags support standard emoji only'); }
    else {
      if (S.tagEmojiInput && S.tagEmojiInput.isConnected) S.tagEmojiInput.dataset.emoji = e;
      try { S.tagEmojiDone && S.tagEmojiDone(); } catch {}
    }
    S.tagEmojiInput = null; S.tagEmojiDone = null;
    closePicker(false); // a tag editor is not this picker's composer
    return;
  }
  // A status is escaped plain text (statusBubbleHTML), so a custom :name: would
  // sit there literally — the picker is held to standard emoji for it. A bio
  // goes through renderRich like a message and takes both.
  if (S.picker?.mode === 'field' && S.picker.stdOnly && !isStdEmoji(e)) {
    toast('Status supports standard emoji only');
    return;
  }
  const inp = pickerInputEl();
  if (S.picker?.mode === 'react' && S.picker.mid) toggleReaction(S.picker.mid, e);
  // Inserting an emoji into a message is TEXT, not a reaction: it must not feed
  // the quick-reaction strips (topReactions reads reaction use only).
  else insertAtCursor(inp, e);
  // Hand the caret to the bar the emoji belonged to (closePicker owns the focus,
  // with the preventScroll a phone needs so the sheet does not jump on the way
  // out) — except on a phone, where the next tap is the next emoji and popping
  // the keyboard back up under the sheet is exactly what this layout avoids.
  closePicker(!phoneLayout(), inp);
}
// The two composer bars are the only fields the draft store owns; a profile
// field (status, bio) is not one, and filing its text as a chat draft would put
// a bio in the message box on the next channel switch.
function isComposerField(el) { return !!el && (el.id === 'in-message' || el.id === 'in-thread'); }
function insertAtCursor(input, text) {
  if (!input) return;
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  syncRenderFor(input);
  // A plain field is not a composer: it gets a real 'input' event instead (the
  // bio counter listens for one) and never a draft write.
  if (!isComposerField(input)) {
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    return;
  }
  // Programmatic insert (emoji / mention pickers) fires no 'input' event, so
  // the composer draft has to be told about it explicitly.
  try { draftSoon(input, draftCtxForEl(input)); } catch {}
}
// One backdrop painter per bar; the caller says which field it just changed.
function syncRenderFor(input) {
  if (!isComposerField(input)) return;
  if (input.id === 'in-thread') { try { syncThreadRender(); } catch {} return; }
  try { syncComposerRender(); } catch {}
}
// ---------- the emoji button inside a profile field (status, bio) ----------
// The icon is chrome, so it is an inline SVG smiley and never an emoji glyph
// (see the design language in AGENTS.md). The buttons in index.html carry the
// same svg literally, the way every other shell button does.
const EMOJI_FIELD_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.3 14.3a4.6 4.6 0 0 0 7.4 0"/><circle cx="9" cy="9.8" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9.8" r="1.1" fill="currentColor" stroke="none"/></svg>';
// `opts.std` marks a field that can only hold standard emoji (a status);
// `opts.area` is a textarea, whose button sits in the bottom-right corner.
function emojiFieldHTML(field, opts = {}) {
  return `<span class="emoji-field${opts.area ? ' area' : ''}">${field}`
    + `<button type="button" class="emoji-field-btn"${opts.std ? ' data-emoji-std="1"' : ''} title="Add emoji" aria-label="Add emoji">${EMOJI_FIELD_ICON}</button></span>`;
}
// Open the picker for a profile field. `mode:'field'` carries the element, so a
// pick inserts at its caret and closePicker hands the caret back to it; desktop
// floats the picker against the button that opened it, a phone gets the sheet.
function openFieldPicker(field, btn, opts = {}) {
  if (!field || field.disabled || field.readOnly) return;
  const r = btn.getBoundingClientRect();
  openPicker('field', null, 'emoji', { x: r.left + r.width / 2, y: r.top }, field, { stdOnly: !!opts.stdOnly });
}
// One delegated handler for every one of them: the buttons are static (settings)
// or painted later (the status editor, the admin user editor), so the button
// names the field it sits in instead of each surface wiring its own. Clicking
// the button of the field the picker is already editing closes it, like the
// composer's own emoji button.
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.emoji-field-btn') : null;
  if (!btn) return;
  const wrap = btn.closest('.emoji-field');
  const field = wrap && wrap.querySelector('input,textarea');
  if (!field) return;
  const pk = $('#picker');
  if (S.picker && S.picker.mode === 'field' && S.picker.input === field && !pk.classList.contains('hidden')) {
    S.pickerReturnFocus = null;
    closePicker(false);
    return;
  }
  openFieldPicker(field, btn, { stdOnly: btn.hasAttribute('data-emoji-std') });
});
// The autocomplete popovers are anchored to the chat bar. A completion in the
// thread bar has to sit over the thread panel instead, so the pop is placed
// against the field it belongs to (measured, like the picker). The chat bar's own
// placement stays exactly as the stylesheet has it.
function anchorPopToInput(pop, input) {
  if (!pop) return;
  if (!(input && input.closest && input.closest('#thread-composer'))) {
    pop.style.position = ''; pop.style.left = ''; pop.style.right = ''; pop.style.bottom = '';
    return;
  }
  const box = input.closest('#thread-composer-box') || input;
  const r = box.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.left = Math.round(Math.max(8, r.left)) + 'px';
  pop.style.right = 'auto';
  pop.style.bottom = Math.round(Math.max(8, window.innerHeight - r.top + 6)) + 'px';
}
let gifSearchT = null;
function applyPickerSearch(q) {
  const gifsActive = document.querySelector('.pk-tab.active')?.dataset.ptab === 'gifs';
  if (gifsActive && S.picker?.mode !== 'react') {
    if (gifSubView === 'favs') { gifQuery = q; renderGifTab(); return; }
    clearTimeout(gifSearchT);
    if (!q.trim()) { loadGifTrending(); return; }
    gifSearchT = setTimeout(() => loadGifSearch(q.trim()), 350);
  } else {
    renderEmojiGrid(q);
  }
}
$('#pk-search').addEventListener('input', (e) => applyPickerSearch(e.target.value));
let gifResults = null; // null = loading
let gifQuery = '';
let gifFailed = false;
let gifSubView = 'all'; // 'all' (trending/results) | 'favs' (Favorites menu)
const STAR_PATH = 'M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.7 7.1-.6z';
function gifButton(g, fav, onclick) {
  const b = document.createElement('button');
  b.className = 'pk-gif'; b.title = g.title || 'GIF';
  b.innerHTML = `<img src="${esc(g.thumb || g.preview || g.gif)}" alt="${esc(g.title || 'GIF')}" loading="lazy" />` +
    `<button class="pk-star${fav ? ' on' : ''}" title="${fav ? 'Remove favorite' : 'Add to favorites'}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></button>`;
  b.onclick = onclick;
  b.querySelector('.pk-star').onclick = (e) => { e.stopPropagation(); toggleGifFav(g); };
  return b;
}
// GIFs tab has two sub-views: "All GIFs" (KLIPY trending/search results) and
// "Favorites" (its own menu). The search box filters whichever sub-view is open.
function renderGifTab() {
  const box = $('#pk-gifs');
  box.innerHTML = '';
  const q = gifQuery.toLowerCase();
  const n = S.gifFavs ? S.gifFavs.length : null;
  $('#pk-search').placeholder = gifSubView === 'favs' ? 'Search favorites' : 'Search KLIPY';
  if (gifSubView === 'favs') {
    box.insertAdjacentHTML('beforeend',
      `<div class="pk-subrow"><button class="pk-subbtn" data-pkback="1">← All GIFs</button>` +
      `<span class="pk-subtitle">Favorites${n === null ? '' : ` (${n})`}</span></div>`);
    box.querySelector('[data-pkback]').onclick = (e) => {
      e.stopPropagation(); // re-render detaches this button; without this the
      // global "outside click closes picker" handler would see a detached target
      gifSubView = 'all';
      $('#pk-search').value = '';
      loadGifTrending();
    };
    if (S.gifFavs === null) {
      box.insertAdjacentHTML('beforeend', '<div class="pk-empty small">Loading…</div>');
    } else {
      const favs = q
        ? S.gifFavs.filter((g) => (g.title || '').toLowerCase().includes(q) || (g.slug || '').includes(q))
        : S.gifFavs;
      if (!favs.length) {
        box.insertAdjacentHTML('beforeend', `<div class="pk-empty small">${q ? 'No favorites match.' : 'No favorites yet — star a GIF in All GIFs, or star one somebody posted in chat.'}</div>`);
      } else {
        for (const g of favs) box.appendChild(gifButton(g, true, () => sendGif(g)));
      }
    }
  } else {
    box.insertAdjacentHTML('beforeend',
      `<div class="pk-subrow"><button class="pk-subbtn on" data-pkfavs="1">Favorites${n === null ? '' : ` (${n})`}</button></div>`);
    box.querySelector('[data-pkfavs]').onclick = (e) => {
      e.stopPropagation(); // re-render detaches this button; without this the
      // global "outside click closes picker" handler would see a detached target
      gifSubView = 'favs';
      renderGifTab();
    };
    box.insertAdjacentHTML('beforeend', `<div class="pk-sec">${q ? 'KLIPY results' : 'Trending'}</div>`);
    if (gifResults === null) box.insertAdjacentHTML('beforeend', '<div class="pk-empty small">Loading…</div>');
    else if (!gifResults.length) box.insertAdjacentHTML('beforeend', `<div class="pk-empty small">${gifFailed ? 'GIFs unavailable.' : 'No GIFs found.'}</div>`);
    // A tile reads starred if the account has that GIF — by Klipy slug, or by
    // the gif itself (a row written from a chat star that predates the slug).
    else for (const g of gifResults) box.appendChild(gifButton(g, gifFavMatch(S.gifFavs, g.slug, g.gif), () => sendGif(g)));
  }
}
// ---------- GIF favorites (per-user, synced across devices) ----------
// One list, two ways in: the picker's own tiles, and the star on a GIF somebody
// posted in chat (attFavHTML in messages.js). Both write the same row and both
// key on the Klipy slug, so a GIF starred either way reads starred everywhere.
let gifFavsFor = null; // the account the loaded list belongs to
async function loadGifFavs() {
  const me = (S.me && S.me.id) || null;
  if (S.gifFavs !== null && gifFavsFor === me) return;
  try {
    const { favorites } = await api('/api/me/gif-favorites');
    if (S.gifFavs !== null && gifFavsFor === me) return; // superseded by a later load
    S.gifFavs = favorites;
    gifFavsFor = me;
  } catch { /* leave null; the tab shows Loading and retries on next open */ }
  refreshFavViews();
}
// The chat stars need the same list to know what is already favorited. Loaded
// once per session (the picker loads it on open anyway, and that load is the
// retry). A failure does NOT re-arm this — repainting a message list would
// otherwise fire the request again on every render, invisibly.
let gifFavsTried = false;
function ensureGifFavs() {
  const me = (S.me && S.me.id) || null;
  // Signing in as somebody else on a page that never reloaded (an expired
  // session landing back on the auth screen) must not inherit the last
  // account's favorites — nor the latch that says they are already loaded.
  if (S.gifFavs !== null && gifFavsFor !== me) { S.gifFavs = null; gifFavsTried = false; }
  if (S.gifFavs !== null || gifFavsTried) return;
  gifFavsTried = true;
  loadGifFavs();
}
async function toggleGifFav(g) {
  if (!g || !g.slug) return;
  // Resolve by key OR by the gif itself: the same GIF can already be in the list
  // under a url-derived key (starred from chat before this picker knew its
  // slug), and that row is the one to remove — never a second row.
  const hit = (S.gifFavs || []).find((f) => f && ((!!g.slug && f.slug === g.slug) || (!!g.gif && f.gif === g.gif)));
  try {
    if (hit) {
      await api('/api/me/gif-favorites/' + encodeURIComponent(hit.slug), { method: 'DELETE' });
      S.gifFavs = S.gifFavs.filter((f) => f.slug !== hit.slug);
    } else {
      const saved = await api('/api/me/gif-favorites', {
        method: 'POST',
        body: JSON.stringify({ slug: g.slug, title: g.title, thumb: g.thumb, gif: g.gif, mp4: g.mp4 }),
      });
      S.gifFavs = [saved, ...((S.gifFavs || []).filter((f) => f.slug !== g.slug))];
    }
    refreshFavViews();
  } catch (err) { toast('Favorites update failed: ' + prettyError(err.message)); }
}
// A star clicked on a GIF in chat carries the attachment's own identity (its
// data-* attributes): the Klipy slug, or the url-derived key when the post
// predates the picker stamping one. Either way it is exactly the shape
// toggleGifFav writes.
function chatGifFavFromBtn(btn) {
  return {
    slug: btn.dataset.gifKey || '',
    title: btn.dataset.gifTitle || '',
    gif: btn.dataset.gifUrl || '',
    thumb: btn.dataset.gifThumb || btn.dataset.gifUrl || '',
    mp4: btn.dataset.gifMp4 || null,
  };
}
// Repaint every chat star in place. A full message rebuild would jump the
// scroll (and re-request every picture) for a change that touches one button.
function paintChatGifStars() {
  const stars = document.querySelectorAll('.att-star[data-gif-key]');
  if (!stars.length) return;
  if (S.gifFavs === null) { ensureGifFavs(); return; } // repaints when it lands
  for (const b of stars) {
    const isOn = gifFavMatch(S.gifFavs, b.dataset.gifKey, b.dataset.gifUrl);
    const label = isOn ? 'Remove from favorites' : 'Add to favorites';
    b.classList.toggle('on', isOn);
    b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    b.title = label; b.setAttribute('aria-label', label);
  }
}
function refreshFavViews() {
  paintChatGifStars();
  if (!S.picker) return;
  if (document.querySelector('.pk-tab.active')?.dataset.ptab === 'gifs') renderGifTab();
}
async function loadGifTrending() {
  gifQuery = ''; gifResults = null; gifFailed = false;
  renderGifTab();
  try {
    const { gifs } = await api('/api/gifs/trending');
    gifResults = gifs;
  } catch { gifResults = []; gifFailed = true; }
  if (S.picker) renderGifTab();
}
async function loadGifSearch(q) {
  gifQuery = q; gifResults = null; gifFailed = false;
  renderGifTab();
  try {
    const { gifs } = await api('/api/gifs/search?q=' + encodeURIComponent(q));
    gifResults = gifs;
  } catch { gifResults = []; gifFailed = true; }
  if (S.picker) renderGifTab();
}
// ---------- a picked GIF is an attachment like any other ----------
// The attachment a picker GIF travels as — the one object BOTH paths below hand
// to the server (post it on the click, or stage it on the message first).
function gifAttachment(g) {
  const url = g.gif || g.mp4;
  return {
    url, name: (g.title || 'gif').slice(0, 80) + '.gif', mime: 'image/gif', size: 0, kind: 'image',
    // The Klipy identity travels with the post so the GIF can be starred from
    // the chat it lands in (see cleanGifMeta in server.js / attFavHTML in
    // messages.js). w/h let the chat reserve the picture's box before it loads.
    gifSlug: g.slug || '', gifThumb: g.thumb || '', gifMp4: g.mp4 || '',
    w: g.w || 0, h: g.h || 0,
  };
}
// Is there a conversation for the composer to attach to? The same two shapes the
// post-on-the-click path requires.
// Which composer the picker was opened from. The chat bar and the thread bar are
// both on screen, so a picked GIF has to know which one it belongs to.
function gifComposerReady(bar = 'main') {
  if (bar === 'thread') return !!(S.thread && S.thread.rootId);
  return S.view === 'home' ? !!S.dmThreadId : !!(S.serverId && S.channelId);
}
// Is a message already being written in THIS bar — words in the box, or files
// already staged (and a pending reply rides along either way)? Then a picked GIF
// belongs to THAT message (see sendGif).
function composerHasDraft(bar = 'main') {
  if (bar === 'thread') {
    const tinp = $('#in-thread');
    return !!((tinp && tinp.value.trim()) || threadAtts().length);
  }
  const inp = $('#in-message');
  return !!((inp && inp.value.trim()) || (S.pendingAtts || []).length);
}
// Stage the GIF as a chip on the composer it was picked for. False when the
// message is already at the per-message attachment cap a pick / drop / paste obeys.
function stageGif(att, bar = 'main') {
  const isThread = bar === 'thread';
  const ctx = isThread ? threadAttCtx() : (syncPendingAttsCtx(), attsCtxNow());
  if (!ctx) return false;
  const list = isThread ? threadAtts() : (S.pendingAtts = S.pendingAtts || []);
  if (list.length + activeUploadCount(ctx) >= maxAttsFor()) {
    toast(maxAttsToast());
    return false;
  }
  // The chip's tile is the Klipy THUMB: the gif behind it can be megabytes, and
  // a 40px chip has no use for the animation (the chat paints the thumb too).
  setAttPreview(att.url, att.gifThumb || att.url);
  list.push(att);
  haptic(10); // the pick ticks, like an emoji does
  renderComposerMeta();
  try { (isThread ? $('#in-thread') : $('#in-message')).focus(); } catch {}
  return true;
}
function sendGif(g) {
  const pick = S.gifPick;
  // Read the bar BEFORE closing: closePicker() drops S.picker with it. No focus
  // back: a GIF either posts on the spot (nothing to type) or is staged by
  // stageGif(), which puts the caret in the bar itself — and on a phone the
  // first of those must not answer the tap with a keyboard.
  const bar = pickerBar();
  closePicker(false);
  const att = gifAttachment(g);
  const url = att.url;
  if (pick === 'avatar' || pick === 'banner' || pick === 'sidebar') { if (url) applyProfileUrl(pick, url); return; }
  if (!url) return;
  // The thread bar's own picker: a GIF picked there joins the reply being written
  // (or posts as its own reply when the box is empty), and never the channel.
  if (bar === 'thread') {
    if (!gifComposerReady('thread')) return;
    if (composerHasDraft('thread')) { stageGif(att, 'thread'); return; }
    sendChat('', { attachments: [att], threadRoot: S.thread.rootId, replyTo: S.threadReplyTo?.id || null });
    S.threadReplyTo = null;
    renderComposerMeta();
    return;
  }
  // A GIF picked while a message is being written JOINS it, instead of going out
  // on its own: the words, the GIF, any staged files and a pending reply all
  // leave together on the reader's own Send. With an empty composer it still
  // posts on the click, which is the whole gesture for the common "just a GIF"
  // case.
  if (gifComposerReady() && composerHasDraft()) { stageGif(att); return; }
  // A pending reply (main composer chip or in-thread chip) rides along —
  // otherwise the GIF lands as a standalone message.
  if (S.view === 'home') {
    if (!S.dmThreadId) return;
    sendDm('', { attachments: [att], replyTo: S.replyTo?.id || null });
    S.replyTo = null;
    renderComposerMeta();
    return;
  }
  if (!S.serverId || !S.channelId) return;
  if (S.threadReplyTo && S.thread) {
    sendChat('', { attachments: [att], threadRoot: S.thread.rootId, replyTo: S.threadReplyTo.id });
    S.threadReplyTo = null;
    renderThreadComposerMeta();
    return;
  }
  sendChat('', { attachments: [att], replyTo: S.replyTo?.id || null });
  S.replyTo = null;
  renderComposerMeta();
}

// ---------- reactions / reply / edit / thread actions ----------
async function toggleReaction(mid, emoji) {
  const cur = msgById(mid);
  const max = Number(S.maxReactions) || 20;
  // One message carries at most `max` DIFFERENT emoji (REACTION_KINDS_MAX on the
  // server). Adding to a kind already on the message — or taking my own reaction
  // back — is always allowed, so only a NEW kind can hit the ceiling; refusing it
  // here says why, instead of letting the tap round-trip into a bare error. The
  // server re-checks, so a bar another device filled a moment ago still holds.
  const known = (cur?.reactions || []).some((r) => r.emoji === emoji);
  if (!known && (cur?.reactions?.length || 0) >= max) {
    toast(`That message already has ${max} different reactions — remove one to add another`);
    return;
  }
  haptic(10); // reacting is one of the few taps that still ticks
  const dm = cur?._dm;
  const base = dm ? '/api/dms/messages/' : '/api/messages/';
  try {
    const { reactions } = await api(base + mid + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) });
    // The quick strips are baked into each message's markup, so a reaction that
    // moves the ranking has to repaint the bars already on screen (see
    // paintQuickReacts) or the hover menu keeps offering the five it had.
    if (bumpFreq(emoji)) { try { paintQuickReacts(); } catch {} }
    updateMsgInCaches(mid, (m) => { m.reactions = reactions.map((r) => ({ emoji: r.emoji, count: r.count, me: r.me, users: r.users || [] })); });
    reactionDetailCache.delete(mid); // counts changed — refetch on next view
    // Patch the one reaction bar in place; a full rebuild would jump the
    // scroll (and flash every avatar) for a change that touches one element.
    if (S.view === 'home') { if (S.dmThreadId && !patchMessageReactions(mid, $('#messages'))) renderDmMessages(); }
    else if (S.channelId && !patchMessageReactions(mid, $('#messages'))) renderMessages();
    if (S.thread && (S.thread.rootId === mid || S.thread.replies.some((r) => r.id === mid))) {
      if (!patchMessageReactions(mid, $('#thread-replies'))) renderThread();
    }
  } catch (err) {
    // The bar filled up between the pre-check above and this request (another
    // device, or somebody else in a busy channel) — the server's answer is the
    // one that counts, and it says the same thing the pre-check would have.
    if (/too_many_reactions/.test(String(err && err.message))) toast(`That message already has ${max} different reactions — remove one to add another`);
    else toast('Reaction failed: ' + prettyError(err.message));
  }
}
/* ---------- reaction details: hover tooltip + View-reactions modal ---------- */
// Per-message cache of the detailed endpoint (emoji -> full user objects).
// Invalidated on toggle + live socket updates so names never go stale.
const reactionDetailCache = new Map(); // mid -> { at, reactions }
async function fetchReactionDetails(mid) {
  const hit = reactionDetailCache.get(mid);
  if (hit && Date.now() - hit.at < 30000) return hit.reactions;
  const m = msgById(mid);
  if (!m) return null;
  const base = m._dm ? '/api/dms/messages/' : '/api/messages/';
  const { reactions } = await api(base + mid + '/reactions');
  reactionDetailCache.set(mid, { at: Date.now(), reactions });
  return reactions;
}
function reactionEmojiHTML(emoji) {
  const em = S.emojiAll[String(emoji).slice(1, -1)];
  if (String(emoji).startsWith(':') && String(emoji).endsWith(':') && em)
    return `<img class="cemoi" src="${esc(em.url)}" alt="${esc(emoji)}">`;
  return esc(emoji);
}
// Styled hover tooltip (desktop): emoji + up to 10 names + overflow count.
// Native `title` (see reactionTitle) remains as the fallback / a11y label;
// while the bubble is visible we clear it so both don't stack.
let reactTipEl = null, reactTipFor = null, reactTipTimer = 0;
function hideReactionTip(restore = true) {
  if (reactTipTimer) { clearTimeout(reactTipTimer); reactTipTimer = 0; }
  if (reactTipEl) { reactTipEl.remove(); reactTipEl = null; }
  if (restore && reactTipFor && reactTipFor.isConnected) {
    const r = reactTipFor._reactRef;
    if (r) reactTipFor.title = reactionTitle(r);
  }
  reactTipFor = null;
}
function showReactionTip(btn, mid, emoji) {
  if (isCoarse()) return; // touch: tap toggles, long-press menu has View reactions
  hideReactionTip(false);
  const m = msgById(mid);
  const ref = m?.reactions?.find((x) => x.emoji === emoji);
  if (!m || !ref) return;
  btn._reactRef = ref;
  const tip = document.createElement('div');
  tip.id = 'reaction-tip';
  const paint = (users, loading) => {
    const shown = users.slice(0, 10);
    const total = ref.count || users.length;
    const extra = total > shown.length ? total - shown.length : 0;
    tip.innerHTML = `<span class="rt-emoji">${reactionEmojiHTML(emoji)}</span><span class="rt-names">${shown.map((u) => `<b>${esc(u.display_name || u.username || '?')}</b>`).join(', ')}${extra ? ` <span class="muted">and ${extra} more</span>` : ''}${loading ? ' <span class="muted">…</span>' : ''}</span><span class="rt-count">${ref.count}</span>`;
  };
  // Instant: resolve cached IDs locally, then enrich via the endpoint.
  const local = (ref.users || []).map((id) => {
    if (S.me && id === S.me.id) return S.me;
    try { return memberById(id) || { id, display_name: null, username: null }; }
    catch { return { id, display_name: null, username: null }; }
  });
  const known = local.filter((u) => u && (u.display_name || u.username));
  paint(known.length ? known : [{ display_name: `${ref.count} reaction${ref.count === 1 ? '' : 's'}` }], true);
  document.body.appendChild(tip);
  const r = btn.getBoundingClientRect();
  tip.style.visibility = 'hidden';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, innerWidth - tw - 8)) + 'px';
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.top = top + 'px';
  tip.style.visibility = '';
  reactTipEl = tip;
  reactTipFor = btn;
  btn.title = ''; // suppress native while the bubble shows
  fetchReactionDetails(mid).then((full) => {
    if (!reactTipEl || reactTipFor !== btn || !btn.isConnected) return;
    const g = (full || []).find((x) => x.emoji === emoji);
    if (g && g.users?.length) {
      paint(g.users, false);
      const r2 = btn.getBoundingClientRect();
      const tw2 = tip.offsetWidth;
      tip.style.left = Math.max(8, Math.min(r2.left + r2.width / 2 - tw2 / 2, innerWidth - tw2 - 8)) + 'px';
    } else if (known.length) paint(known, false);
  }).catch(() => { if (reactTipEl && reactTipFor === btn) paint(known.length ? known : [{ display_name: `${ref.count}` }], false); });
  reactTipTimer = setTimeout(() => hideReactionTip(), 4000);
}
// Hover delegation: slight delay so sweeping the mouse across chat doesn't
// flash bubbles on every reaction.
let reactHoverT = 0;
document.addEventListener('mouseover', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.reaction[data-emoji]') : null;
  if (!btn) return;
  if (reactTipFor === btn) return;
  clearTimeout(reactHoverT);
  const msgEl = btn.closest('[data-mid]');
  const mid = msgEl && msgEl.dataset.mid;
  if (!mid) return;
  reactHoverT = setTimeout(() => showReactionTip(btn, mid, btn.dataset.emoji), 350);
});
document.addEventListener('mouseout', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.reaction[data-emoji]') : null;
  if (btn && reactTipFor === btn) { clearTimeout(reactHoverT); hideReactionTip(); }
  else clearTimeout(reactHoverT);
});
document.addEventListener('scroll', () => hideReactionTip(), true);
// Full viewer: grouped by emoji, every reactor with avatar + name.
async function openReactionsModal(mid) {
  const m = msgById(mid);
  if (!m) return;
  if (!m.reactions?.length) { toast('No reactions yet'); return; }
  const total = m.reactions.reduce((n, r) => n + (r.count || 0), 0);
  openModal(`Reactions · ${total}`, '<div class="rx-list"><p class="muted small" style="text-align:center;padding:1rem">Loading…</p></div>', 'Close', null, { wide: true });
  const box = document.querySelector('#modal-body .rx-list');
  if (!box) return;
  let full;
  try { full = await fetchReactionDetails(mid); }
  catch { box.innerHTML = '<p class="error">Could not load reactions.</p>'; return; }
  if (!box.isConnected) return;
  if (!full?.length) { box.innerHTML = '<p class="muted small" style="text-align:center;padding:1rem">No reactions yet.</p>'; return; }
  // Keep the message's own emoji order.
  const order = new Map((m.reactions || []).map((r, i) => [r.emoji, i]));
  full = [...full].sort((a, b) => (order.get(a.emoji) ?? 99) - (order.get(b.emoji) ?? 99));
  box.innerHTML = '';
  for (const g of full) {
    const sec = document.createElement('div');
    sec.className = 'rx-group';
    sec.innerHTML = `<div class="rx-head"><span class="rx-emoji">${reactionEmojiHTML(g.emoji)}</span><span class="rx-count">${g.count}</span></div><div class="rx-users"></div>`;
    const list = sec.querySelector('.rx-users');
    for (const u of g.users || []) {
      const row = document.createElement('div');
      row.className = 'rx-user';
      const isMe = S.me && u.id === S.me.id;
      row.innerHTML = '<span class="avatar"></span><span class="rx-main"><span class="rx-name"></span><span class="rx-sub"></span></span>';
      paintAvatar(row.querySelector('.avatar'), u);
      const nm = row.querySelector('.rx-name');
      nm.innerHTML = `<span class="mname-row"><span class="mname" style="${nameStyleFor(u)}">${esc(u.display_name || u.username || 'deleted user')}</span>${isMe ? ' (you)' : ''}${tagHTML(u)}</span>`;
      row.querySelector('.rx-sub').textContent = u.username ? '@' + u.username : '';
      list.appendChild(row);
    }
    if ((g.count || 0) > (g.users || []).length) {
      const more = document.createElement('div');
      more.className = 'rx-more muted small';
      more.textContent = `and ${g.count - g.users.length} more…`;
      list.appendChild(more);
    }
    box.appendChild(sec);
  }
}
async function jumpToMessage(id) {
  const sel = `#messages [data-mid="${CSS.escape(id)}"]`;
  const el = document.querySelector(sel);
  if (el) { flashMsgEl(el); return; }
  // Parent isn't in the loaded window: pull a context window around it (same
  // UX as pin jumps) so the quote always lands + highlights. This sets
  // histMode, so the jump-present pill offers a way back to the bottom.
  const land = () => {
    const target = document.querySelector(sel);
    if (target) flashMsgEl(target);
    updatePill();
  };
  // Replies land in the same thread, so try the current DM first.
  if (S.view === 'home' && S.dmThreadId) {
    try {
      const { messages } = await api(`/api/dms/${S.dmThreadId}/messages?limit=60&around=${encodeURIComponent(id)}`);
      // Same rule as jumpToPin: a context window replaces the list, but older
      // history already loaded behind it stays the base so paging continues.
      const older = historyExtendedWindow(S.dmMessages.get(S.dmThreadId), messages);
      const base = (older && older.length) ? older.concat(messages) : messages;
      S.dmMessages.set(S.dmThreadId, base);
      resetHistoryTop();
      if (older && older.length) markHistoryExtended('dm:' + S.dmThreadId);
      S.histMode = { kind: 'dm', id: S.dmThreadId };
      S.histNew = 0;
      renderDmMessages();
      land();
      return;
    } catch {}
  }
  try {
    const { message } = await api('/api/messages/' + id);
    if (!message) throw new Error('no_message');
    if (message.serverId !== S.serverId) await selectServer(message.serverId);
    if (message.channelId !== S.channelId) await selectChannel(message.channelId, { keepNav: true });
    const ctx = pinsCtx();
    if (!ctx || ctx.kind !== 'server') throw new Error('no_message');
    const { messages: msgs } = await api(`/api/servers/${ctx.serverId}/channels/${ctx.id}/messages?limit=60&around=${encodeURIComponent(id)}`);
    const older = historyExtendedWindow(S.messages.get(ctx.id), msgs);
    const base = (older && older.length) ? older.concat(msgs) : msgs;
    S.messages.set(ctx.id, base);
    resetHistoryTop();
    if (older && older.length) markHistoryExtended(historyKeyFor(ctx));
    S.histMode = { ...ctx };
    S.histNew = 0;
    renderMessages();
    land();
  } catch { toast('Message not found'); }
}
// Every surface an edit box can be sitting on, repainted. The box is built by
// messageEl, so it only ever exists in the channel/DM list or the open thread
// panel — but each of those holds its own copy of the message, so opening,
// cancelling and saving all have to repaint all of them or a box outlives the
// edit it belonged to. (Renders are cheap next to a wrong-looking UI; the list's
// own anchor logic keeps the reader's place.)
function repaintEditHosts() {
  if (S.channelId) renderMessages();
  if (S.view === 'home' && S.dmThreadId) renderDmMessages();
  if (S.thread) renderThread();
}
function startEdit(mid) {
  S.editing = mid;
  S.editRemovals = new Set(); // attachment ids to drop on save
  repaintEditHosts();
  setTimeout(() => { const t = $('#edit-area'); if (t) { t.focus(); t.selectionStart = t.value.length; } }, 0);
}
// Abandon an in-progress edit (Cancel button, Escape). `focus` hands the caret
// back to the composer — used for Escape, where the keyboard is already up and
// the reader expects to keep typing; the button leaves focus alone.
function cancelEdit(opts = {}) {
  if (!S.editing) return;
  S.editing = null;
  S.editRemovals = new Set();
  repaintEditHosts();
  if (opts.focus) { try { $('#in-message')?.focus(); } catch {} }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !S.editing) return;
  const t = e.target;
  const inBox = !!(t && t.id === 'edit-area');
  // Escape inside some other field (a modal's input, the composer) belongs to
  // that field — only the edit box, or the page at large, cancels the edit.
  if (!inBox && t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  cancelEdit({ focus: true });
});
// Up arrow in an empty composer edits your last message in this conversation
// (Discord's shortcut). Nothing else may own the key when it fires: an open
// autocomplete popup, an in-flight attach, or an edit already in progress.
// With text present, Up keeps its normal job of moving the caret.
$('#in-message').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  if (e.defaultPrevented) return; // a popup already handled it
  const inp = e.target;
  if (!inp || inp.value.trim()) return;
  if ((S.pendingAtts || []).length) return;
  if (S.editing) return;
  for (const sel of ['#mention-pop', '#emoji-pop', '#chan-pop']) {
    const pop = $(sel);
    if (pop && !pop.classList.contains('hidden')) return;
  }
  const list = S.view === 'home'
    ? (S.dmMessages.get(S.dmThreadId) || [])
    : (S.messages.get(S.channelId) || []);
  let last = null;
  for (const m of list) {
    if (m.sys || m.webhook) continue;
    if (m.user && S.me && m.user.id === S.me.id) last = m; // keep scanning: we want the newest
  }
  if (!last) return;
  e.preventDefault();
  startEdit(last.id);
  // The message can be above the viewport when the reader is up in history,
  // and an edit box they can't see is worse than no shortcut at all.
  setTimeout(() => {
    try {
      const el = document.querySelector('#messages [data-mid="' + CSS.escape(last.id) + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } catch {}
  }, 0);
});
async function saveEdit(mid) {
  const t = $('#edit-area');
  const content = (t?.value || '').trim();
  if (!content) return;
  const remove = [...(S.editRemovals || [])];
  const before = msgById(mid);
  const snapshot = before ? { content: before.content, edited: before.edited, attachments: before.attachments } : null;
  S.editing = null;
  S.editRemovals = new Set();
  // Paint the edit and take the box down on the spot. The socket echo used to be
  // the only repaint, and a message carrying an attachment never repainted at
  // all (the node exists, so the update was treated as already applied) — so Save
  // looked like a dead button and the box sat there until a reload, at which
  // point Cancel looked dead too, because clearing S.editing had already
  // disarmed it. The local copy is optimistic; the server's answer below is what
  // finally stands, and a failure puts the old text back.
  updateMsgInCaches(mid, (m) => {
    m.content = content;
    m.edited = true;
    if (remove.length) m.attachments = (m.attachments || []).filter((a) => !remove.includes(String(a.id)));
  });
  repaintEditHosts();
  const base = (before && before._dm) ? '/api/dms/messages/' : '/api/messages/';
  try {
    const r = await api(base + mid, { method: 'PATCH', body: JSON.stringify({ content, removeAttachments: remove }) });
    if (r && r.message) updateMsgInCaches(mid, (m) => Object.assign(m, r.message));
  } catch (err) {
    if (snapshot) updateMsgInCaches(mid, (m) => { m.content = snapshot.content; m.edited = snapshot.edited; m.attachments = snapshot.attachments; });
    toast('Edit failed: ' + prettyError(err.message));
  }
  repaintEditHosts();
}
// Edit box: Enter saves the edit, Shift+Enter inserts a line break — same
// contract as the composer. Without this, Enter only added a newline and the
// edit could only be committed with the Save button. Works for channel, DM
// and thread replies (the box is (re)created by messageEl in each of them).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const t = e.target;
  if (!t || t.id !== 'edit-area') return;
  const owner = t.closest && t.closest('.msg[data-mid]');
  const mid = owner ? owner.dataset.mid : null;
  if (!mid) return; // stray box (no message to save): leave the default alone
  e.preventDefault();
  saveEdit(mid);
});
// global delegation for message interactions
 document.addEventListener('click', (e) => {
  const cardUid = uidClickTarget(e);
  const actEl = e.target.closest('[data-act]');
  const jumpEl = e.target.closest('[data-jump]');
  const clEl = e.target.closest('[data-clink]');
  const reactEl = e.target.closest('.reaction');
  const imgEl = e.target.closest('.att-img,.embed-img');
  const memberEl = e.target.closest('.member');
  if (reactEl && reactEl.dataset.emoji) {
    const msgEl = reactEl.closest('[data-mid]');
    if (msgEl) toggleReaction(msgEl.dataset.mid, reactEl.dataset.emoji);
    return;
  }
  const spEl = e.target.closest('.spoiler');
  const ytBtn = e.target.closest('[data-yt-play]');
  if (ytBtn) {
    const wrap = ytBtn.closest('.embed');
    const src = ytBtn.getAttribute('data-yt-play');
    if (wrap && src && !wrap.querySelector('iframe')) {
      const f = document.createElement('iframe');
      f.className = 'embed-frame yt-player';
      f.src = src;
      f.title = 'YouTube video';
      f.loading = 'lazy';
      f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      f.allowFullscreen = true;
      // The player takes the facade's place INSIDE the same card, under the same
      // provider header: the two are the same box, so nothing moves but the tile.
      ytBtn.replaceWith(f);
    }
    return;
  }
  if (spEl && !spEl.classList.contains('shown') && spEl.closest('.msg .text,.uc-bio')) { spEl.classList.add('shown'); return; }
  const spVeil = e.target.closest('.spoiler-veil');
  if (spVeil) { spVeil.closest('.att-wrap')?.classList.add('shown'); return; }
  if (imgEl) {
    const spWrap = imgEl.closest('.att-wrap.spoiler:not(.shown)');
    if (spWrap) { spWrap.classList.add('shown'); return; }
    // Thread the attachment filename through so the lightbox corner button
    // can download it (embed images have no attachment — no button then).
    // data-fb-url is the ORIGINAL upload: the inline picture is a derived
    // preview, and the full-screen viewer has to open the real thing. The third
    // argument is the message's other media, so a picture posted with others
    // opens with the arrows that walk them (null for a lone picture).
    const dl = imgEl.closest('.att-wrap')?.querySelector('.att-dl');
    openLightbox(imgEl.dataset.fbUrl || imgEl.src, dl?.getAttribute('download') || '', lbGalleryAt(imgEl)); return;
  }
  // A CLIP in a COLLAGE. The tile is the media viewer's door, not a player (see
  // attsBlockHTML/attVideoHTML in messages.js: a 120px square is not a player, so
  // the tile carries no controls), and the whole tile is the target — the tile's own
  // door button (`.att-tile-open`, the transparent layer that keeps the press the
  // page's; a bare <video> is not a reliable click target on a phone), the poster
  // frame, and the spinner shell a clip waits behind until its frame is captured
  // (that shell is a button of its own, whose reveal-in-place wiring skips a
  // gallery tile for exactly this reason). A clip anywhere else keeps its own
  // controls and plays where it sits.
  const tileVid = e.target.closest('.msg-atts.gallery .att-slot video.att-vid, .msg-atts.gallery .att-slot .att-vid-load, .msg-atts.gallery .att-slot .att-tile-open');
  if (tileVid) {
    const slot = tileVid.closest('.att-slot');
    const sp = tileVid.closest('.att-wrap.spoiler:not(.shown)');
    if (sp) { sp.classList.add('shown'); return; }
    const clip = slot?.querySelector('video.att-vid');
    const cdl = slot?.querySelector('.att-dl');
    const csrc = (clip && (clip.dataset.fbSrc || clip.getAttribute('src'))) || '';
    // The viewer walks the message's whole media set, this clip's place in it
    // included (lbMediaOf), so the arrows and the strip come up around it.
    if (csrc) openLightbox(csrc, cdl?.getAttribute('download') || '', lbGalleryAt(clip));
    return;
  }
  if (clEl) {
    const ch = (S.serverDetail?.channels || []).find((c) => c.id === clEl.dataset.clink);
    if (ch && S.view === 'server') {
      if (clEl.dataset.ctype === 'voice') openVoiceChannel(S.serverId, ch.id);
      else if (S.channelId !== ch.id) selectChannel(ch.id);
    }
    return;
  }
  if (jumpEl) { jumpToMessage(jumpEl.dataset.jump); return; }
  if (actEl) {
    const msgEl = actEl.closest('[data-mid]');
    const mid = msgEl?.dataset.mid;
    const act = actEl.dataset.act;
    if (act === 'react' && mid) {
      if (actEl.dataset.emoji) toggleReaction(mid, actEl.dataset.emoji);
      else openPicker('react', mid, 'emoji', { x: e.clientX, y: e.clientY });
    }
    else if (act === 'more' && mid) openPicker('react', mid, 'emoji', { x: e.clientX, y: e.clientY });
    else if (act === 'menu' && mid) messageCtxMenu(mid, e.clientX, e.clientY);
    else if (act === 'reply' && mid) replyToMsg(msgById(mid));
    else if (act === 'thread' && mid) openThread(mid);
    else if (act === 'vote' && mid) votePoll(mid, actEl.dataset.opt);
    else if (act === 'gif-fav') toggleGifFav(chatGifFavFromBtn(actEl));
    else if (act === 'expand-file') expandTextFile(actEl);
    else if (act === 'copy-file') copyTextFile(actEl);
    else if (act === 'edit' && mid) startEdit(mid);
    else if (act === 'edit-unattach' && mid) {
      const aid = actEl.dataset.aid;
      if (aid) {
        S.editRemovals = S.editRemovals || new Set();
        S.editRemovals.add(aid);
        // Drop just the chip — a full re-render would lose the textarea text.
        const chip = actEl.closest('.edit-att');
        const wrap = actEl.closest('.edit-atts');
        if (chip) chip.remove();
        if (wrap && !wrap.querySelector('.edit-att')) wrap.remove();
      }
    }
    else if (act === 'edit-save' && mid) saveEdit(mid);
    else if (act === 'edit-cancel') cancelEdit();
    else if (act === 'del' && mid) {
      const base = msgById(mid)?._dm ? '/api/dms/messages/' : '/api/messages/';
      api(base + mid, { method: 'DELETE' }).catch(() => toast('Delete failed'));
    }
    return;
  }
  // Server tags own their clicks (final.js opens the server mini-panel) — a
  // tag click must never re-open/re-anchor the user card underneath (e.g.
  // the tag inside an open user card), and plain clicks inside the open card
  // (whose own container carries data-uid) must not rebuild it either.
  if (e.target.closest && e.target.closest('.usertag[data-tag-sid]')) return;
  // A member row with its own click handler (the story viewers list, which
  // carries the person it just rendered) keeps it — anchoring that card to the
  // member rail would be wrong anyway, since the row is not in the rail.
  if (memberEl?.dataset.uid && !memberEl.dataset.ownclick) { openMemberCard(memberEl.dataset.uid, memberEl); return; }
  // The person a plain click stands for, if any — see uidClickTarget below.
  if (cardUid) { openUserCard(cardUid, e.clientX, e.clientY); return; }
});
// Which person a plain click stands for, if any: the delegate's ONE card-opening
// decision, split out so it can be RUN against real markup (the browser half of
// scripts/test-user-card-layer.js) instead of only read. A `[data-uid]` ancestor
// is a person chip — a member row, a DM row, a rail occupant — UNLESS it opts out
// with `data-ownclick`: rows that already handled the click themselves (the
// friends list, voice occupants, the story viewers), and the profile PAGE, whose
// backdrop carries the uid it is showing as a marker for refreshProfileGame
// rather than as a chip. Without that opt-out every click anywhere on the page
// spawned the card of the very person whose page was already open.
function uidClickTarget(e) {
  const el = e.target && e.target.closest && e.target.closest('[data-uid]');
  if (!el || !el.dataset.uid || el.id === 'usercard' || el.dataset.ownclick) return null;
  return el.dataset.uid;
}

// ---------- threads ----------
async function applyProfileUrl(kind, url) {
  const ep = kind === 'sidebar' ? 'sidebar-banner' : kind;
  try {
    const { user } = await api(`/api/me/${ep}/url`, { method: 'POST', body: JSON.stringify({ url }) });
    S.me = { ...S.me, ...user };
    paintMe(); renderMembers();
    if (kind === 'avatar') paintAvatar($('#set-avatar-prev'), S.me);
    else if (kind === 'banner') $('#set-banner-prev').style.backgroundImage = S.me.banner_url ? `url('${S.me.banner_url}')` : '';
    else $('#set-sidebar-prev').style.backgroundImage = S.me.sidebar_banner_url ? `url('${S.me.sidebar_banner_url}')` : '';
    if (kind !== 'sidebar') loadMediaHist();
    toast((kind === 'avatar' ? 'Avatar' : kind === 'banner' ? 'Banner' : 'Sidebar banner') + ' updated');
  } catch (err) { toast('Failed: ' + prettyError(err.message)); }
}
async function loadMediaHist() {
  try {
    const h = await api('/api/me/media-history');
    renderHistRow($('#set-avatar-hist'), h.avatar || [], 'avatar', false);
    renderHistRow($('#set-banner-hist'), h.banner || [], 'banner', true);
  } catch {}
}
function renderHistRow(box, items, kind, wide) {
  if (!box) return;
  box.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hist-dot' + (wide ? ' wide' : '');
    b.style.backgroundImage = `url("${it.url}")`;
    b.title = 'Use this ' + kind;
    // A history dot SETS the picture, and setting one of the three now means
    // framing it first (public/js/crop.js) — otherwise an entry saved before
    // the stage existed would quietly land uncropped, which is the whole thing
    // the stage is for. cropProfileMedia reads a /uploads url back into bytes
    // for the crop route, which only fetches https itself.
    b.onclick = () => cropProfileMedia(kind, { url: it.url });
    const x = document.createElement('span');
    x.className = 'hist-x'; x.textContent = '✕'; x.title = 'Forget';
    x.onclick = async (e) => {
      e.stopPropagation();
      try { await api('/api/me/media-history/' + it.id, { method: 'DELETE' }); loadMediaHist(); }
      catch {}
    };
    b.appendChild(x);
    box.appendChild(b);
  }
}
async function openThread(rootId, opts = {}) {
  flushDrafts();
  try {
    const { root, replies } = await api(`/api/servers/${S.serverId}/channels/${S.channelId}/threads/${rootId}`);
    S.thread = { rootId, channelId: S.channelId, root, replies };
    S.threadReplyTo = null; renderThreadComposerMeta();
    clearThreadTyping(); // a strip from the thread that was open a moment ago
    $('#thread-sub').textContent = '#' + chanName(S.channelId);
    $('#thread-panel').classList.remove('hidden');
    rememberView(); // a reload lands you back in the thread you had open
    renderThread(true);
    applyComposerDraft(); // the reply you were typing in this thread, if any
  } catch { if (!opts.silent) toast('Could not open thread'); }
}
function renderThread(scroll = false) {
  if (!S.thread) return;
  const rootBox = $('#thread-root'), repBox = $('#thread-replies');
  rootBox.innerHTML = '';
  rootBox.appendChild(messageEl(S.thread.root, { inThread: true }));
  const nearBottom = repBox.scrollHeight - repBox.scrollTop - repBox.clientHeight < 200;
  const anchor = nearBottom ? null : captureListAnchor(repBox);
  const keepDist = repBox.scrollHeight - repBox.scrollTop; // fallback (anchor scrolled away)
  repBox.innerHTML = '';
  let tprev = null;
  for (const r of S.thread.replies) { repBox.appendChild(messageEl(r, { inThread: true, grouped: shouldGroup(tprev, r) })); tprev = r; }
  if (!S.thread.replies.length) repBox.innerHTML = '<p class="muted small" style="text-align:center">No replies yet.</p>';
  if (scroll || nearBottom) anchorBottom(repBox);
  else if (typeof pinAnchorWhileSettling === 'function') pinAnchorWhileSettling(repBox, restoreListAnchor(repBox, anchor, keepDist));
  else restoreListAnchor(repBox, anchor, keepDist);
}
function closeThread(silent) {
  flushDrafts();
  S.thread = null;
  S.threadReplyTo = null; renderThreadComposerMeta();
  clearThreadTyping(); // a closed panel has no strip to keep anyone in
  const p = $('#thread-panel');
  if (p) p.classList.add('hidden');
  if (!silent) rememberView();
}
// Active threads panel: threads you're part of with a message in the last
// 4 days (header Threads button). Rows jump straight into the thread.
//
// It is a SERVER control. Threads live in server text channels only — a DM has
// no thread column at all — so the button is hidden on Home, both on the blank
// feed and with a DM/group open, and the list it opens is scoped to the server
// on screen. paintThreadsBtn() is the ONE writer of that visibility, and the
// phone's ⋯ sheet follows it for free (ui.js skips every control carrying
// .hidden), so the row disappears from the sheet with the button.
function paintThreadsBtn() {
  const b = $('#btn-threads');
  if (!b) return;
  b.classList.toggle('hidden', !(S.view === 'server' && !!S.serverId));
}
function threadAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
let threadsSearchT = null, threadsSearchSeq = 0;
async function openActiveThreads() {
  // A server control: opened from anywhere else there is nothing to scope it to,
  // and the button is not on screen there anyway.
  if (!(S.view === 'server' && S.serverId)) return;
  const serverId = S.serverId;
  // The scope rides on the OPEN PANEL (data-server-id), not a module-level
  // variable, so a reopened panel can never inherit the previous one's server.
  const serverName = (S.serverDetail && S.serverDetail.name) || '';
  openModal('Active threads' + (serverName ? ' · ' + serverName : ''),
    `<input id="m-threads-search" placeholder="Search threads" autocomplete="off" /><div id="m-threads-list" data-server-id="${esc(serverId)}"><p class="muted" style="text-align:center;padding:1rem">Loading…</p></div>`,
    'Close', null, { wide: true });
  const input = $('#m-threads-search');
  if (!$('#m-threads-list')) return;
  await loadThreadsList('');
  if (input) input.addEventListener('input', () => {
    clearTimeout(threadsSearchT);
    threadsSearchT = setTimeout(() => loadThreadsList(input.value.trim()), 300);
  });
}
function threadsEmptyHTML(q, scoped) {
  return q
    ? `<p class="muted" style="text-align:center;padding:1rem">No threads match “${esc(q)}”.</p>`
    : `<p class="muted" style="text-align:center;padding:1rem">Nothing active${scoped ? ' in this server' : ''} — threads you start or reply to stay here for 4 days after the last message.</p>`;
}
async function loadThreadsList(q) {
  const list = $('#m-threads-list');
  if (!list) return;
  const my = ++threadsSearchSeq;
  const serverId = list.dataset.serverId || '';
  const params = [];
  if (serverId) params.push('serverId=' + encodeURIComponent(serverId));
  if (q) params.push('q=' + encodeURIComponent(q));
  list.innerHTML = '<p class="muted" style="text-align:center;padding:1rem">Loading…</p>';
  let threads = [];
  try { ({ threads } = await api('/api/threads/active' + (params.length ? '?' + params.join('&') : ''))); }
  catch { if (my === threadsSearchSeq && document.contains(list)) list.innerHTML = '<p class="error" style="text-align:center;padding:1rem">Could not load threads.</p>'; return; }
  if (my !== threadsSearchSeq || !document.contains(list)) return; // stale response
  if (!threads || !threads.length) { list.innerHTML = threadsEmptyHTML(q, !!serverId); return; }
  list.innerHTML = '';
  for (const t of threads) {
    const b = document.createElement('div');
    b.className = 'thread-item';
    b.tabIndex = 0;
    // Scoped to one server, the server name on every row would be the same word
    // 50 times, so the row leads with the channel instead.
    const where = serverId
      ? `<span class="t-hash">#</span>${esc(t.channelName || '')}`
      : `${esc(t.serverName || '')} <span class="t-hash">#</span>${esc(t.channelName || '')}`;
    b.innerHTML = `<span class="t-main"><span class="t-ctx">${where} · ${esc(threadAgo(t.lastActivity))}</span><span class="t-root"><b>${esc((t.root && t.root.author) || '?')}</b> ${esc((t.root && t.root.snippet) || '')}</span><span class="t-meta"><span class="t-count">${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}</span>${t.last ? `<span class="t-last">last by <b>${esc(t.last.author || '?')}</b> — ${esc(t.last.snippet || '')}</span>` : ''}</span></span><span class="t-avs"></span>`;
    const avBox = b.querySelector('.t-avs');
    for (const p of (t.participants || []).slice(0, 4)) {
      const s = document.createElement('span');
      s.className = 'avatar t-av';
      s.title = p.name || '?';
      try { paintAvatar(s, { display_name: p.name, avatar_color: p.color, avatar_url: p.avatar }); } catch {}
      avBox.appendChild(s);
    }
    b.insertAdjacentHTML('beforeend', '<button type="button" class="thread-x" title="Unfollow thread">×</button>');
    b.querySelector('.thread-x').onclick = async (e) => {
      e.stopPropagation();
      try { await api('/api/threads/' + encodeURIComponent(t.rootId) + '/unfollow', { method: 'POST' }); }
      catch { toast('Could not unfollow thread'); return; }
      b.remove();
      toast('Thread unfollowed — reply to rejoin it');
      const qv = $('#m-threads-search') ? $('#m-threads-search').value.trim() : '';
      if (list && !list.children.length) list.innerHTML = threadsEmptyHTML(qv, !!serverId);
    };
    const go = () => openActiveThread(t);
    b.onclick = go;
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    list.appendChild(b);
  }
}
async function openActiveThread(t) {
  try { $('#modal-backdrop').classList.add('hidden'); } catch {}
  try {
    if (t.serverId !== S.serverId) await selectServer(t.serverId);
    if (t.channelId && t.channelId !== S.channelId) await selectChannel(t.channelId);
    openThread(t.rootId);
  } catch {}
}
$('#btn-threads').onclick = openActiveThreads;
// Keep the hover quick-action bar usable near the top of a scroll list: when
// a message sits within the bar's clearance (~36px) of the scrollport top
// (e.g. the first thread reply right under the root section), pin the bar
// inside the message instead of letting it clip above.
let flipMsgEl = null;
function positionFlipActions(msgEl) {
  if (!msgEl || !msgEl.isConnected) return;
  const scroller = msgEl.closest('#messages,#thread-replies');
  if (!scroller) { msgEl.classList.remove('flip-actions'); return; }
  const top = msgEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  msgEl.classList.toggle('flip-actions', top < 36);
}
document.addEventListener('mouseover', (e) => {
  const m = e.target && e.target.closest ? e.target.closest('.msg') : null;
  if (m === flipMsgEl) return;
  if (flipMsgEl) flipMsgEl.classList.remove('flip-actions');
  flipMsgEl = m;
  if (m) positionFlipActions(m);
});
for (const sid of ['#messages', '#thread-replies']) {
  const sc = $(sid);
  if (sc) sc.addEventListener('scroll', () => positionFlipActions(flipMsgEl), { passive: true });
}
$('#thread-close').onclick = () => closeThread();
// thread sidebar resize (drag left edge, clamped + remembered)
const THREAD_W_MIN = 280, THREAD_W_MAX = 620;
const threadWMax = () => Math.max(THREAD_W_MIN + 40, Math.min(THREAD_W_MAX, Math.floor(innerWidth * 0.6)));
const clampThreadW = (w) => Math.min(threadWMax(), Math.max(THREAD_W_MIN, Math.round(w)));
try {
  const w = parseInt(localStorage.getItem('cf_thread_w') || '', 10);
  if (w >= THREAD_W_MIN) $('#thread-panel').style.width = clampThreadW(w) + 'px';
} catch {}
$('#thread-resizer').addEventListener('pointerdown', (e) => {
  if (phoneLayout()) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  const panel = $('#thread-panel');
  const rz = e.currentTarget;
  const startX = e.clientX, startW = panel.getBoundingClientRect().width;
  document.body.classList.add('thread-resizing');
  try { rz.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => { panel.style.width = clampThreadW(startW + (startX - ev.clientX)) + 'px'; };
  const done = (ev) => {
    panel.style.width = clampThreadW(startW + (startX - ev.clientX)) + 'px';
    try { localStorage.setItem('cf_thread_w', panel.style.width.replace('px', '')); } catch {}
    document.body.classList.remove('thread-resizing');
    rz.removeEventListener('pointermove', move);
    rz.removeEventListener('pointerup', done);
    rz.removeEventListener('pointercancel', done);
  };
  rz.addEventListener('pointermove', move);
  rz.addEventListener('pointerup', done);
  rz.addEventListener('pointercancel', done);
});
$('#thread-composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!S.thread) return;
  const inp = $('#in-thread');
  const content = inp.value.trim();
  const ctx = draftThreadCtx();
  // The reply's own staged files go with it — a reply can be files with no words,
  // exactly like a channel message (the chat bar's empty-submit rule, plus the
  // files: an empty box with attachments is a message, not a stray newline).
  const atts = threadAtts().slice();
  if (!content && !atts.length) {
    // Enter on a newline-only reply box: nothing to send, so clear the stray
    // line breaks and re-fit — the same shape as the main composer's empty
    // submit. Otherwise the tall box (and its phantom draft) just sits there.
    inp.value = '';
    draftClear(ctx);
    composerAutoGrow(inp);
    try { syncThreadRender(); } catch {}
    try { paintComposerSend(); } catch {}
    return;
  }
  inp.value = '';
  draftClear(ctx); // sent: the reply draft goes with it
  const list = threadAtts();
  list.length = 0; // the reply took them
  sendChat(content, { threadRoot: S.thread.rootId, replyTo: S.threadReplyTo?.id || null, attachments: atts });
  S.threadReplyTo = null;
  renderComposerMeta();
  composerAutoGrow(inp); // programmatic clear doesn't fire 'input', so reset height here
  try { syncThreadRender(); } catch {}
  // Mobile: keep the keyboard open for rapid follow-up replies.
  try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
});

// ---------- lightbox ----------
// Full-screen MEDIA viewer. The Download / Close controls sit in #lb-bar, a
// fixed safe-area bar, so a tall photo can never carry them off the top of the
// screen. One pointer pans a zoomed photo, two pinch it, double-tap toggles
// zoom, and dragging an unzoomed item down dismisses the viewer (the whole
// overlay follows the finger, exactly like the story viewer).
//
// A message with MORE THAN ONE media item opens on the one that was pressed, with
// an arrow on each side of the screen AND a strip of thumbnails along the bottom;
// both walk the same set in the order the message shows it (see lbMediaOf). A
// single picture — an embed, a bookmark's tile — has nowhere to go: no arrows, no
// strip.
//
// The set is the message's MEDIA: its pictures and its clips. A clip in a collage
// is a tile with no controls of its own (attVideoHTML's `tile`), so THIS is where
// it plays — full size, by its own controls, which is what "if a video is in a
// collage, can it open in a lightbox" asked for. A clip that is NOT in a collage
// keeps its player and plays where it sits; it is still part of a set its message
// has one, because the strip and the arrows walk what the message shows.
const LB_MIN = 1, LB_MAX = 6;
// How far a sideways drag must travel before it is "the next one" rather than a
// tap (the touch twin of the arrows).
const LB_SWIPE_PX = 40;
const lb = { open: false, scale: 1, tx: 0, ty: 0, gen: 0, ptrs: new Map(), pinch: null, pan: null, swipe: null, lastTap: 0, tapX: 0, tapY: 0, items: null, index: 0 };
function lbStage() { return $('#lb-stage'); }
function lbImg() { return $('#lightbox-img'); }
function lbVid() { return $('#lightbox-vid'); }
// Is the thing on the stage a CLIP right now? The zoom / pinch / pan gestures are
// the photo's; a player has its own use for a drag and its own controls for a tap.
function lbIsVid() { const v = lbVid(); return !!v && !v.classList.contains('hidden'); }
// The MEDIA the source message is showing, in the order it shows it: its pictures
// AND its clips. Read off the DOM, so it is exactly what the message renders — a
// file the scanner removed is a `.scan-block` rather than a slot, and a picture
// this browser cannot decode has already become a file card, so neither is offered
// (there is nothing to put on the stage). `el` is the slot it was read from, which
// is how the pressed tile is found in the list (the url cannot do it: one message
// can show the same picture twice). `src` is the ORIGINAL (data-fb-url on a
// picture, the player's own source on a clip), never the derived preview the tile
// paints; `thumb` is the small frame the strip paints for that item — the tile's
// own preview for a picture, a clip's poster frame for a clip (the FRAME, never
// the clip's bytes).
//
// A clip is deliberately IN this list. A clip in a collage is a tile without
// controls (attVideoHTML's `tile`), so the viewer is where it plays, and it is
// something the arrows — and the strip — can walk to. A clip that is not in a
// collage keeps its own player, and is still an item of its message's set: the
// strip is a row of everything the message shows.
function lbMediaOf(el) {
  const box = el && el.closest ? el.closest('.msg-atts, .pin-atts') : null;
  if (!box) return null;
  const items = [];
  for (const slot of box.querySelectorAll(':scope > .att-slot')) {
    const img = slot.querySelector('img.att-img');
    const vid = slot.querySelector('video.att-vid');
    const wrap = slot.querySelector('.att-wrap');
    const name = (img && img.dataset.fbName) || (vid && vid.dataset.fbName) || (wrap && wrap.dataset.fbName) || '';
    if (img) {
      const src = img.dataset.fbUrl || img.dataset.fbOrig || img.getAttribute('src') || '';
      if (src) items.push({ el: slot, kind: 'image', src, name, thumb: img.getAttribute('src') || '' });
      continue;
    }
    if (vid) {
      const src = vid.dataset.fbSrc || vid.getAttribute('src') || (wrap && wrap.dataset.fbUrl) || '';
      if (!src) continue;
      // The poster the player already holds, or the frame this page captured for
      // that url (a tile whose capture never ran because it was never near the
      // viewport still gets a thumbnail).
      const poster = vid.getAttribute('poster') || (typeof videoPosterFor === 'function' ? (videoPosterFor(src) || '') : '');
      items.push({ el: slot, kind: 'video', src, name, poster, thumb: poster });
    }
  }
  return items.length ? items : null;
}
// …and WHERE in that list the element the reader touched sits. Null when the
// media is not part of a message block at all (an embed picture).
function lbGalleryAt(el) {
  const items = lbMediaOf(el);
  if (!items) return null;
  let index = 0;
  try { index = items.findIndex((x) => x.el === el || x.el.contains(el)); } catch {}
  return { items, index: index < 0 ? 0 : index };
}
// Keep a zoomed photo from being dragged off its own edges (and re-centre it
// when it is smaller than the stage). Uses layout sizes, not the transformed
// rect, so it stays correct while the finger is moving.
function lbClampPan() {
  const img = lbImg(), stage = lbStage();
  if (!img || !stage) return;
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const maxX = Math.max(0, (img.offsetWidth * lb.scale - availW) / 2);
  const maxY = Math.max(0, (img.offsetHeight * lb.scale - availH) / 2);
  lb.tx = Math.min(maxX, Math.max(-maxX, lb.tx));
  lb.ty = Math.min(maxY, Math.max(-maxY, lb.ty));
}
function lbApply(animate) {
  const img = lbImg();
  if (!img) return;
  img.style.transition = animate ? 'transform .16s ease-out' : '';
  img.style.transform = `translate(${lb.tx.toFixed(1)}px, ${lb.ty.toFixed(1)}px) scale(${lb.scale.toFixed(4)})`;
  $('#lightbox').classList.toggle('zoomed', lb.scale > 1.001);
}
function lbReset() {
  lb.scale = 1; lb.tx = 0; lb.ty = 0;
  lb.ptrs.clear(); lb.pinch = null; lb.pan = null; lb.swipe = null;
  const img = lbImg();
  if (img) { img.style.transition = ''; img.style.transform = ''; }
  const root = $('#lightbox');
  if (root) { root.classList.remove('zoomed', 'dragging'); root.style.transform = ''; root.style.opacity = ''; root.style.transition = ''; }
}
// The arrows exist only while the item on screen HAS neighbours, and each one
// goes dark at its end: a set of media has a first and a last, and an arrow
// that silently does nothing is worse than one that says it cannot.
function lbPaintNav() {
  const n = lb.items ? lb.items.length : 0;
  const prev = $('#lb-prev'), next = $('#lb-next');
  if (prev) { prev.classList.toggle('hidden', n < 2); prev.disabled = lb.index - 1 < 0; }
  if (next) { next.classList.toggle('hidden', n < 2); next.disabled = lb.index + 1 > n - 1; }
}
// ---------- the strip ----------
// The message's media as a row of thumbnails along the bottom of the screen: the
// same set the arrows walk, in the same order, with the one on the stage lit and
// the rest dimmed. A press steps straight to that item — the arrows' shortcut for
// a message that shows ten — and the row scrolls sideways rather than shrinking
// its thumbs. It is up exactly while the viewer holds MORE THAN ONE item, which is
// the same condition the arrows have: a lone picture, an embed, a bookmark tile
// has nowhere to go and gets neither.
function lbStripTrack() { return $('#lb-strip-track'); }
function lbThumbImg(src) {
  const im = document.createElement('img');
  im.src = src; im.alt = ''; im.draggable = false;
  return im;
}
// One thumb's picture — and, for a CLIP, the frame that may not exist YET. A
// poster is captured by fetching the clip's own bytes, so a tile the reader never
// scrolled near (or one whose capture is still in flight) has no frame when the
// viewer opens; the thumb is built as the bare veil + play triangle and filled in
// when that frame lands, through the same one-frame-per-url cache the tile itself
// is waiting on (`whenVideoPoster`, messages.js — this asks for the capture, it
// never starts a second one). A picture always has its preview.
function lbFillThumb(b, it) {
  const src = it.thumb || it.poster || '';
  if (src) { b.appendChild(lbThumbImg(src)); return; }
  if (it.kind !== 'video' || typeof whenVideoPoster !== 'function') return;
  whenVideoPoster(it.src, (shot) => {
    if (!shot || !b.isConnected || b.querySelector('img')) return;
    b.insertBefore(lbThumbImg(shot), b.firstChild);
  });
}
function lbBuildStrip() {
  const root = $('#lightbox'), strip = $('#lb-strip'), track = lbStripTrack();
  if (!root || !strip || !track) return;
  const list = lb.items || [];
  const show = !!lb.open && list.length > 1;
  strip.classList.toggle('hidden', !show);
  root.classList.toggle('has-strip', show);
  track.textContent = '';
  if (!show) return;
  list.forEach((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-thumb';
    b.dataset.lbI = String(i);
    b.dataset.kind = it.kind === 'video' ? 'video' : 'image';
    b.setAttribute('aria-label', (it.kind === 'video' ? 'Video' : 'Photo') + ' ' + (i + 1) + ' of ' + list.length);
    lbFillThumb(b, it);
    track.appendChild(b);
  });
}
// Which thumb is the one on the stage — and keep it in view, so stepping through a
// long message never walks the lit thumb off the end of the row. Called on every
// lbShow, so the arrows, the keyboard and a press on the strip all move it.
function lbMarkStrip() {
  const track = lbStripTrack();
  if (!track) return;
  const on = track.children[lb.index];
  for (const b of [...track.children]) {
    const active = b === on;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
  if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch {} }
}
// Step one item. The ends are the ends — no wrap-around, so "next" on the last
// picture is the disabled arrow the reader can see.
function lbGo(delta) {
  if (!lb.open || !lb.items || !lb.items.length) return;
  const i = lb.index + delta;
  if (i < 0 || i > lb.items.length - 1) return;
  lb.index = i;
  lbShow(lb.items[i]);
}
// Paint ONE item: a picture on the image, a CLIP on the player (its own controls,
// so play/pause, scrub and fullscreen are the browser's — and it autoplays on the
// press that opened the viewer, when the engine allows it), the corner download
// button (the attachment's own name, so the file lands as the file it was posted
// as), the arrows that say where in the set this one is, and the strip. Every
// change starts from a clean stage, so a zoom can never carry over to the next
// picture and a clip never keeps playing behind the picture that replaced it.
function lbShow(item) {
  const it = item || {};
  const img = lbImg(), vid = lbVid();
  lbReset();
  const isVid = it.kind === 'video';
  if (isVid) {
    if (img) { img.classList.add('hidden'); img.removeAttribute('src'); }
    if (vid) {
      vid.classList.remove('hidden');
      if ((vid.getAttribute('src') || '') !== (it.src || '')) vid.setAttribute('src', it.src || '');
      try { vid.poster = it.poster || ''; } catch {}
      // The press that opened the viewer is the gesture; an engine that still
      // refuses (or a headless page) leaves the controls in charge, silently.
      try { const p = vid.play(); if (p && p.catch) p.catch(() => {}); } catch {}
    }
  } else {
    if (vid) {
      try { vid.pause(); } catch {}
      vid.classList.add('hidden');
      vid.removeAttribute('src');
      try { vid.load(); } catch {}
    }
    if (img) { img.classList.remove('hidden'); img.src = it.src || ''; }
  }
  const root = $('#lightbox');
  if (root) root.classList.toggle('vid', isVid);
  const dl = $('#lightbox-dl');
  if (dl) {
    if (it.src && it.name) { dl.href = it.src; dl.setAttribute('download', it.name); dl.classList.remove('hidden'); }
    else { dl.removeAttribute('href'); dl.classList.add('hidden'); }
  }
  lbPaintNav();
  lbMarkStrip();
}
function closeLightbox() {
  const root = $('#lightbox');
  if (!root || !lb.open) return;
  lb.gen++;
  lb.open = false;
  root.classList.add('hidden');
  const img = lbImg();
  if (img) img.removeAttribute('src');
  const vid = lbVid();
  if (vid) {
    // A clip that kept playing after the viewer closed would be sound with no
    // picture attached to it.
    try { vid.pause(); } catch {}
    vid.classList.add('hidden');
    vid.removeAttribute('src');
    try { vid.load(); } catch {}
  }
  root.classList.remove('vid');
  $('#lightbox-dl')?.classList.add('hidden');
  lb.items = null; lb.index = 0;
  lbPaintNav();
  lbBuildStrip();
  lbReset();
}
// `gallery` (optional) is what lbGalleryAt answered: the message's media in order,
// and where in them the one that was pressed sits. With it, the viewer opens on
// THAT item and the side arrows (and the strip) walk the rest; with more than one
// item they appear, and with a single one (or none: an embed, a bookmark tile)
// there is exactly one thing to see and neither.
function openLightbox(src, name, gallery) {
  const root = $('#lightbox');
  const img = lbImg();
  if (!root || !img) return;
  lb.gen++;
  lbReset();
  const list = gallery && Array.isArray(gallery.items) && gallery.items.length ? gallery.items : null;
  const first = list ? Math.max(0, Math.min(list.length - 1, Number(gallery.index) || 0)) : 0;
  lb.items = list && list.length > 1 ? list : null;
  lb.index = first;
  lb.open = true;
  root.classList.remove('hidden');
  lbBuildStrip();
  lbShow(list ? list[first] : { src: src || '', name: name || '' });
}
// Zoom about a point given in stage-centre coordinates (the same convention as
// the story composer's pinch): the content under the point stays under it.
function lbZoomAt(scale, mx, my) {
  const next = Math.min(LB_MAX, Math.max(LB_MIN, scale));
  const k = next / lb.scale;
  lb.tx = mx - (mx - lb.tx) * k;
  lb.ty = my - (my - lb.ty) * k;
  lb.scale = next;
  lbClampPan();
  lbApply(false);
}
function lbToggleZoom(cx, cy) {
  const stage = lbStage();
  if (!stage || lbIsVid()) return;
  if (lb.scale > 1.001) { lb.scale = 1; lb.tx = 0; lb.ty = 0; lbApply(true); return; }
  const r = stage.getBoundingClientRect();
  const mx = cx - (r.left + r.width / 2), my = cy - (r.top + r.height / 2);
  lb.scale = 1; lb.tx = 0; lb.ty = 0;
  lbZoomAt(2.4, mx, my);
  lbApply(true);
}
function lbSlideOut() {
  const root = $('#lightbox');
  const g = lb.gen;
  root.classList.remove('dragging');
  root.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
  root.style.transform = 'translateY(100%)';
  root.style.opacity = '0';
  setTimeout(() => { if (lb.gen === g) closeLightbox(); }, 210);
}
$('#lightbox')?.addEventListener('pointerdown', (e) => {
  if (!lb.open) return;
  // The bar, the arrows and the strip own their own presses: the gesture handlers
  // (and the tap-the-backdrop-to-close rule) must never see them.
  if (e.target.closest('#lb-bar, .lb-nav, #lb-strip')) return;
  lb.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lb.ptrs.size === 2) {
    lb.pan = null; lb.swipe = null;
    // A playing clip is not pinched: the two-finger gesture is the player's own
    // (iOS hands it to fullscreen), and a photo pinch over it would zoom a picture
    // that is not on the stage.
    if (lbIsVid()) return;
    const [a, b] = [...lb.ptrs.values()];
    const r = lbStage().getBoundingClientRect();
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    lb.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: lb.scale, tx: lb.tx, ty: lb.ty, mx: c.x - (r.left + r.width / 2), my: c.y - (r.top + r.height / 2) };
  } else if (lb.ptrs.size === 1) {
    if (lb.scale > 1.001) lb.pan = { x: e.clientX, y: e.clientY, tx: lb.tx, ty: lb.ty, moved: false };
    else lb.swipe = { x: e.clientX, y: e.clientY, t0: Date.now(), dy: 0, moved: false };
  }
});
$('#lightbox')?.addEventListener('pointermove', (e) => {
  if (!lb.open || !lb.ptrs.has(e.pointerId)) return;
  lb.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const r = lbStage().getBoundingClientRect();
  if (lb.pinch && lb.ptrs.size >= 2) {
    e.preventDefault();
    const [a, b] = [...lb.ptrs.values()];
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const z = Math.min(LB_MAX, Math.max(LB_MIN, lb.pinch.scale * (d / lb.pinch.d)));
    const k = z / lb.pinch.scale;
    lb.scale = z;
    lb.tx = (c.x - (r.left + r.width / 2)) - (lb.pinch.mx - lb.pinch.tx) * k;
    lb.ty = (c.y - (r.top + r.height / 2)) - (lb.pinch.my - lb.pinch.ty) * k;
    lbClampPan();
    lbApply(false);
    return;
  }
  if (lb.pan) {
    e.preventDefault();
    const dx = e.clientX - lb.pan.x, dy = e.clientY - lb.pan.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) lb.pan.moved = true;
    lb.tx = lb.pan.tx + dx; lb.ty = lb.pan.ty + dy;
    lbClampPan();
    lbApply(false);
    return;
  }
  if (lb.swipe) {
    const dx = e.clientX - lb.swipe.x, dy = e.clientY - lb.swipe.y;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      // Sideways is not a dismissal. In a gallery it is the next/previous
      // gesture, decided on release; a zoomed photo pans instead, and that path
      // never gets here (see the pointerdown branch above).
      lb.swipe.dx = dx;
      return;
    }
    if (Math.abs(dy) > 8) lb.swipe.moved = true;
    const root = $('#lightbox');
    if (dy > 0) {
      lb.swipe.dy = dy;
      root.classList.add('dragging');
      root.style.transition = '';
      root.style.transform = `translateY(${Math.round(dy)}px)`;
      root.style.opacity = String(Math.max(0.4, 1 - dy / 700));
    } else { lb.swipe.dy = 0; root.style.transform = ''; root.style.opacity = ''; }
  }
});
// Up/cancel on the window, not the overlay: a finger that leaves the picture
// (or a pointer the browser cancels) must still retire its entry, or the next
// single-finger tap reads as a two-finger pinch.
function lbPointerUp(e) {
  if (!lb.ptrs.has(e.pointerId)) return;
  lb.ptrs.delete(e.pointerId);
  if (lb.pinch) {
    if (lb.ptrs.size < 2) lb.pinch = null;
    if (lb.ptrs.size === 1) {
      const p = [...lb.ptrs.values()][0];
      if (lb.scale > 1.001) lb.pan = { x: p.x, y: p.y, tx: lb.tx, ty: lb.ty, moved: true };
    }
    if (lb.ptrs.size) return;
  }
  if (lb.ptrs.size) return;
  const wasPan = lb.pan, swipe = lb.swipe, target = e.target;
  lb.pan = null; lb.swipe = null;
  if (!lb.open) return;
  if (swipe && swipe.moved) {
    const d = swipe.dy, v = d / Math.max(1, Date.now() - swipe.t0);
    if (d > 110 || (v > 0.55 && d > 40)) { lbSlideOut(); return; }
    const root = $('#lightbox'); // short drag: spring back
    root.classList.remove('dragging');
    root.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
    root.style.transform = ''; root.style.opacity = '';
    setTimeout(() => { if (lb.open) root.style.transition = ''; }, 200);
    return;
  }
  if (wasPan && wasPan.moved) return;
  // A sideways drag past the threshold steps the gallery — the touch twin of the
  // side arrows (below it the drag was a tap, which the zoom/close rules own).
  if (swipe && Math.abs(swipe.dx || 0) > LB_SWIPE_PX) { lbGo(swipe.dx < 0 ? 1 : -1); return; }
  // A tap on the photo toggles the zoom. Mouse and pen get it on the first
  // click (click to zoom in, click again to zoom out); touch keeps double-tap
  // so a stray single tap never jumps the zoom. A tap on the backdrop closes —
  // but a tap on the PLAYER (or on its own controls, whose events the browser
  // retargets at the element) is the player's, and closing the viewer out from
  // under a pause button would be the worst possible answer to it.
  if (target === lbImg()) {
    if (e.pointerType === 'touch') {
      const now = Date.now();
      const near = Math.hypot(e.clientX - lb.tapX, e.clientY - lb.tapY) < 60;
      if (now - lb.lastTap < 320 && near) { lb.lastTap = 0; lbToggleZoom(e.clientX, e.clientY); }
      else { lb.lastTap = now; lb.tapX = e.clientX; lb.tapY = e.clientY; }
    } else {
      lbToggleZoom(e.clientX, e.clientY);
    }
    return;
  }
  const vid = lbVid();
  if (vid && !vid.classList.contains('hidden') && (target === vid || (vid.contains && vid.contains(target)))) return;
  closeLightbox();
}
window.addEventListener('pointerup', lbPointerUp);
window.addEventListener('pointercancel', lbPointerUp);
// Trackpad pinch arrives as ctrl+wheel on desktop (the photo's gesture only).
$('#lightbox')?.addEventListener('wheel', (e) => {
  if (!lb.open || !e.ctrlKey || lbIsVid()) return;
  e.preventDefault();
  const r = lbStage().getBoundingClientRect();
  lbZoomAt(lb.scale * (1 - e.deltaY / 240), e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
}, { passive: false });
$('#lightbox-close')?.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
$('#lightbox-dl')?.addEventListener('click', (e) => {
  // Don't let the tap reach the overlay (which would close it); the anchor
  // still downloads natively. Toast here — the document-level att-dl toast
  // never sees this click because of the stopPropagation.
  e.stopPropagation();
  const dl = e.currentTarget;
  toast(`Downloading ${(dl.getAttribute('download') || 'image').slice(0, 60)}…`);
});
// The side arrows. They sit ON the overlay, so a press over them must never
// reach the stage's gesture handlers (the pointerdown guard above) — and the
// click that follows steps the gallery, without closing the viewer.
$('#lb-prev')?.addEventListener('click', (e) => { e.stopPropagation(); lbGo(-1); });
$('#lb-next')?.addEventListener('click', (e) => { e.stopPropagation(); lbGo(1); });
// The strip's own thumbs, on the same terms: a press over them never reaches the
// stage (see the pointerdown guard), and the click that follows steps straight to
// that item. A press on the one already on the stage does nothing — there is
// nowhere to go, and re-painting it would restart a clip.
$('#lb-strip')?.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.lb-thumb') : null;
  if (!b || !lb.open || !lb.items) return;
  e.stopPropagation();
  const i = Number(b.dataset.lbI);
  if (!(i >= 0) || i === lb.index || i > lb.items.length - 1) return;
  lb.index = i;
  lbShow(lb.items[i]);
});
// …and their desktop twin: the arrow keys, while the viewer is up. A field
// keeps its own left/right (nothing opens one behind the lightbox, but the
// rule costs nothing and a stray keypress must never jump the page).
document.addEventListener('keydown', (e) => {
  if (!lb.open || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  lbGo(e.key === 'ArrowRight' ? 1 : -1);
});

// ---------- user card action tabs ----------
// The card's actions are a vertical list of tab rows (icon + label), not a
// wrapped row of pills: they read top-to-bottom like a menu and the destructive
// ones sit last. No emoji in chrome, so every tab carries an inline SVG.
const UC_ICONS = {
  mention: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  plus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  'x-user': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 8l5 5M22 8l-5 5"/>',
  'check-user': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M16 11l2 2 4-4"/>',
  'minus-user': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
  slash: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
};
function ucIconHTML(name) {
  const d = UC_ICONS[name];
  if (!d) return '';
  return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
// `mod` is ' primary' | ' danger' | '' — one tab row.
function ucTabHTML(id, icon, label, mod = '') {
  return `<button type="button" class="uc-tab${mod}" id="${id}">${ucIconHTML(icon)}<span>${label}</span></button>`;
}
// The user card's Remove tab. Groups have no mod roles, so removal is the group
// creator's alone — the same predicate the member row's right-click / long-press
// menu goes through (canRemoveGroupMember in actions.js), so the two paths can
// never disagree about who may remove whom. '' when it is not on offer.
function groupRemoveTabHTML(t, uid) {
  if (!canRemoveGroupMember(t, uid)) return '';
  return ucTabHTML('uc-remove', 'x-user', 'Remove', ' danger');
}
// ---------- user card ----------
// A click that OPENS a card is not a click "outside" it. The card's closer
// (final.js) listens on document, so it runs after the row's own click handler
// in the SAME click — and the microtask between the two is all openUserCard
// needs to paint the card when the roster is already loaded (ensureFriends()
// returns without fetching for 30s after a refresh). The closer therefore read
// a brand-new card as "outside" and shut it in the tick it appeared: the Active
// Now rail, a 1:1 DM's header name and a context menu's "View profile" all read
// as dead — but only on an account whose friend list was warm, which is why a
// fresh page (or a test that injects friends) never reproduced it. One counter,
// bumped in the CAPTURE phase so it already carries this click's number when the
// opener runs, stamped on the card by openUserCard; the closer asks whether the
// click it is handling is that one.
let ucClickSeq = 0;
document.addEventListener('click', () => { ucClickSeq++; }, true);
function ucOpenedByThisClick() {
  const c = $('#usercard');
  return !!c && c.dataset.openClick === String(ucClickSeq);
}
// Member-rail cards open to the LEFT of the sidebar, never over it.
function openMemberCard(uid, rowEl, y, opts = {}) {
  const p = $('#members')?.getBoundingClientRect();
  const r = rowEl?.getBoundingClientRect?.();
  const w = Math.min(300, innerWidth - 16);
  openUserCard(uid, (p && p.width ? p.left : (r ? r.left : innerWidth)) - w - 8, r ? r.top : y, null, opts);
}
// The phone shape of the person popover: a full-height sheet that slides up from
// the bottom. The sheet CSS (`#usercard.sheet` in the phone block) owns the
// geometry, so the popup's inline positioning is dropped — and clampUserCard()
// bails on a sheet for the same reason. Shared by the me bar (openOwnCard) and a
// 1:1 DM's header name (ui.js).
function userCardAsSheet(card) {
  card.classList.add('sheet');
  card.style.left = ''; card.style.top = ''; card.style.bottom = '';
  card.style.maxHeight = ''; card.style.overflowY = '';
}
async function openUserCard(uid, x, y, fallback, opts = {}) {
  const openClick = ucClickSeq; // this click's number, read before any await
  if (S.me && uid !== S.me.id) await ensureFriends();
  // `fallback` is for rows that already hold the person: a story's viewers list
  // can name someone in no loaded roster (a viewer who shares a server you do
  // not have open, or no server at all), and the card is the whole point of the
  // tap. Same contract as openProfileScreen below.
  const u = memberById(uid) || (fallback && fallback.id === uid ? fallback : null);
  if (!u) return;
  const card = $('#usercard');
  const canMod = S.view === 'server' && S.serverDetail && canManage() && uid !== S.me.id && uid !== S.serverDetail.owner_id;
  // Group chats have no mod roles, so removal is the group creator's alone and
  // lives on the card exactly like a server's Kick/Ban: the same predicate the
  // member row's right-click / long-press menu uses (groupRemoveTabHTML).
  const dmThread = S.view === 'home' ? (S.dms || []).find((t) => t.id === S.dmThreadId) : null;
  // Voice: local volume for anyone in my current call, plus mod controls +
  // watch button when applicable.
  const inMyCall = !!(S.voice && S.me && uid !== S.me.id && occupantInMyRoom(uid));
  const myPeer = inMyCall ? (myRoomOccupants().find((p) => p.id === uid) || null) : null;
  let canVoiceMod = false;
  if (inMyCall) {
    if (S.voice.kind === 'server') canVoiceMod = S.view === 'server' && !!S.serverDetail && canManage() && uid !== S.serverDetail.owner_id;
    else {
      const t = (S.dms || []).find((x) => x.id === S.voice.threadId);
      canVoiceMod = !!(t && t.created_by && S.me && t.created_by === S.me.id);
    }
  }
  const volVal = getUserVolume(uid);
  // A stream carries its own audio (usually a game/system mix), so it gets its
  // own slider — turning the game down must not turn the person down. The
  // stream row only exists when that share really has an audio track; it is
  // painted hidden otherwise and refreshUserCardVolumes() reveals it live if
  // the track lands while the card is open.
  const streamVolVal = getUserStreamVolume(uid);
  const hasStreamAudio = !!(myPeer && myPeer.sharing && peerStreamAudio(uid));
  const streamHidden = hasStreamAudio ? '' : ' hidden';
  const voiceVolHTML = inMyCall ? `
      <div class="uc-sec-label">Mic volume</div>
      <div class="uc-vol"><input type="range" id="uc-vol" min="0" max="100" step="1" value="${volVal}" aria-label="Mic volume" /><span id="uc-vol-pct">${volVal}%</span></div>
      <div class="uc-sec-label uc-vol-stream-label${streamHidden}">Stream volume</div>
      <div class="uc-vol uc-vol-stream${streamHidden}"><input type="range" id="uc-vol-stream" min="0" max="100" step="1" value="${streamVolVal}" aria-label="Stream volume" /><span id="uc-vol-stream-pct">${streamVolVal}%</span></div>` : '';
  const peerMuted = !!(myPeer && (myPeer.muted || myPeer.serverMuted));
  const voiceModHTML = (inMyCall && (canVoiceMod || (myPeer && myPeer.sharing))) ? `
      <div class="uc-sec-label">Voice call</div>
      <div class="uc-actions" style="margin-top:0">${myPeer && myPeer.sharing ? '<button class="btn small primary" id="uc-watch">Watch stream</button>' : ''}${canVoiceMod ? `<button class="btn small${peerMuted ? '' : ' danger'}" id="uc-vmute">${peerMuted ? 'Unmute' : 'Mute'}</button><button class="btn small danger" id="uc-vdrop">Disconnect</button>` : ''}</div>` : '';
  const st = statusOf(uid);
  const streaming = !isOff(st) && (u.streaming_game || null);
  const ban = u.banner_url || u.sidebar_banner_url;
  card.dataset.uid = uid;
  // The click that asked for this card — its own closer must not read it as a
  // click outside (see ucOpenedByThisClick at the top of this section).
  card.dataset.openClick = String(openClick);
  // The status menu always opens as just your current status.
  if (uid === S.me.id) presenceMenu = { open: false, cascade: null };
  card.style.background = cardBgFor(u);
  // A custom card colour is the card's own backdrop, so the text on it stops
  // being the theme's business — cardInkFor (servers.js) reads that colour and
  // says which ink the card must wear. Cleared for a card that has none, so the
  // theme's own tones come back.
  const ink = cardInkFor(u);
  card.classList.toggle('uc-ink-light', ink === 'light');
  card.classList.toggle('uc-ink-dark', ink === 'dark');
  card.innerHTML = `
    <div class="uc-banner"${ban ? ` style="background-image:url('${esc(ban)}')"` : ''}></div>
    <div class="uc-body">
      <div class="uc-head"><span class="avatar big"></span>${statusBubbleHTML(u)}</div>
      <div class="uc-name"><span style="${nameStyleFor(u)}">${esc(u.display_name)}</span>${tagHTML(u)}</div>
      <div class="uc-sub">@${esc(u.username)}${u.role === 'owner' ? ' · server owner' : ''}</div>
      ${isSysAdmin(u) || isEarlyUser(u) ? `<div class="uc-badges">${isSysAdmin(u) ? '<span class="sysadmin-badge">System admin</span>' : ''}${isEarlyUser(u) ? '<span class="early-badge">Early user</span>' : ''}</div>` : ''}
      ${uid === S.me.id
        ? presenceWidgetHTML()
        : `<div class="uc-status" id="uc-statusline">${statusLineHTML(uid, u)}</div>`}
      ${streaming ? `<div class="uc-statustext ustream"><span class="vlive">LIVE</span><span>Streaming ${esc(streaming)}</span></div>` : ''}
      ${u.playing_game ? gameRowHTML(u) : ''}
      ${u.bio ? `<div class="uc-bio">${renderRich(u.bio)}</div>` : ''}
      ${u.created_at ? `<div class="uc-since">Member since ${fmtJoined(u.created_at)}</div>` : ''}
      <div id="uc-gaming" class="uc-gaming hidden"></div>
      ${voiceVolHTML}
      ${voiceModHTML}
      ${cardRolesHTML(uid)}
      <div class="uc-tabs">${uid !== S.me.id ? ucTabHTML('uc-mention', 'mention', 'Mention') : ''}${uid !== S.me.id && !isBlocked(uid) ? ucTabHTML('uc-message', 'message', 'Message', ' primary') : ''}${uid !== S.me.id && !isBlocked(uid) ? friendBtnHTML(uid, 'uc-friend', 'uc-tab', true) : ''}${canMod ? ucTabHTML('uc-kick', 'minus-user', 'Kick', ' danger') + ucTabHTML('uc-ban', 'x-user', 'Ban', ' danger') : ''}${groupRemoveTabHTML(dmThread, uid)}${uid !== S.me.id ? ucTabHTML('uc-block', isBlocked(uid) ? 'check' : 'slash', isBlocked(uid) ? 'Unblock' : 'Block', isBlocked(uid) ? '' : ' danger') : ''}${ucTabHTML('uc-profile', 'user', 'Profile')}${ucTabHTML('uc-close', 'close', 'Close')}</div>
    </div>`;
  paintAvatar(card.querySelector('.avatar'), u);
  paintGameBadge(card.querySelector('.gbadge'));
  try { paintUserCardStory(card, u); } catch {}
  wireStatusBubble(card);
  wirePresenceWidget(card);
  loadUserGaming($('#uc-gaming'), u.username, { compact: true });
  card.style.bottom = ''; card.style.maxHeight = ''; card.style.overflowY = '';
  card.classList.remove('hidden');
  const h = card.offsetHeight || 300; // offsetHeight, not the animating rect (see popupBox)
  if (opts.sheet) userCardAsSheet(card);
  else {
    card.classList.remove('sheet');
    card.style.left = Math.max(8, Math.min(x || 8, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
    card.style.top = Math.max(8, Math.min(y || 8, innerHeight - h - 8)) + 'px';
  }
  $('#uc-close').onclick = closeUserCard;
  const pr = $('#uc-profile');
  if (pr) pr.onclick = () => { closeUserCard(); openProfileScreen(uid, u); };
  const men = $('#uc-mention');
  if (men) men.onclick = () => { insertAtCursor($('#in-message'), '@' + u.username + ' '); closeUserCard(); $('#in-message').focus(); };
  const msg = $('#uc-message');
  if (msg) msg.onclick = () => messageUser(uid);
  const blk = $('#uc-block');
  if (blk) blk.onclick = () => { const was = isBlocked(uid), nm = u.username; closeUserCard(); if (was) unblockUser(uid); else blockUser(uid, nm); };
  const fr = $('#uc-friend');
  if (fr) fr.onclick = () => friendCardAction(uid, x, y);
  const kik = $('#uc-kick');
  if (kik) kik.onclick = () => { closeUserCard(); modServerMember('kick', u); };
  const vvol = $('#uc-vol');
  if (vvol) vvol.oninput = () => {
    setUserVolume(uid, vvol.value);
    const pct = $('#uc-vol-pct');
    if (pct) pct.textContent = getUserVolume(uid) + '%';
  };
  const svol = $('#uc-vol-stream');
  if (svol) svol.oninput = () => {
    setUserStreamVolume(uid, svol.value);
    const pct = $('#uc-vol-stream-pct');
    if (pct) pct.textContent = getUserStreamVolume(uid) + '%';
  };
  const wch = $('#uc-watch');
  if (wch) wch.onclick = () => { closeUserCard(); watchStream(uid); };
  const vmu = $('#uc-vmute');
  if (vmu) vmu.onclick = async () => {
    sendVoiceMod(peerMuted ? 'unmute' : 'mute', uid);
    toast((peerMuted ? 'Unmuted @' : 'Muted @') + u.username);
    setTimeout(() => { try { if (!$('#usercard').classList.contains('hidden')) openUserCard(uid, x, y); } catch {} }, 800);
  };
  const vdr = $('#uc-vdrop');
  if (vdr) vdr.onclick = async () => {
    const ok = await openConfirmModal({
      title: `Disconnect @${u.username} from voice?`,
      message: 'They will be removed from the voice room but stay on the server.',
      okLabel: 'Disconnect',
    });
    if (!ok) return;
    sendVoiceMod('disconnect', uid);
    closeUserCard();
    toast('Disconnected @' + u.username);
  };
  const bnn = $('#uc-ban');
  if (bnn) bnn.onclick = () => { closeUserCard(); modServerMember('ban', u); };
  const rmv = $('#uc-remove');
  if (rmv) rmv.onclick = () => { closeUserCard(); modGroupMember(dmThread, u); };
  card.querySelectorAll('[data-role-toggle]').forEach((b) => (b.onclick = async () => {
    const rid = b.dataset.roleToggle, has = b.dataset.has === '1';
    try {
      if (has) await api(`/api/servers/${S.serverDetail.id}/roles/${rid}/members/${uid}`, { method: 'DELETE' });
      else await api(`/api/servers/${S.serverDetail.id}/roles/${rid}/members`, { method: 'POST', body: JSON.stringify({ userId: uid }) });
      const { server } = await api('/api/servers/' + S.serverDetail.id);
      S.serverDetail = server;
      renderMembers();
      openUserCard(uid, x, y);
    } catch (err) { toast('Failed: ' + prettyError(err.message)); }
  }));
}
// A swipe-down dismiss leaves an inline `transform` (and the `animation: none`
// that let the drag take over the entry animation) on the panel — clear both so
// the next open animates in and nothing starts offset.
function closeUserCard() {
  const c = $('#usercard');
  c.classList.add('hidden');
  c.classList.remove('sheet');
  c.style.transform = '';
  c.style.transition = '';
  c.style.animation = '';
}
// The peer's stream-audio track can land (or end) while their card is open —
// the share's audio is negotiable, so the Stream volume row has to appear and
// retire with it rather than being decided once at paint time. Called from
// voice.js (streamAudioChanged) for the media's own transitions.
function refreshUserCardVolumes(uid) {
  try {
    const c = $('#usercard');
    if (!c || c.classList.contains('hidden') || c.dataset.uid !== uid) return;
    const show = peerStreamAudio(uid);
    for (const el of c.querySelectorAll('.uc-vol-stream, .uc-vol-stream-label')) el.classList.toggle('hidden', !show);
  } catch {}
}
// A game STARTING or STOPPING while the card is open is exactly what the card's
// "Playing X" box is about, so that one row is swapped in place instead of
// waiting for the card to be reopened (a full card repaint on every presence
// frame would fight the reader's pointer, which is why the socket's user-update
// path deliberately leaves the card alone). Called from socket.js.
function refreshUserCardGame(u) {
  try {
    const c = $('#usercard');
    if (!c || !u || c.classList.contains('hidden') || c.dataset.uid !== u.id) return;
    const cur = c.querySelector('.uc-statustext.ugame');
    const html = u.playing_game ? gameRowHTML(u) : '';
    if (!html) { if (cur) cur.remove(); return; }
    if (cur) {
      cur.outerHTML = html;
    } else {
      // Same slot openUserCard paints it into: under the status row (or the
      // streaming one, which sits directly above it). No anchor → leave it be.
      const anchor = c.querySelector('.uc-statustext.ustream') || c.querySelector('.uc-status') || c.querySelector('.uc-sub');
      if (!anchor) return;
      anchor.insertAdjacentHTML('afterend', html);
    }
    paintGameBadge(c.querySelector('.uc-statustext.ugame .gbadge'));
  } catch {}
}
// The profile screen's live game state lives in its Gaming widget now — the
// standalone "Playing X" line is gone, and the session clock rides the widget's
// "Currently playing X" line instead — so a game starting or stopping while
// somebody reads the screen has to re-read that widget. Only a frame that
// actually changed the live game does: user-updated also carries presence and
// status churn, and re-fetching the whole widget on each of those would be a
// request per heartbeat. `#pf-gaming`'s own `data-live` (written by
// loadUserGaming, including on its early return) is what makes that comparison
// possible. Called from socket.js.
function refreshProfileGame(u) {
  try {
    const bd = $('#profile-backdrop');
    if (!bd || !u || bd.classList.contains('hidden') || String(bd.dataset.uid) !== String(u.id)) return;
    const box = $('#pf-gaming');
    if (!box) return;
    const live = u.playing_game || '';
    if (String(box.dataset.live || '') === String(live)) return;
    loadUserGaming(box, u.username, { canDelete: String(u.id) === String(S.me.id) });
  } catch {}
}
// ---------- server tag mini-panel ----------
function closeTagCard() { $('#tagcard').classList.add('hidden'); }
async function tagServerInfo(sid) {
  const local = (S.servers || []).find((s) => s && s.id === sid)
    || (S.serverDetail && S.serverDetail.id === sid ? S.serverDetail : null);
  if (local) return { id: local.id, name: local.name, description: local.description || '', icon_url: local.icon_url || null, banner_url: local.banner_url || null, tag: local.tag || null, tag_emoji: local.tag_emoji || null, member: true };
  const { server } = await api('/api/servers/' + sid + '/preview');
  return { ...server, member: false };
}
async function openTagCard(sid, x, y) {
  if (!sid) return;
  const card = $('#tagcard');
  card.innerHTML = '<div class="tc-banner"></div><div class="tc-body"><div class="tc-name muted">Loading…</div></div>';
  card.classList.remove('hidden');
  const place = () => {
    const r = card.getBoundingClientRect();
    card.style.left = Math.max(8, Math.min(x || 8, innerWidth - (r.width || 280) - 8)) + 'px';
    card.style.top = Math.max(8, Math.min(y || 8, innerHeight - (r.height || 200) - 8)) + 'px';
  };
  place();
  let info = null;
  try { info = await tagServerInfo(sid); } catch { info = null; }
  if (card.classList.contains('hidden')) return;
  if (!info) {
    card.innerHTML = '<div class="tc-error">Couldn\'t load this server.</div><div class="tc-actions" style="padding:0 1rem 1rem"><button class="btn small" id="tc-close">Close</button></div>';
  } else {
    const initial = (info.name || '?').trim().charAt(0).toUpperCase() || '?';
    card.innerHTML = `
      <div class="tc-banner"${info.banner_url ? ` style="background-image:url('${esc(info.banner_url)}')"` : ''}></div>
      <div class="tc-body">
        <span class="tc-icon">${info.icon_url ? `<img src="${esc(info.icon_url)}" alt="" />` : esc(initial)}</span>
        <div class="tc-name">${esc(info.name || 'Unknown server')}</div>
        ${(info.tag_emoji || info.tag) ? `<div class="tc-tagline"><span class="usertag">${esc((info.tag_emoji || '') + (info.tag || ''))}</span></div>` : ''}
        ${info.description ? `<div class="tc-desc">${esc(info.description)}</div>` : ''}
        <div class="tc-actions">${info.member ? '<button class="btn small primary" id="tc-view">View server</button>' : ''}<button class="btn small" id="tc-close">Close</button></div>
      </div>`;
    const vw = $('#tc-view');
    if (vw) vw.onclick = () => { closeTagCard(); selectServer(info.id); };
  }
  const cl = $('#tc-close');
  if (cl) cl.onclick = closeTagCard;
  place();
}
// The role pills on the card. A rank the person HOLDS wears the role's own
// colour as its ink, which is a user-chosen colour sitting on a user-chosen
// backdrop — so it may not touch the backdrop directly. The chip's dark grey
// belongs to the stylesheet (`#usercard .role-pill.on`), which is why the inline
// style here sets the border and the ink and never a background: the 13% tint of
// the role colour that used to be the background made the pill part of the card
// again, and a violet rank on a violet card was invisible (reported). `on` marks
// held in BOTH shapes — the manager's toggle and a viewer's plain span — because
// the chip is what the class turns on.
function cardRolesHTML(uid) {
  if (S.view !== 'server' || !S.serverDetail) return '';
  const d = S.serverDetail;
  const m = d.members.find((x) => x.id === uid);
  if (!m || !(d.roles || []).length) return '';
  const mine = new Set(m.roleIds || []);
  const editable = canManage() && (uid !== d.owner_id || isOwner());
  let h = '<div class="uc-roles">';
  for (const r of d.roles) {
    const has = mine.has(r.id);
    const col = r.color ? ` style="border-color:${esc(r.color)};${has ? `color:${esc(r.color)};` : ''}"` : '';
    if (editable) h += `<button class="role-pill${has ? ' on' : ''}" data-role-toggle="${r.id}" data-has="${has ? '1' : '0'}"${col}>${has ? '✓ ' : '+ '}${esc(r.name)}</button>`;
    else if (has) h += `<span class="role-pill on"${col}>${esc(r.name)}</span>`;
  }
  return h + '</div>';
}
function fmtPlay(ms) {
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + 'm';
  if (h < 48) { const m = Math.round((h % 1) * 60); return Math.floor(h) + 'h' + (m ? ' ' + m + 'm' : ''); }
  return Math.floor(h / 24) + 'd ' + Math.round(h % 24) + 'h';
}
// Relative "last played" with full units: minutes → hours → days → weeks → months → years.
function fmtLastPlayed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.floor(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24);
  if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
  if (d < 30) { const w = Math.floor(d / 7); return w + (w === 1 ? ' week ago' : ' weeks ago'); }
  const mo = Math.floor(d / 30.44);
  if (mo < 12) return mo + (mo === 1 ? ' month ago' : ' months ago');
  const y = Math.floor(mo / 12);
  return y + (y === 1 ? ' year ago' : ' years ago');
}
function levelColor(lv) {
  if (lv >= 10) return '#ff4757';
  if (lv >= 7) return '#ff6348';
  if (lv >= 5) return '#ffa502';
  if (lv >= 3) return '#2ed573';
  return '#5b6cff';
}
async function loadUserGaming(box, username, opts = {}) {
  if (!box) return;
  box.classList.add('hidden');
  try {
    const g = await api('/api/users/' + encodeURIComponent(username) + '/gaming');
    const mu = (typeof memberByUsername === 'function' ? memberByUsername(username) : null) || null;
    // Authoritative "now playing": the live playing_game, not recency of
    // last_seen_ms (which stays fresh for minutes after quitting and made
    // the card keep saying "Playing X" after the game closed). The roster is
    // only the fallback for the frame that lands before the fetch does.
    const live = (g && g.now_playing) || (mu && mu.playing_game) || null;
    // What this widget is currently showing as live, recorded on the box itself
    // so an open profile screen can tell a real game change from a presence
    // heartbeat before it re-reads the widget (refreshProfileGame). Written
    // before the early return below: a game with no recorded playtime still
    // renders nothing here, and re-fetching it on every frame would be a loop.
    box.dataset.live = live || '';
    // The session's start comes from the same server fact the user card's clock
    // reads (users.playing_since, through the gaming payload), with the roster
    // as the fallback for the frame the payload has not caught up with.
    const liveSince = (g && g.playing_since) || (mu && mu.playing_since) || 0;
    if (!g || !g.total_ms) return;
    const { compact, canDelete } = opts;
    const hit = live ? (g.games || []).find((x) => x.game === live) : null;
    const nowPlaying = hit || (live ? { game: live } : null);
    if (compact) {
      const rows = (g.games || []).slice(0, 4).map((x) => `
        <div class="uc-gaming-row">
          <span class="uc-gaming-name">${esc(x.game)}</span>
          <span class="uc-gaming-meta">Lv ${x.level} · ${fmtPlay(x.total_ms)}</span>
        </div>
      `).join('');
      box.innerHTML = `
        <div class="uc-gaming-head">Gaming · Lv ${g.level} · ${fmtPlay(g.total_ms)}</div>
        ${nowPlaying ? `<div class="uc-gaming-now">Playing <b>${esc(nowPlaying.game)}</b></div>` : ''}
        ${rows}`;
    } else {
      const cards = (g.games || []).map((x) => {
        const col = levelColor(x.level);
        const isLive = live && x.game === live;
        const streakLine = x.streak
          ? `<span class="pf-badge streak">${x.streak}-day streak</span>${x.best_streak > x.streak ? `<span class="pf-game-best">Best ${x.best_streak} day${x.best_streak === 1 ? '' : 's'}</span>` : ''}`
          : (x.best_streak ? `<span class="pf-game-best">Best streak ${x.best_streak} day${x.best_streak === 1 ? '' : 's'}</span>` : '');
        return `
          <div class="pf-game-card" data-game="${esc(x.game)}">
            <div class="pf-game-icon" style="background:${col}">${x.icon_url ? `<img src="${esc(x.icon_url)}" alt="" loading="lazy" onerror="this.remove()" />` : esc(x.game.charAt(0).toUpperCase())}</div>
            <div class="pf-game-info">
              <div class="pf-game-top">
                <div class="pf-game-name">${esc(x.game)}</div>
                <span class="pf-badge lv" style="background:${col}22;color:${col}">Lv ${x.level}</span>
              </div>
              <div class="pf-game-time">${fmtPlay(x.total_ms)} <span>total</span></div>
              ${isLive
                ? '<div class="pf-game-sub"><span class="live-dot"></span><span class="pf-game-live">Playing now</span></div>'
                : (x.last_seen_ms ? `<div class="pf-game-sub">Last played ${fmtLastPlayed(x.last_seen_ms)}</div>` : '')}
              ${streakLine ? `<div class="pf-game-streak">${streakLine}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');
      box.innerHTML = `
        <div class="pf-gaming-head">
          <span class="pf-gaming-title">Gaming</span>
          <span class="pf-gaming-total">Lv ${g.level} · ${fmtPlay(g.total_ms)}${g.streak ? ' · ' + g.streak + 'd streak' : ''}${g.best_streak ? ' · best ' + g.best_streak + 'd' : ''}</span>
        </div>
        ${nowPlaying ? `<div class="pf-gaming-now"><span class="pf-gaming-now-name">Currently playing <b>${esc(nowPlaying.game)}</b></span>${gameClockHTML({ playing_since: liveSince })}</div>` : ''}
        <div class="pf-gaming-grid">${cards}</div>
      `;
      if (canDelete) {
        const doRemoveGame = async (game) => {
          const ok = await openConfirmModal({
            title: 'Remove ' + game + '?',
            message: 'Playtime, levels and streaks for this game are deleted for good. Detection keeps working — play it again and the record starts fresh.',
            okLabel: 'Remove',
            danger: true,
          });
          if (!ok) return;
          try {
            await api('/api/me/games/' + encodeURIComponent(game), { method: 'DELETE' });
            toast(game + ' removed from profile');
            loadUserGaming(box, username, opts);
          } catch (err) { toast('Failed: ' + prettyError(err.message)); }
        };
        box.querySelectorAll('.pf-game-card').forEach((card) => {
          const game = card.dataset.game;
          const menuItems = () => [{ label: 'Remove game', icon: '🗑', danger: true, fn: () => doRemoveGame(game) }];
          // Desktop: right-click menu (on touch devices the long-press sheet below owns this;
          // the browser's synthetic contextmenu must not also pop the floating menu)
          card.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isCoarse()) return;
            openCtx(e.clientX, e.clientY, menuItems());
          };
          // Touch: long-press opens the bottom sheet
          let lt = null, sx = 0, sy = 0;
          const cancelHold = () => { if (lt) { clearTimeout(lt); lt = null; } };
          card.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            sx = e.touches[0].clientX; sy = e.touches[0].clientY;
            cancelHold();
            lt = setTimeout(() => {
              lt = null;
              haptic(12);
              if (isCoarse()) openCtxSheet(menuItems(), { title: game, sub: meta });
              else openCtx(sx, sy, menuItems());
            }, 550);
          }, { passive: true });
          card.addEventListener('touchmove', (e) => {
            const t = e.touches && e.touches[0];
            if (t && Math.hypot(t.clientX - sx, t.clientY - sy) > 12) cancelHold();
          }, { passive: true });
          ['touchend', 'touchcancel'].forEach((ev) => card.addEventListener(ev, cancelHold, { passive: true }));
        });
      }
    }
    box.classList.remove('hidden');
    // The card was positioned before this async section filled in — pull
    // top-anchored cards back on screen if the growth pushed them off.
    // (Bottom-anchored cards grow upward and are left alone.)
    try { if (box && box.closest && box.closest('#usercard')) clampUserCard(); } catch {}
  } catch {}
}
// Re-clamp a top-anchored user card into the viewport (no-op while hidden
// or bottom-anchored).
function clampUserCard() {
  const card = $('#usercard');
  if (!card || card.classList.contains('hidden')) return;
  if (card.classList.contains('sheet')) return; // the mobile sheet owns its geometry
  if (card.style.bottom && card.style.bottom !== 'auto') return; // grows upward, always safe
  const h = card.offsetHeight || 300; // see popupBox: never measure mid-animation
  let left = parseFloat(card.style.left);
  let top = parseFloat(card.style.top);
  if (!Number.isFinite(left)) left = 8;
  if (!Number.isFinite(top)) top = 8;
  card.style.left = Math.max(8, Math.min(left, innerWidth - Math.min(296, innerWidth - 16))) + 'px';
  card.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
}
// ---------- custom status quick-edit (own user card) ----------
function fmtCountdown(ts) {
  const d = ts - Date.now();
  if (d <= 0) return 'soon';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'in under a minute';
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}
// Wall-clock form of a pending timer — "3:55 PM" — for the "Until …" notes on
// your own card. A countdown makes you do arithmetic; the clock time is what
// you actually want to read. Longer spans pick up the day so the hour is never
// ambiguous; same-day stays bare.
function fmtUntil(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const tmr = new Date(now.getTime() + 864e5);
  if (d.toDateString() === tmr.toDateString()) return 'tomorrow ' + time;
  if (d.getTime() - now.getTime() < 7 * 864e5) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}
// Custom status shown as a thought bubble beside the avatar (Discord-style).
// Other people only get a bubble when they set something; my own card always
// shows one so "set a status" lives up by the picture, not in the card body.
// My own SET bubble carries both controls in one oval chip INSIDE it, pinned to
// the bubble's trailing edge: a pencil that reopens the status in the editor,
// then the × that clears it (owner request: "add an edit pencil to the left of
// the x in the same box like make the circle more of an oval with 2 buttons").
// Inside rather than on the corner, because a chip hanging over a short bubble
// read as a stray control on the card behind it. The bubble itself stays a
// button that opens the same editor — the pencil is the visible affordance, the
// bubble's own box the big target.
const STATUS_PENCIL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
function statusBubbleHTML(u) {
  const mine = !!(S.me && u && u.id === S.me.id);
  const cur = ((u && u.status_text) || '').trim();
  if (!cur && !mine) return '';
  const exp = +((u && u.status_expires_at) || 0);
  const expNote = (mine && cur && exp > Date.now()) ? `<div class="uc-bubble-exp">Until ${fmtUntil(exp)}</div>` : '';
  const bubble = mine
    ? `<button type="button" class="uc-bubble edit${cur ? '' : ' empty'}" id="uc-status-edit" aria-label="${cur ? 'Edit custom status' : 'Set a custom status'}">${cur ? esc(cur) : 'Set a status'}</button>`
    : `<div class="uc-bubble">${esc(cur)}</div>`;
  const acts = (mine && cur)
    ? '<span class="uc-bubble-acts">'
      + `<button type="button" class="uc-bubble-act" id="uc-status-editpen" aria-label="Edit custom status" title="Edit status">${STATUS_PENCIL}</button>`
      + '<span class="uc-bub-sep" aria-hidden="true"></span>'
      + '<button type="button" class="uc-bubble-act danger" id="uc-status-clear" aria-label="Clear custom status" title="Clear status">×</button>'
      + '</span>'
    : '';
  return `<div class="uc-bubble-wrap"><div class="uc-bubble-fit">${bubble}${acts}</div>${expNote}</div>`;
}
function wireStatusBubble(card) {
  const se = card && card.querySelector('#uc-status-edit');
  if (se) se.onclick = () => openStatusEditor();
  const pen = card && card.querySelector('#uc-status-editpen');
  if (pen) pen.onclick = () => openStatusEditor();
  const sc = card && card.querySelector('#uc-status-clear');
  if (sc) sc.onclick = () => clearMyStatus();
}
// ---------- presence switcher (your own card) ----------
// A vertical menu, like Discord's status picker: it starts as just your current
// status, opening it cascades the states (each with a chevron), and picking one
// cascades that state's timer underneath it. It replaces the status readout line
// on your own card (the collapsed row IS the readout), so the avatar can just
// open the card like every other avatar does.
// STATUS_TEXT (the words a presence state is called) is shared from core.js.
const PRESENCE_STATES = [['online', 'Online'], ['away', 'Away'], ['dnd', 'Do not disturb'], ['invisible', 'Invisible']];
// How long away/dnd/invisible lasts before lapsing back to Online.
const PRESENCE_DURATIONS = [
  { label: 'For 15 Minutes', ms: 15 * 60e3 },
  { label: 'For 1 Hour', ms: 3600e3 },
  { label: 'For 4 Hours', ms: 4 * 3600e3 },
  { label: 'For 8 Hours', ms: 8 * 3600e3 },
  { label: 'For 24 Hours', ms: 24 * 3600e3 },
  { label: 'For 3 Days', ms: 3 * 864e5 },
  { label: 'Forever', ms: null },
];
const PRESENCE_CARET = '<span class="pcaret"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>';
// Open/cascaded state of the menu. Reset whenever the card opens, so it always
// starts as just your current status.
let presenceMenu = { open: false, cascade: null };
function statusLineHTML(uid, u) {
  const st = statusOf(uid);
  const streaming = !isOff(st) && (u.streaming_game || null);
  const label = streaming ? 'Streaming' : (STATUS_TEXT[st] || 'Offline');
  return `<span class="status-dot ${dotOf(st, streaming)}"></span><span>${label}</span>`;
}
// Index of the pending duration nearest the live timer (so the option stays lit
// on a reopen), else the last one — "Forever".
function presenceDurationSel(cur, exp) {
  if (cur === 'online' || !exp) return PRESENCE_DURATIONS.length - 1;
  let best = -1, bd = Infinity;
  PRESENCE_DURATIONS.forEach((p, i) => { if (p.ms) { const d = Math.abs((Date.now() + p.ms) - exp); if (d < bd) { bd = d; best = i; } } });
  return (best >= 0 && bd < 5 * 60e3) ? best : PRESENCE_DURATIONS.length - 1;
}
function presenceWidgetHTML() {
  if (!S.me) return '';
  const cur = S.me.status || 'online';
  const exp = presenceExpiry();
  const open = presenceMenu.open;
  const cascade = open ? presenceMenu.cascade : null;
  const toggle = `<button type="button" class="prow toggle" id="presence-toggle" aria-expanded="${open}" aria-controls="presence-list"><span class="status-dot ${dotOf(cur, false)}"></span><span class="plabel">${STATUS_TEXT[cur] || 'Online'}</span>${PRESENCE_CARET}</button>`;
  let list = '';
  if (open) {
    list = '<div class="plist" id="presence-list">' + PRESENCE_STATES.map(([id, label]) => {
      // Online has no timer, so no chevron and no cascade from it.
      const chevron = id === 'online' ? '' : PRESENCE_CARET;
      const willCascade = cascade === id;
      const row = `<button type="button" class="prow sub${cur === id ? ' sel' : ''}" data-presence="${id}" aria-pressed="${cur === id}"${id === 'online' ? '' : ` aria-expanded="${willCascade}"`}><span class="status-dot ${id}"></span><span class="plabel">${label}</span>${chevron}</button>`;
      if (!willCascade) return row;
      const sel = cur === id ? presenceDurationSel(cur, exp) : -1;
      const times = PRESENCE_DURATIONS.map((p, i) => `<button type="button" class="prow time${i === sel ? ' on' : ''}" data-presence-ms="${p.ms === null ? 'never' : p.ms}" data-presence-state="${id}">${p.label}</button>`).join('');
      return row + `<div class="ptimes">${times}</div>`;
    }).join('') + '</div>';
  }
  const note = (cur !== 'online' && exp) ? `<div class="uc-preseg-note">Until ${fmtUntil(exp)}</div>` : '';
  return `<div class="uc-presence" id="uc-presence">${toggle}${list}${note}</div>`;
}
function renderPresenceWidget(card) {
  // Swap just the menu so the open card never moves, rescales, or loses its
  // scroll position — then pull a top-anchored card back on screen if the
  // menu's growth pushed it off.
  const box = card && card.querySelector('#uc-presence');
  if (!box) return;
  box.outerHTML = presenceWidgetHTML();
  wirePresenceWidget(card);
  try { clampUserCard(); } catch {}
}
function wirePresenceWidget(card) {
  const box = card && card.querySelector('#uc-presence');
  if (!box) return;
  const tog = box.querySelector('#presence-toggle');
  if (tog) tog.onclick = () => {
    presenceMenu.open = !presenceMenu.open;
    if (!presenceMenu.open) presenceMenu.cascade = null;
    renderPresenceWidget(card);
  };
  // Picking a state applies it and cascades its timer under the row it came
  // from; Online has nothing to cascade.
  box.querySelectorAll('[data-presence]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.presence;
    presenceMenu.open = true;
    presenceMenu.cascade = id === 'online' ? null : id;
    choosePresence(id);
  }));
  box.querySelectorAll('[data-presence-ms]').forEach((b) => (b.onclick = () => {
    const raw = b.dataset.presenceMs;
    // The ladder applies the state it belongs to, not whatever the live status
    // happens to be: reading it here sent Online + a timer after the state had
    // lapsed, and setStatus drops the timer for Online picks — the click did
    // nothing at all.
    const state = b.dataset.presenceState || (S.me || {}).status || 'online';
    // `data-presence-ms` is a SPAN ("900000" = 15 minutes) while the setter wants
    // an absolute expiry. Posting the span raw sent an epoch-1970 timestamp, the
    // server answered 400 bad_expiry, and setStatus swallows that — so the state
    // stuck but the timer and its "Until …" note never appeared. Convert here.
    const ms = raw === 'never' ? null : Date.now() + Number(raw);
    // A picked span is the end of the interaction: collapse the menu back to the
    // status readout (the user card itself stays open).
    presenceMenu = { open: false, cascade: null };
    renderPresenceWidget(card);
    choosePresence(state, ms);
  }));
}
// State picks keep whatever timer is already counting; picking Online drops it.
async function choosePresence(s, ms) {
  const cur = (S.me || {}).status || 'online';
  // An idle Away is the one state a re-pick still has to WRITE: tapping "Away"
  // while the idle clock put you there is the user claiming it, and only the
  // server write clears presence_auto. The local clear below is the other half —
  // it stops the clock racing this request and flipping you back to Online in
  // between. Any other re-pick of the state you are already in stays a no-op, and
  // it must: a request there would clear a live timer.
  const claimingIdle = !!(S.me && S.me.presence_auto) && s === cur && !presenceExpiry();
  if (typeof markPresenceManual === 'function') markPresenceManual();
  if (ms === undefined && s === cur && !claimingIdle) { renderPresenceWidget($('#usercard')); return; }
  const exp = ms === undefined ? (presenceExpiry() || null) : ms;
  try { await setStatus(s, s === 'online' ? null : exp); } catch {}
}
function refreshOwnPresence() {
  // Repaint the menu in place (setStatus calls this for every path, the idle
  // auto-away flip included) with its open/cascaded state intact.
  const card = $('#usercard');
  if (!card || card.classList.contains('hidden') || card.dataset.uid !== S.me.id) return;
  renderPresenceWidget(card);
}
function refreshOwnStatusBubble() {
  // Swap just the bubble so the open card never moves, rescales, or loses
  // its scroll position.
  const card = $('#usercard');
  if (!card || card.classList.contains('hidden') || card.dataset.uid !== S.me.id) return;
  const wrap = card.querySelector('.uc-bubble-wrap');
  if (!wrap) return;
  wrap.outerHTML = statusBubbleHTML(S.me);
  wireStatusBubble(card);
}
async function clearMyStatus() {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ statusText: '' }) });
    if (user) { S.me = { ...S.me, ...user }; paintMe(); }
    toast('Status cleared');
    refreshOwnStatusBubble();
  } catch (err) { toast(prettyError(err.message)); }
}
function openStatusEditor() {
  const cur = S.me.status_text || '';
  const curExp = +S.me.status_expires_at || 0;
  const t0 = Date.now();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const presets = [
    { label: 'Never', ts: null },
    { label: '30 min', ts: t0 + 30 * 60e3 },
    { label: '1 hour', ts: t0 + 3600e3 },
    { label: '4 hours', ts: t0 + 4 * 3600e3 },
    { label: 'Tomorrow', ts: midnight.getTime() },
    { label: '1 week', ts: t0 + 7 * 864e5 },
  ];
  let sel = 0;
  if (curExp) {
    let best = -1, bd = Infinity;
    presets.forEach((p, i) => { if (p.ts) { const d = Math.abs(p.ts - curExp); if (d < bd) { bd = d; best = i; } } });
    if (best > 0 && bd < 5 * 60e3) sel = best;
  }
  // A status is escaped plain text, so its picker is held to standard emoji.
  const field = `<input id="m-status-text" maxlength="64" placeholder="What's up?" value="${esc(cur)}" />`;
  openModal('Custom status', `
    <label>Status${emojiFieldHTML(field, { std: true })}</label>
    <div class="uc-sec-label">Clear after</div>
    <select id="m-status-exp" aria-label="Clear custom status after">${presets.map((p, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${p.label}</option>`).join('')}</select>
    ${cur ? '<div class="row" style="margin-top:.7rem"><button type="button" class="btn small danger" id="m-status-clear">Clear status</button></div>' : ''}
  `, 'Save', async () => {
    const text = ((($('#m-status-text') || {}).value) || '').trim().slice(0, 64);
    const ts = presets[sel].ts;
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ statusText: text, statusExpiresAt: text ? ts : null }) });
      if (user) { S.me = { ...S.me, ...user }; paintMe(); }
      toast(text ? 'Status updated' : 'Status cleared');
      refreshOwnStatusBubble();
    } catch (err) { toast(prettyError(err.message)); }
  });
  const mclr = $('#m-status-clear');
  if (mclr) mclr.onclick = async () => { cancelModal(); await clearMyStatus(); };
  const expSel = $('#m-status-exp');
  if (expSel) expSel.onchange = () => { sel = +expSel.value; };
}
// ---------- profile screen (full overlay) ----------
// `fallback` is a user object to use when the account is not in any loaded
// roster (a story author from a server you have since left, for instance).
function openProfileScreen(uid, fallback) {
  const u = memberById(uid) || (fallback && fallback.id === uid ? fallback : null);
  if (!u) return;
  const bd = $('#profile-backdrop');
  // Who this screen is showing, so a live frame (a game starting, a rename) can
  // be matched to it without a second lookup — see refreshProfileGame.
  bd.dataset.uid = uid;
  const isMe = uid === S.me.id;
  const st = statusOf(uid);
  const pstreaming = !isOff(st) && (u.streaming_game || null);
  const stLabel = pstreaming ? 'Streaming' : ({ online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' }[st] || 'Offline');
  $('#pf-banner').style.backgroundImage = u.banner_url ? `url('${esc(u.banner_url)}')` : '';
  paintAvatar($('#pf-avatar'), u);
  $('#pf-name').innerHTML = `<span class="mname" style="${nameStyleFor(u)}">${esc(u.display_name)}</span>${tagHTML(u)}`;
  $('#pf-sub').textContent = '@' + u.username + (u.role === 'owner' ? ' · server owner' : '');
  const body = $('#pf-body');
  let actions = '';
  if (!isMe) {
    if (!isBlocked(uid)) actions += '<button class="btn small primary" id="pf-message">Message</button>' + friendBtnHTML(uid, 'pf-friend');
    actions += `<button class="btn small${isBlocked(uid) ? '' : ' danger'}" id="pf-block">${isBlocked(uid) ? 'Unblock' : 'Block'}</button>`;
  }
  body.innerHTML = `
    ${isSysAdmin(u) || isEarlyUser(u) ? `<div class="pf-badges">${isSysAdmin(u) ? '<span class="sysadmin-badge">System admin</span>' : ''}${isEarlyUser(u) ? '<span class="early-badge">Early user</span>' : ''}</div>` : ''}
    <div class="pf-status"><span class="status-dot ${dotOf(st, pstreaming)}"></span><span>${stLabel}</span>${u.status_text ? `<span class="pf-statustext">${esc(u.status_text)}</span>` : ''}</div>
    ${pstreaming ? `<div class="pf-playing ustream">Streaming ${esc(pstreaming)}</div>` : ''}
    ${u.bio ? `<div class="pf-bio">${renderRich(u.bio)}</div>` : ''}
    ${u.created_at ? `<div class="pf-since">Member since ${fmtJoined(u.created_at)}</div>` : ''}
    <div id="pf-gaming" class="pf-gaming hidden"></div>
    <div class="pf-actions">${actions}<button class="btn small" id="pf-close">Close</button></div>`;
  // The profile picture carries the story affordance (see paintProfileStory).
  try { paintProfileStory(u); } catch {}
  loadUserGaming($('#pf-gaming'), u.username, { canDelete: isMe });
  $('#pf-close').onclick = closeProfileScreen;
  const msg = $('#pf-message');
  if (msg) msg.onclick = () => { closeProfileScreen(); messageUser(uid); };
  const fr = $('#pf-friend');
  if (fr) fr.onclick = () => { closeProfileScreen(); friendCardAction(uid); };
  const blk = $('#pf-block');
  if (blk) blk.onclick = () => {
    const was = isBlocked(uid), nm = u.username;
    closeProfileScreen();
    if (was) unblockUser(uid); else blockUser(uid, nm);
  };
  bd.classList.remove('hidden');
}
function closeProfileScreen() {
  const p = document.querySelector('#profile-backdrop .profile');
  $('#profile-backdrop').classList.add('hidden');
  if (p) { p.style.transform = ''; p.style.transition = ''; p.style.animation = ''; }
}
$('#profile-close').onclick = closeProfileScreen;
$('#profile-backdrop').addEventListener('click', (e) => { if (e.target.id === 'profile-backdrop') closeProfileScreen(); });

// ---------- @mention autocomplete ----------
// Enter/Tab is owned by an open popup: it completes the name, it never sends.
// Registering order matters here — this file loads before final.js, so the
// pop handler runs first and hides the popup while the same keydown event is
// still being dispatched; the send handler (composerSendKey in final.js) would
// then see a hidden popup and submit. Marking the event tells it to stand down.
function popupTookKey(e) { e.cfAutocomplete = true; }
// Both fields complete the same way: the thread bar is the chat bar's own
// version, so @mention / #channel / :emoji all work in either one. Each handler
// is handed the field it is running in.
const COMPOSER_FIELDS = () => ['#in-message', '#in-thread'].map((s) => $(s)).filter(Boolean);
function onComposerInput(fn) { COMPOSER_FIELDS().forEach((inp) => inp.addEventListener('input', () => fn(inp))); }
function onComposerKeydown(fn) { COMPOSER_FIELDS().forEach((inp) => inp.addEventListener('keydown', (e) => fn(e, inp))); }
let mentionIdx = 0;
function hideMentionPop() { $('#mention-pop').classList.add('hidden'); }
onComposerInput((inp) => {
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  // Role names may contain spaces, so the query is "everything since the @".
  const m = upto.match(/@([^@\n]{1,32})$/);
  if (!m) { hideMentionPop(); return; }
  const q = m[1].toLowerCase().trim();
  const server = S.view === 'server' ? S.serverDetail : null;
  const pool = S.view === 'home'
    ? (((S.dms.find((t) => t.id === S.dmThreadId) || {}).members) || [])
    : (S.serverDetail?.members || []);
  const cands = [];
  for (const x of pool) {
    if (x.username.includes(q) || x.display_name.toLowerCase().includes(q)) cands.push({ kind: 'user', insert: x.username, user: x });
  }
  if (server) {
    // Roles are mentionable by anyone; @everyone / @here are the admins' alone,
    // so they are never even offered to anyone else.
    for (const r of (server.roles || [])) {
      if (r.name.trim() && r.name.toLowerCase().startsWith(q)) cands.push({ kind: 'role', insert: r.name, role: r });
    }
    if (canManage()) for (const t of ['everyone', 'here']) if (t.startsWith(q)) cands.push({ kind: 'all', insert: t });
  }
  const list = cands.slice(0, 6);
  if (!list.length) { hideMentionPop(); return; }
  mentionIdx = 0;
  const pop = $('#mention-pop');
  anchorPopToInput(pop, inp);
  pop.innerHTML = '';
  list.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-item' + (i === 0 ? ' sel' : '');
    b.dataset.insert = c.insert;
    if (c.kind === 'user') {
      b.innerHTML = `<span class="avatar"></span><span>${esc(c.user.display_name)}${tagHTML(c.user)} <span class="muted">@${esc(c.user.username)}</span></span>`;
      paintAvatar(b.querySelector('.avatar'), c.user);
    } else if (c.kind === 'role') {
      b.innerHTML = `<span class="rdot"${/^#[0-9a-fA-F]{6}$/.test(c.role.color || '') ? ` style="background:${esc(c.role.color)}"` : ''}></span><span>@${esc(c.role.name)} <span class="mitem-sub">Role</span></span>`;
    } else {
      b.innerHTML = `<span class="chan-glyph">@</span><span>@${c.insert} <span class="mitem-sub">${c.insert === 'everyone' ? 'Notify everyone' : 'Notify online members'}</span></span>`;
    }
    b.onmousedown = (e) => { e.preventDefault(); applyMention(c.insert, inp); };
    pop.appendChild(b);
  });
  pop.classList.remove('hidden');
});
onComposerKeydown((e, inp) => {
  const pop = $('#mention-pop');
  if (pop.classList.contains('hidden')) return;
  const items = [...pop.querySelectorAll('.mention-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('sel', i === mentionIdx));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && items[mentionIdx]) {
    e.preventDefault();
    popupTookKey(e);
    applyMention(items[mentionIdx].dataset.insert, inp);
  } else if (e.key === 'Escape') hideMentionPop();
});
function applyMention(name, inp = $('#in-message')) {
  const pos = inp.selectionStart ?? inp.value.length;
  // A function replacement, so a role name containing `$&`/`$1` stays literal.
  inp.value = inp.value.slice(0, pos).replace(/@[^@\n]{0,32}$/, () => '@' + name + ' ');
  hideMentionPop();
  inp.focus();
  syncRenderFor(inp);
}

// ---------- #channel autocomplete (same UX as @mentions) ----------
// Typing #gen in a server offers matching channels; picking inserts #name,
// which renders as a clickable link (see renderRich in core.js).
let chanIdx = 0;
function hideChanPop() { $('#chan-pop').classList.add('hidden'); }
onComposerInput((inp) => {
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m = upto.match(/#([A-Za-z0-9_-]{0,32})$/);
  const pool = S.view === 'server' ? (S.serverDetail?.channels || []) : [];
  if (!m || !pool.length) { hideChanPop(); return; }
  const q = m[1].toLowerCase();
  const cands = pool.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6);
  if (!cands.length) { hideChanPop(); return; }
  chanIdx = 0;
  const pop = $('#chan-pop');
  anchorPopToInput(pop, inp);
  pop.innerHTML = '';
  cands.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-item' + (i === 0 ? ' sel' : '');
    b.dataset.name = c.name;
    b.innerHTML = `<span class="chan-glyph">${c.type === 'voice' ? '♪' : '#'}</span><span>#${esc(c.name)}</span>`;
    b.onmousedown = (e) => { e.preventDefault(); applyChannel(c.name, inp); };
    pop.appendChild(b);
  });
  pop.classList.remove('hidden');
});
onComposerKeydown((e, inp) => {
  const pop = $('#chan-pop');
  if (pop.classList.contains('hidden')) return;
  const items = [...pop.querySelectorAll('.mention-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    chanIdx = (chanIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('sel', i === chanIdx));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && items[chanIdx]) {
    e.preventDefault();
    popupTookKey(e);
    applyChannel(items[chanIdx].dataset.name, inp);
  } else if (e.key === 'Escape') hideChanPop();
});
function applyChannel(name, inp = $('#in-message')) {
  const pos = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, pos).replace(/#[A-Za-z0-9_-]{0,32}$/, '#' + name + ' ');
  hideChanPop();
  inp.focus();
  syncRenderFor(inp);
}

// ---------- :emoji autocomplete (same UX as @mentions) ----------
// Typing a trailing :name shows matching emoji (custom + standard) to pick
// from with arrow keys / Enter / click; it completes the :name: code.
let emojiIdx = 0;
function hideEmojiPop() { $('#emoji-pop').classList.add('hidden'); }
function emojiCandidates(q) {
  const out = [];
  // custom emoji from every joined server (label shows which server)
  for (const [n, em] of Object.entries(S.emojiAll)) {
    if (!q || n.toLowerCase().includes(q)) {
      out.push({ kind: 'custom', name: n, url: em.url, srv: (S.serverEmojis.find((s) => s.id === em.serverId) || {}).name || '' });
    }
  }
  if (emojiData && emojiData.shortcodes) {
    for (const [n, ch] of Object.entries(emojiData.shortcodes)) {
      if (!q || n.toLowerCase().includes(q)) out.push({ kind: 'std', name: n, ch });
    }
  }
  return out.slice(0, 8);
}
onComposerInput((inp) => {
  const upto = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m = upto.match(/:([a-z0-9_+-]{1,32})$/);
  if (!m) { hideEmojiPop(); return; }
  const q = m[1].toLowerCase();
  const cands = emojiCandidates(q);
  if (!cands.length) { hideEmojiPop(); return; }
  emojiIdx = 0;
  const pop = $('#emoji-pop');
  anchorPopToInput(pop, inp);
  pop.innerHTML = '';
  cands.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-item' + (i === 0 ? ' sel' : '');
    b.dataset.name = c.name;
    b.innerHTML = c.kind === 'custom'
      ? `<img class="ep-img" src="${esc(c.url)}" alt="" data-fb-emoji=":${esc(c.name)}:" /><span class="ep-name">:${esc(c.name)}:</span>${c.srv ? `<span class="ep-srv">${esc(c.srv)}</span>` : ''}`
      : `<span class="ep-char">${esc(c.ch)}</span><span class="ep-name">:${esc(c.name)}:</span>`;
    b.onmousedown = (e) => { e.preventDefault(); applyEmoji(c.name, inp); };
    pop.appendChild(b);
  });
  pop.classList.remove('hidden');
});
onComposerKeydown((e, inp) => {
  const pop = $('#emoji-pop');
  if (pop.classList.contains('hidden')) return;
  const items = [...pop.querySelectorAll('.emoji-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    emojiIdx = (emojiIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('sel', i === emojiIdx));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && items[emojiIdx]) {
    e.preventDefault();
    popupTookKey(e);
    applyEmoji(items[emojiIdx].dataset.name, inp);
  } else if (e.key === 'Escape') hideEmojiPop();
});
function applyEmoji(name, inp = $('#in-message')) {
  const pos = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, pos).replace(/:[a-z0-9_+-]{1,32}$/, ':' + name + ': ');
  hideEmojiPop();
  inp.focus();
  syncRenderFor(inp);
}

