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
  if (t.zone === 'leave-folder') { if (kind === 'server') removeServerFromFolder(id); return; }
  if (t.zone === 'reorder') { if (kind === 'server') reorderRootServer(id, t.id, t.edge); else if (kind === 'folder') reorderFolder(id, t.id, t.edge); return; }
  if (t.zone === 'reorder-in-folder') { if (kind === 'server') reorderServerInFolder(id, t.folderId, t.id, t.edge); return; }
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
/* ---- folder pop-out drag (leave folder / reorder inside) ---- */
function wirePopoutDrop(list, fid) {
  list.addEventListener('dragover', (e) => {
    if (!dragPayload || dragPayload.kind !== 'server') return;
    const sb = e.target.closest && e.target.closest('[data-drag]');
    if (!sb) { clearDropMarks(); hideMarker(); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = sb.getBoundingClientRect();
    const frac = (e.clientY - r.top) / r.height;
    clearDropMarks(); hideMarker();
    const sid = sb.dataset.drag.split(':')[1];
    if (dragPayload.id !== sid && serverFolder(dragPayload.id) === fid && frac >= 0.3 && frac <= 0.7) dropTarget = { zone: 'reorder-in-folder', folderId: fid, id: sid, edge: 'after' };
    else { const edge = frac < 0.5 ? 'before' : 'after'; showMarker(r, edge); dropTarget = { zone: 'reorder-in-folder', folderId: fid, id: sid, edge }; }
  });
  list.addEventListener('dragleave', () => hideMarker());
  list.addEventListener('drop', (e) => {
    const sb = e.target.closest && e.target.closest('[data-drag]');
    if (!dragPayload || !sb) return;
    e.preventDefault();
    const dd = dragPayload; dragPayload = null; clearDropMarks(); hideMarker();
    applyDrop(dd, dropTarget); dropTarget = null;
  });
}
/* ---- drag a server out of the popout: drop anywhere outside = leave folder ---- */
document.addEventListener('dragover', (e) => {
  if (!dragPayload || dragPayload.kind !== 'server' || !document.querySelector('#folder-popout')) return;
  const rail = document.querySelector('#rail');
  if (rail && rail.contains(e.target)) return;
  if (e.target.closest && e.target.closest('#folder-popout')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dropTarget = { zone: 'leave-folder', id: dragPayload.id };
});
document.addEventListener('drop', (e) => {
  if (!dragPayload || dragPayload.kind !== 'server' || !document.querySelector('#folder-popout')) return;
  const rail = document.querySelector('#rail');
  if (rail && rail.contains(e.target)) return;
  if (e.target.closest && e.target.closest('#folder-popout')) return;
  e.preventDefault();
  const dd = dragPayload; dragPayload = null; hideMarker();
  applyDrop(dd, dropTarget); dropTarget = null;
});
/* ---- folder context flyout ---- */
const FOLDER_COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
function closeFolderFlyout() { if (folderFlyoutEl) { folderFlyoutEl.remove(); folderFlyoutEl = null; } }
function openFolderMenu(fid, x, y) {
  closeFolderFlyout();
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
  const del = document.createElement('button');
  del.className = 'fm-item danger';
  del.textContent = 'Delete folder';
  del.addEventListener('click', () => { deleteFolder(fid); });
  m.appendChild(del);
  document.body.appendChild(m);
  m.style.visibility = 'hidden';
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
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

