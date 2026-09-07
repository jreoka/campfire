'use strict';
/* ================= rail drag reorder (flat server list, no folders) ================= */
let dragId = null, dropTarget = null, dropMarker = null;
function showMarker(rect, edge) {
  if (!dropMarker) { dropMarker = document.createElement('div'); dropMarker.id = 'drop-marker'; document.body.appendChild(dropMarker); }
  dropMarker.style.display = 'block';
  dropMarker.style.left = rect.left + 'px';
  dropMarker.style.width = rect.width + 'px';
  dropMarker.style.top = (edge === 'before' ? rect.top - 2 : rect.bottom - 1) + 'px';
}
function hideMarker() { if (dropMarker) dropMarker.style.display = 'none'; }
function detachServer(sid) {
  S.rootOrder = S.rootOrder.filter((id) => id !== sid);
}
function normalizeAndSave() { renderServerList(); saveLayout(); }
let saveLayoutT = null;
function saveLayout() {
  clearTimeout(saveLayoutT);
  saveLayoutT = setTimeout(persistLayout, 400);
}
async function persistLayout() {
  try {
    await api('/api/me/layout', { method: 'PUT', body: JSON.stringify({
      servers: S.servers.map((s) => {
        const i = S.rootOrder.indexOf(s.id);
        return { id: s.id, position: i < 0 ? 999 : i };
      }),
    }) });
  } catch {}
}
function applyDrop(id, t) {
  if (!id || !t || id === t.id) return;
  detachServer(id);
  const idx = S.rootOrder.indexOf(t.id);
  S.rootOrder.splice(idx < 0 ? S.rootOrder.length : idx + (t.edge === 'after' ? 1 : 0), 0, id);
  normalizeAndSave();
}
function wireDrag(el, id) {
  el.addEventListener('dragstart', (e) => {
    dragId = id;
    try { e.dataTransfer.setData('text/plain', 'server:' + id); } catch {}
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const edge = (e.clientY - r.top) / r.height < 0.5 ? 'before' : 'after';
    showMarker(r, edge);
    dropTarget = { id, edge };
  });
  el.addEventListener('dragleave', () => { hideMarker(); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const dd = dragId; dragId = null; hideMarker();
    if (dd) applyDrop(dd, dropTarget);
    dropTarget = null;
  });
  el.addEventListener('dragend', () => { dragId = null; dropTarget = null; hideMarker(); });
}
// The whole rail is a drop surface (not just the buttons): gaps above the
// first item, below the last, and around the spacer snap to the nearest
// button edge instead of swallowing drops silently.
$('#rail').addEventListener('dragover', (e) => {
  if (!dragId) return;
  if (e.target.closest && e.target.closest('[data-drag]')) return; // button handlers own direct hovers
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const btns = [...document.querySelectorAll('#server-list [data-drag]')];
  let best = null, bestDist = Infinity, bestEdge = 'after';
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    if (!r.height) continue;
    const mid = r.top + r.height / 2;
    const d = Math.abs(e.clientY - mid);
    if (d < bestDist) { bestDist = d; best = b; bestEdge = e.clientY < mid ? 'before' : 'after'; }
  }
  if (!best) { hideMarker(); dropTarget = null; return; }
  dropTarget = { id: best.dataset.drag.split(':')[1], edge: bestEdge };
  showMarker(best.getBoundingClientRect(), bestEdge);
});
$('#rail').addEventListener('dragleave', (e) => {
  try { if (!e.relatedTarget || !document.querySelector('#rail').contains(e.relatedTarget)) hideMarker(); } catch {}
});
$('#rail').addEventListener('drop', (e) => {
  if (!dragId || (e.target.closest && e.target.closest('[data-drag]'))) return;
  e.preventDefault();
  const dd = dragId, t = dropTarget;
  dragId = null; dropTarget = null; hideMarker();
  if (dd && t) { applyDrop(dd, t); return; } // gap drop with a snapped target
  if (!dd) return;
  detachServer(dd); S.rootOrder.push(dd);
  normalizeAndSave();
});
