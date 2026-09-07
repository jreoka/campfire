'use strict';
/* ================= rail folders + drag reorder ================= */
let dragPayload = null, dropTarget = null, dropMarker = null, folderMenuEl = null;
function showMarker(rect, edge) {
  if (!dropMarker) { dropMarker = document.createElement('div'); dropMarker.id = 'drop-marker'; document.body.appendChild(dropMarker); }
  dropMarker.style.display = 'block';
  dropMarker.style.left = rect.left + 'px';
  dropMarker.style.width = rect.width + 'px';
  dropMarker.style.top = (edge === 'before' ? rect.top - 2 : rect.bottom - 1) + 'px';
}
function hideMarker() { if (dropMarker) dropMarker.style.display = 'none'; }
function clearDropMarks() { document.querySelectorAll('.drop-combine').forEach((el) => el.classList.remove('drop-combine')); }
function detachServer(sid) {
  S.rootOrder = S.rootOrder.filter((it) => !(it.kind === 'server' && it.id === sid));
  for (const f of S.layoutFolders) f.servers = (f.servers || []).filter((id) => id !== sid);
}
function containerOf(sid) {
  for (const f of S.layoutFolders) {
    const i = (f.servers || []).indexOf(sid);
    if (i >= 0) return { type: 'folder', f, index: i };
  }
  return { type: 'root', index: S.rootOrder.findIndex((it) => it.kind === 'server' && it.id === sid) };
}
function normalizeAndSave() { renderServerList(); saveLayout(); }
let saveLayoutT = null;
function saveLayout() {
  clearTimeout(saveLayoutT);
  saveLayoutT = setTimeout(persistLayout, 400);
}
async function persistLayout() {
  const folders = [];
  S.rootOrder.forEach((it, i) => { if (it.kind === 'folder') { const f = folderById(it.id); if (f) folders.push(f); } });
  for (const f of S.layoutFolders) if (!folders.includes(f)) folders.push(f);
  const pos = new Map();
  S.rootOrder.forEach((it, i) => { if (it.kind === 'server') pos.set(it.id, { folderId: null, position: i }); });
  folders.forEach((f) => {
    // Folders hold servers only: strip stale ids (and folder ids most of
    // all) before persisting, so nesting can never be saved.
    f.servers = (f.servers || []).filter((sid) => S.servers.some((s) => s.id === sid));
    f.servers.forEach((sid, i) => pos.set(sid, { folderId: f.id, position: i }));
  });
  try {
    await api('/api/me/layout', { method: 'PUT', body: JSON.stringify({
      folders: folders.map((f) => ({
        id: f.id, name: f.name, color: f.color, open: !!f.open,
        position: Math.max(0, S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === f.id)),
      })),
      servers: S.servers.map((s) => ({ id: s.id, ...(pos.get(s.id) || { folderId: null, position: 999 }) })),
    }) });
  } catch {}
}
function applyDrop(dd, t) {
  if (!dd || !t) return;
  // No nested folders, ever: a dragged folder can only reorder at root, so a
  // folder-on-folder drop lands after the target instead of inside it.
  if (dd.kind === 'folder' && t.zone === 'folder') t = { zone: 'after-folder', id: t.id };
  if (dd.kind === 'server') {
    if (t.zone === 'folder') {
      const f = folderById(t.id);
      if (!f) return;
      detachServer(dd.id);
      if (!f.servers.includes(dd.id)) f.servers.push(dd.id);
      f.open = true;
    } else if (t.zone === 'before-folder' || t.zone === 'after-folder') {
      // Gap drop beside a whole folder: land at root next to it (this is
      // how servers leave an open folder without aiming at a thin line).
      const fi = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === t.id);
      if (fi < 0) return;
      detachServer(dd.id);
      S.rootOrder.splice(fi + (t.zone === 'after-folder' ? 1 : 0), 0, { kind: 'server', id: dd.id });
    } else if (t.zone === 'combine') {
      if (dd.id === t.id) return;
      detachServer(dd.id);
      const tc = containerOf(t.id);
      if (tc.index < 0 && tc.type === 'root') return;
      const nf = { id: (crypto.randomUUID ? crypto.randomUUID() : 'f' + Date.now()), name: 'New folder', color: '#5865f2', open: true, servers: [], position: 0 };
      if (tc.type === 'root') S.rootOrder.splice(tc.index, 0, { kind: 'folder', id: nf.id });
      else {
        const fi = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === tc.f.id);
        S.rootOrder.splice(fi < 0 ? S.rootOrder.length : fi + 1, 0, { kind: 'folder', id: nf.id });
      }
      S.layoutFolders.push(nf);
      detachServer(t.id);
      nf.servers.push(t.id, dd.id);
      normalizeAndSave();
      renameFolder(nf.id);
      return;
    } else {
      const c = containerOf(t.id);
      if (c.type === 'folder') {
        detachServer(dd.id);
        const cc = containerOf(t.id);
        cc.f.servers.splice(cc.index + (t.zone === 'after' ? 1 : 0), 0, dd.id);
      } else {
        if (c.index < 0) return;
        detachServer(dd.id);
        const nc = containerOf(t.id);
        S.rootOrder.splice(nc.index + (t.zone === 'after' ? 1 : 0), 0, { kind: 'server', id: dd.id });
      }
    }
  } else {
    const from = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === dd.id);
    if (from < 0) return;
    let idx;
    if (t.zone === 'before-folder' || t.zone === 'after-folder') {
      idx = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === t.id);
      if (idx < 0) return;
      idx += t.zone === 'after-folder' ? 1 : 0;
    } else {
      const c = containerOf(t.id);
      idx = (c.type === 'root' ? c.index : S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === c.f.id)) + (t.zone === 'after' ? 1 : 0);
    }
    const [mv] = S.rootOrder.splice(from, 1);
    if (from < idx) idx--;
    S.rootOrder.splice(idx, 0, mv);
  }
  normalizeAndSave();
}
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
    const y = (e.clientY - r.top) / r.height;
    clearDropMarks(); hideMarker();
    if (kind === 'folder' && dragPayload.kind === 'server') {
      el.classList.add('drop-combine');
      dropTarget = { zone: 'folder', id };
    } else if (kind === 'server' && dragPayload.kind === 'server' && dragPayload.id !== id && y >= 0.3 && y <= 0.7) {
      el.classList.add('drop-combine');
      dropTarget = { zone: 'combine', id };
    } else if (kind === 'folder') {
      const edge = y < 0.5 ? 'before' : 'after';
      showMarker(r, edge);
      dropTarget = { zone: edge + '-folder', id };
    } else {
      const edge = y < 0.5 ? 'before' : 'after';
      showMarker(r, edge);
      dropTarget = { zone: edge, id };
    }
  });
  el.addEventListener('dragleave', (e) => {
    // Moving between buttons/gaps inside the rail just hands the marker to
    // the next target — only clear when actually leaving the rail.
    try {
      if (e.relatedTarget && document.querySelector('#server-list')?.contains(e.relatedTarget)) return;
    } catch {}
    el.classList.remove('drop-combine'); hideMarker();
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const dd = dragPayload;
    clearDropMarks(); hideMarker();
    dragPayload = null;
    if (dd) applyDrop(dd, dropTarget);
    dropTarget = null;
  });
  el.addEventListener('dragend', () => { dragPayload = null; dropTarget = null; clearDropMarks(); hideMarker(); });
}
// The whole rail is a drop surface (not just the list): rail gaps above the
// first item, below the last, and around the spacer would otherwise swallow
// drops silently. Gaps between top-level items mean root; gaps inside an
// open folder's box mean that folder.
$('#rail').addEventListener('dragover', (e) => {
  if (!dragPayload) return;
  if (e.target.closest && e.target.closest('[data-drag]')) return; // button handlers own direct hovers
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  // Inside an open folder's box? Nearest child decides (stays in folder) —
  // except the tinted padding strips above the first / below the last child:
  // when dragging one of that folder's own servers those strips eject to
  // root, so leaving never needs pixel-perfect aim. Anywhere else outside
  // boxes? Nearest top-level unit decides (root level).
  const box = e.target.closest ? e.target.closest('.folder-children') : null;
  let cands = [];
  let boxExit = null; // {fid} when the strips mean "leave this folder"
  if (box) {
    const kids = [...box.querySelectorAll('[data-drag]')];
    const wrap = box.closest('.folder-wrap');
    const fid = wrap ? (wrap.querySelector('[data-fid]') || {}).dataset?.fid : null;
    const ownKid = fid && dragPayload.kind === 'server' && (() => { const c = containerOf(dragPayload.id); return c.type === 'folder' && c.f.id === fid; })();
    if (ownKid && kids.length) {
      const first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
      if (e.clientY < first.top) boxExit = { fid, edge: 'before' };
      else if (e.clientY > last.bottom) boxExit = { fid, edge: 'after' };
    }
    if (!boxExit) cands = kids.map((el) => ({ el, fid: null }));
  } else {
    for (const child of document.querySelectorAll('#server-list > *')) {
      if (child.dataset && child.dataset.drag) {
        cands.push({ el: child, fid: null });
      } else if (child.classList && child.classList.contains('folder-wrap')) {
        const fb = child.querySelector('[data-fid]');
        if (fb) cands.push({ el: child, fid: fb.dataset.fid });
      }
    }
  }
  let best = null, bestDist = Infinity, bestEdge = 'after';
  for (const c of cands) {
    const r = c.el.getBoundingClientRect();
    if (!r.height) continue;
    const mid = r.top + r.height / 2;
    const d = Math.abs(e.clientY - mid);
    if (d < bestDist) { bestDist = d; best = c; bestEdge = e.clientY < mid ? 'before' : 'after'; }
  }
  if (boxExit) {
    const wrap = box.closest('.folder-wrap');
    dropTarget = { zone: boxExit.edge + '-folder', id: boxExit.fid };
    if (wrap) showMarker(wrap.getBoundingClientRect(), boxExit.edge);
    return;
  }
  if (!best) { hideMarker(); dropTarget = null; return; }
  if (best.fid) {
    dropTarget = { zone: bestEdge + '-folder', id: best.fid };
  } else {
    dropTarget = { zone: bestEdge, id: best.el.dataset.drag.split(':')[1] };
  }
  showMarker(best.el.getBoundingClientRect(), bestEdge);
});
$('#rail').addEventListener('drop', (e) => {
  if (!dragPayload || (e.target.closest && e.target.closest('[data-drag]'))) return;
  e.preventDefault();
  const dd = dragPayload, t = dropTarget;
  dragPayload = null; dropTarget = null; hideMarker(); clearDropMarks();
  if (dd && t) { applyDrop(dd, t); return; } // gap drop with a snapped target
  if (!dd) return;
  if (dd.kind === 'server') { detachServer(dd.id); S.rootOrder.push({ kind: 'server', id: dd.id }); }
  else {
    const from = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === dd.id);
    if (from >= 0) { const [mv] = S.rootOrder.splice(from, 1); S.rootOrder.push(mv); }
  }
  normalizeAndSave();
});
function closeFolderMenu() { if (folderMenuEl) { folderMenuEl.remove(); folderMenuEl = null; } }
async function renameFolder(fid) {
  const f = folderById(fid);
  if (!f) return;
  const n = await openPromptModal({ title: 'Rename folder', label: 'Folder name', initial: f.name, placeholder: 'e.g. Favorites', okLabel: 'Save', maxlength: 32 });
  if (n === null) return;
  f.name = n.trim().slice(0, 32) || 'Folder';
  saveLayout(); renderServerList();
}
const FOLDER_COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
function openFolderMenu(fid, x, y) {
  closeFolderMenu();
  const f = folderById(fid);
  if (!f) return;
  const m = document.createElement('div');
  m.id = 'folder-menu';
  m.innerHTML = `<button class="fm-item" data-fact="rename">Rename</button><div class="swatches"></div><button class="fm-item" data-fact="toggle">${f.open ? 'Collapse' : 'Expand'}</button><button class="fm-item danger" data-fact="delete">Delete folder</button>`;
  const sw = m.querySelector('.swatches');
  for (const c of FOLDER_COLORS) {
    const d = document.createElement('div');
    d.className = 'sw' + (f.color === c ? ' sel' : '');
    d.style.background = c;
    d.onclick = () => { f.color = c; saveLayout(); renderServerList(); closeFolderMenu(); };
    sw.appendChild(d);
  }
  m.querySelector('[data-fact="rename"]').onclick = () => { closeFolderMenu(); renameFolder(fid); };
  m.querySelector('[data-fact="toggle"]').onclick = () => { f.open = !f.open; saveLayout(); renderServerList(); closeFolderMenu(); };
  m.querySelector('[data-fact="delete"]').onclick = () => {
    closeFolderMenu();
    const fi = S.rootOrder.findIndex((it) => it.kind === 'folder' && it.id === fid);
    const kids = [...(f.servers || [])];
    S.rootOrder = S.rootOrder.filter((it) => !(it.kind === 'folder' && it.id === fid));
    kids.forEach((sid, i) => S.rootOrder.splice(fi + i, 0, { kind: 'server', id: sid }));
    S.layoutFolders = S.layoutFolders.filter((x) => x.id !== fid);
    saveLayout(); renderServerList();
  };
  document.body.appendChild(m);
  m.style.left = Math.min(x, innerWidth - 210) + 'px';
  m.style.top = Math.min(y, innerHeight - 230) + 'px';
  folderMenuEl = m;
}

