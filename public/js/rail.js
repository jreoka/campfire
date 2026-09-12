'use strict';
/* ================= rail: folders + drag reorder (Discord-style) ================= */
let dragPayload = null, dropTarget = null, dropMarker = null, folderFlyoutEl = null;
function showMarker(rect, edge) {
  if (!dropMarker) { dropMarker = document.createElement('div'); dropMarker.id = 'drop-marker'; document.body.appendChild(dropMarker); }
  dropMarker.style.display = 'block';
  dropMarker.style.left = rect.left + 'px';
  dropMarker.style.width = rect.width + 'px';
  dropMarker.style.top = (edge === 'before' ? rect.top - 2 : rect.bottom - 1) + 'px';
}
function hideMarker() { if (dropMarker) dropMarker.style.display = 'none'; }
function clearDropMarks() { document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target')); }
function normalizeAndSave() { renderServerList(); saveLayout(); }
let saveLayoutT = null;
function saveLayout() { clearTimeout(saveLayoutT); saveLayoutT = setTimeout(persistLayout, 400); }
async function persistLayout() {
  // Recompute global scalar positions: folders + unfiled servers in rootOrder,
  // then each folder's servers. Positions drive reload ordering.
  let p = 0;
  for (const it of S.rootOrder) {
    const f = it.kind === 'folder' ? folderById(it.id) : null;
    if (f) {
      f.position = p++; f.open = 1;
      for (const sid of (f.servers || [])) S.serverMeta.set(sid, { folderId: f.id, position: p++ });
    } else {
      S.serverMeta.set(it.id, { folderId: null, position: p++ });
    }
  }
  try {
    await api('/api/me/layout', { method: 'PUT', body: JSON.stringify({
      folders: S.layoutFolders.map((f) => ({ id: f.id, name: f.name, color: f.color, position: f.position ?? 0, open: 1 })),
      servers: S.servers.map((s) => ({ id: s.id, ...(S.serverMeta.get(s.id) || { folderId: null, position: 999 }) })),
    }) });
  } catch {}
}
/* ---- container helpers ---- */
function serverFolder(sid) { return S.layoutFolders.find((f) => (f.servers || []).includes(sid)); }
function rootIndex(id) { return S.rootOrder.findIndex((it) => it.id === id); }
function removeServerEverywhere(sid) {
  const f = serverFolder(sid);
  if (f) f.servers = (f.servers || []).filter((x) => x !== sid);
  S.rootOrder = S.rootOrder.filter((it) => !(it.kind === 'server' && it.id === sid));
}
function createFolderFromServers(ids) {
  const fid = (crypto.randomUUID ? crypto.randomUUID() : 'f' + Date.now());
  const firstIdx = Math.min(...ids.map(rootIndex).filter((i) => i >= 0));
  const nf = { id: fid, name: 'New Folder', color: '#5865f2', open: 1, position: 0, servers: [] };
  for (const sid of ids) { removeServerEverywhere(sid); nf.servers.push(sid); S.serverMeta.set(sid, { folderId: fid, position: 0 }); }
  S.layoutFolders.push(nf);
  const at = firstIdx < 0 ? S.rootOrder.length : firstIdx;
  S.rootOrder.splice(at, 0, { kind: 'folder', id: fid });
  S.openFolderId = fid;
  normalizeAndSave();
}
function moveServerToFolder(sid, fid) {
  const f = folderById(fid); if (!f) return;
  if (serverFolder(sid) === f) return;
  removeServerEverywhere(sid);
  (f.servers || (f.servers = [])).push(sid);
  S.serverMeta.set(sid, { folderId: fid, position: 0 });
  S.openFolderId = fid;
  normalizeAndSave();
}
function removeServerFromFolder(sid) {
  const f = serverFolder(sid); if (!f) return;
  f.servers = (f.servers || []).filter((x) => x !== sid);
  const after = rootIndex(f.id);
  S.rootOrder.splice(after + 1, 0, { kind: 'server', id: sid });
  S.serverMeta.set(sid, { folderId: null, position: 999 });
  normalizeAndSave();
}
function reorderRootServer(sid, targetId, edge) {
  const f = serverFolder(sid);
  if (f) f.servers = (f.servers || []).filter((x) => x !== sid);
  S.rootOrder = S.rootOrder.filter((it) => !(it.kind === 'server' && it.id === sid));
  const ti = rootIndex(targetId);
  S.rootOrder.splice(ti < 0 ? S.rootOrder.length : ti + (edge === 'after' ? 1 : 0), 0, { kind: 'server', id: sid });
  S.serverMeta.set(sid, { folderId: null, position: 999 });
  normalizeAndSave();
}
function reorderFolder(fid, targetId, edge) {
  const from = rootIndex(fid); if (from < 0) return;
  const [mv] = S.rootOrder.splice(from, 1);
  let ti = rootIndex(targetId); if (ti < 0) { S.rootOrder.splice(Math.min(from, S.rootOrder.length), 0, mv); return; }
  S.rootOrder.splice(ti < 0 ? S.rootOrder.length : ti + (edge === 'after' ? 1 : 0), 0, mv);
  normalizeAndSave();
}
function reorderServerInFolder(sid, folderId, targetId, edge) {
  const f = folderById(folderId); if (!f) return;
  const arr = f.servers || (f.servers = []);
  const from = arr.indexOf(sid); if (from < 0) return;
  arr.splice(from, 1);
  let ti = arr.indexOf(targetId);
  arr.splice(ti < 0 ? arr.length : ti + (edge === 'after' ? 1 : 0), 0, sid);
  normalizeAndSave();
}
function applyDrop(dd, t) {
  if (!dd || !t) return;
  const { kind, id } = dd;
  if (t.zone === 'combine') { if (kind === 'server' && id !== t.id) createFolderFromServers([id, t.id]); return; }
  if (t.zone === 'into-folder') { if (kind === 'server') moveServerToFolder(id, t.folderId); return; }
  if (t.zone === 'reorder') { if (kind === 'server') reorderRootServer(id, t.id, t.edge); else if (kind === 'folder') reorderFolder(id, t.id, t.edge); return; }
  if (t.zone === 'reorder-in-folder') { if (kind === 'server') reorderServerInFolder(id, t.folderId, t.id, t.edge); return; }
}
/* ---- menu-driven moves (touch: native drag is off, so the server/folder
   menus expose the same reorder explicitly) ---- */
function moveRootEntry(kind, id, dir) {
  const i = S.rootOrder.findIndex((it) => it.kind === kind && it.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.rootOrder.length) { toast(dir < 0 ? 'Already at the top' : 'Already at the bottom'); return; }
  const [mv] = S.rootOrder.splice(i, 1);
  S.rootOrder.splice(j, 0, mv);
  normalizeAndSave();
}
function moveServerRail(sid, dir) {
  const f = serverFolder(sid);
  if (f) {
    const arr = f.servers || [];
    const i = arr.indexOf(sid), j = i + dir;
    if (i < 0) return;
    if (j < 0 || j >= arr.length) { toast(dir < 0 ? 'Already at the top of the folder' : 'Already at the bottom of the folder'); return; }
    arr.splice(i, 1);
    arr.splice(j, 0, sid);
    normalizeAndSave();
    return;
  }
  moveRootEntry('server', sid, dir);
}
function moveFolderRail(fid, dir) { moveRootEntry('folder', fid, dir); }
function serverMoveItems(sid) {
  return [
    { label: 'Move up', icon: '↑', fn: () => moveServerRail(sid, -1) },
    { label: 'Move down', icon: '↓', fn: () => moveServerRail(sid, 1) },
  ];
}
function folderMoveOrderItems(fid) {
  return [
    { label: 'Move folder up', icon: '↑', fn: () => moveFolderRail(fid, -1) },
    { label: 'Move folder down', icon: '↓', fn: () => moveFolderRail(fid, 1) },
  ];
}
/* ---- draggable elements ---- */
function wireDrag(el, kind, id) {
  el.addEventListener('dragstart', (e) => {
    dragPayload = { kind, id };
    try { e.dataTransfer.setData('text/plain', kind + ':' + id); } catch {}
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const frac = (e.clientY - r.top) / r.height;
    clearDropMarks(); hideMarker();
    if (kind === 'folder') {
      if (dragPayload.kind === 'server') { el.classList.add('drop-target'); dropTarget = { zone: 'into-folder', folderId: id }; }
      else { const edge = frac < 0.5 ? 'before' : 'after'; showMarker(r, edge); dropTarget = { zone: 'reorder', id, edge }; }
    } else {
      if (dragPayload.kind === 'server' && dragPayload.id !== id && frac >= 0.3 && frac <= 0.7) { el.classList.add('drop-target'); dropTarget = { zone: 'combine', id }; }
      else { const edge = frac < 0.5 ? 'before' : 'after'; showMarker(r, edge); dropTarget = { zone: 'reorder', id, edge }; }
    }
  });
  el.addEventListener('dragleave', (e) => {
    try { if (e.relatedTarget && el.contains(e.relatedTarget)) return; } catch {}
    el.classList.remove('drop-target'); hideMarker();
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const dd = dragPayload; dragPayload = null; clearDropMarks(); hideMarker();
    if (dd) applyDrop(dd, dropTarget);
    dropTarget = null;
  });
  el.addEventListener('dragend', () => { dragPayload = null; dropTarget = null; clearDropMarks(); hideMarker(); });
}
/* ---- rail gap drops: snap to nearest button ---- */
function nearestDrop(e) {
  const cands = [];
  for (const child of document.querySelectorAll('#server-list > *')) {
    const el = child.dataset && child.dataset.drag ? child : child.querySelector('[data-drag]');
    if (!el) continue;
    const r = el.getBoundingClientRect(); if (!r.height) continue;
    cands.push({ el, r });
  }
  let best = null, bestDist = Infinity, bestEdge = 'after';
  for (const c of cands) {
    const mid = c.r.top + c.r.height / 2;
    const d = Math.abs(e.clientY - mid);
    if (d < bestDist) { bestDist = d; best = c; bestEdge = e.clientY < mid ? 'before' : 'after'; }
  }
  if (!best) return null;
  const dk = (best.el.dataset.drag || 'server:').split(':');
  return { zone: 'reorder', kind: dk[0], id: dk[1], edge: bestEdge };
}
$('#rail').addEventListener('dragover', (e) => {
  if (!dragPayload) return;
  if (e.target.closest && e.target.closest('[data-drag]')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  const t = nearestDrop(e);
  if (!t) { hideMarker(); dropTarget = null; return; }
  dropTarget = t;
  const r = (t.kind === 'folder' ? document.querySelector('[data-drag="folder:' + t.id + '"]') : document.querySelector('[data-drag="server:' + t.id + '"]'));
  if (r) showMarker(r.getBoundingClientRect(), t.edge);
});
$('#rail').addEventListener('dragleave', (e) => {
  try { if (e.relatedTarget && document.querySelector('#rail').contains(e.relatedTarget)) return; } catch {}
  hideMarker();
});
$('#rail').addEventListener('drop', (e) => {
  if (!dragPayload || (e.target.closest && e.target.closest('[data-drag]'))) return;
  e.preventDefault();
  const dd = dragPayload, t = dropTarget;
  dragPayload = null; dropTarget = null; hideMarker();
  if (dd && t) { applyDrop(dd, t); return; }
  if (!dd) return;
  if (dd.kind === 'server') { removeServerEverywhere(dd.id); S.rootOrder.push({ kind: 'server', id: dd.id }); S.serverMeta.set(dd.id, { folderId: null, position: 999 }); }
  else if (dd.kind === 'folder') { return; }
  normalizeAndSave();
});
/* ---- folder open (inline) drop: reorder inside / add to folder ---- */
function wireFolderOpenDrop(box, fid) {
  box.addEventListener('dragover', (e) => {
    if (!dragPayload || dragPayload.kind !== 'server') return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    hideMarker();
    const sb = e.target.closest && e.target.closest('[data-drag]');
    if (sb) {
      const hs = sb.dataset.drag.split(':')[1];
      if (dragPayload.id === hs) return;
      const r = sb.getBoundingClientRect();
      const frac = (e.clientY - r.top) / r.height;
      if (serverFolder(dragPayload.id) === fid) {
        const edge = frac < 0.5 ? 'before' : 'after';
        showMarker(r, edge);
        dropTarget = { zone: 'reorder-in-folder', folderId: fid, id: hs, edge };
      } else {
        box.classList.add('drop-target');
        dropTarget = { zone: 'into-folder', folderId: fid };
      }
    } else {
      box.classList.add('drop-target');
      dropTarget = { zone: 'into-folder', folderId: fid };
    }
  });
  box.addEventListener('dragleave', () => { box.classList.remove('drop-target'); hideMarker(); });
  box.addEventListener('drop', (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    const dd = dragPayload; dragPayload = null; clearDropMarks(); hideMarker();
    applyDrop(dd, dropTarget); dropTarget = null;
  });
}
/* ---- folder context flyout ---- */
const FOLDER_COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
function closeFolderFlyout() { if (folderFlyoutEl) { folderFlyoutEl.remove(); folderFlyoutEl = null; } }
function openFolderMenu(fid, x, y) {
  // Touch devices never get the desktop flyout — the bottom sheet carries
  // the same actions (plus color) and is the only menu that opens.
  if (typeof isCoarse === 'function' && isCoarse()) {
    // The hold-timer sheet is already up in the normal long-press flow —
    // don't rebuild it (would restart the slide-up animation).
    if (document.querySelector('#sheet')) return;
    try { openFolderSheet(fid); } catch {} return;
  }
  closeFolderFlyout();
  try { if (typeof closeCtxSheet === 'function') closeCtxSheet(); } catch {}
  try { if (typeof closeCtx === 'function') closeCtx(); } catch {}
  const f = folderById(fid); if (!f) return;
  const m = document.createElement('div');
  m.id = 'folder-menu';
  const nameBtn = document.createElement('button');
  nameBtn.className = 'fm-name';
  nameBtn.innerHTML = '<span class="fm-n"></span><span class="fm-edit">✎</span>';
  nameBtn.querySelector('.fm-n').textContent = f.name || 'Folder';
  nameBtn.title = 'Rename';
  nameBtn.addEventListener('click', () => { closeFolderFlyout(); renameFolder(fid); });
  m.appendChild(nameBtn);
  const sw = document.createElement('div');
  sw.className = 'fm-swatches';
  for (const c of FOLDER_COLORS) {
    const d = document.createElement('button');
    d.className = 'fm-sw' + (f.color === c ? ' sel' : '');
    d.style.background = c; d.title = c;
    d.addEventListener('click', () => { f.color = c; saveLayout(); renderServerList(); closeFolderFlyout(); });
    sw.appendChild(d);
  }
  m.appendChild(sw);
  const expand = document.createElement('button');
  expand.className = 'fm-item';
  expand.textContent = S.openFolderId === f.id ? 'Collapse folder' : 'Expand folder';
  expand.addEventListener('click', () => { toggleFolder(f.id); closeFolderFlyout(); });
  m.appendChild(expand);
  // Same action the folder's touch sheet carries (see folderSheetItems); only
  // offered while there is something to clear.
  if (typeof folderUnreadCount === 'function' && folderUnreadCount(f)) {
    const mr = document.createElement('button');
    mr.className = 'fm-item';
    mr.textContent = 'Mark all as read';
    mr.addEventListener('click', () => { closeFolderFlyout(); markFolderRead(f.id); });
    m.appendChild(mr);
  }
  for (const mv of folderMoveOrderItems(fid)) {
    const b = document.createElement('button');
    b.className = 'fm-item';
    b.textContent = mv.label;
    b.addEventListener('click', () => { closeFolderFlyout(); mv.fn && mv.fn(); });
    m.appendChild(b);
  }
  const del = document.createElement('button');
  del.className = 'fm-item danger';
  del.textContent = 'Delete folder';
  del.addEventListener('click', () => { closeFolderFlyout(); deleteFolder(fid); });
  m.appendChild(del);
  document.body.appendChild(m);
  m.style.visibility = 'hidden';
  const b = popupBox(m); // offsetWidth/Height: the entry animation scales the rect
  m.style.left = Math.max(8, Math.min(x, innerWidth - b.w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - b.h - 8)) + 'px';
  m.style.visibility = '';
  folderFlyoutEl = m;
}
async function renameFolder(fid, initial) {
  const f = folderById(fid); if (!f) return;
  const v = await openPromptModal({ title: 'Rename folder', label: 'Folder name', initial: initial || f.name, placeholder: 'e.g. Games', okLabel: 'Save', maxlength: 32 });
  if (v === null) return;
  f.name = v.trim().slice(0, 32) || 'Folder';
  normalizeAndSave();
}
function deleteFolder(fid) {
  const f = folderById(fid); if (!f) return;
  const kids = [...(f.servers || [])];
  const at = rootIndex(fid);
  openModal('Delete folder?', `<p class="muted">"${esc(f.name || 'Folder')}" and its servers will move back to the rail.</p>`, 'Delete', () => {
    S.layoutFolders = S.layoutFolders.filter((x) => x.id !== fid);
    S.rootOrder = S.rootOrder.filter((it) => !(it.kind === 'folder' && it.id === fid));
    kids.forEach((sid, i) => { S.rootOrder.splice(at + i, 0, { kind: 'server', id: sid }); S.serverMeta.set(sid, { folderId: null, position: 999 }); });
    if (S.openFolderId === fid) S.openFolderId = null;
    normalizeAndSave();
  });
}

