// Story upload dialog: drag & drop / paste / browse.
//
// The create-story chooser's "Upload a photo or video" row opens this dialog
// instead of going straight to the file picker. A file dropped on the drop
// zone, pasted while the dialog is open, or picked through Browse all funnel
// through storyUploadFile into the story composer. Closing the dialog without
// a file returns to the chooser.
//
// The listeners are placed to run BEFORE the chat's global handlers:
//   - drop: attached to the dialog itself, so it fires on the way up before
//     the document-level chat drop handler; stopPropagation keeps a story
//     drop from also landing in the chat composer.
//   - paste: document-level in the CAPTURE phase, so it runs before the
//     chat's bubble-phase paste listener; stopPropagation keeps the image
//     out of the chat composer.
(function () {
  'use strict';

  var suOpts = null;

  function storyUploadOpen() {
    var el = document.getElementById('story-upload');
    return !!el && !el.classList.contains('hidden');
  }

  function openStoryUpload(opts) {
    var el = document.getElementById('story-upload');
    if (!el) return;
    suOpts = opts || {};
    el.classList.remove('hidden');
    var z = document.getElementById('su-drop');
    if (z && z.focus) { try { z.focus(); } catch (e) {} }
  }

  function closeStoryUpload(reopenMenu) {
    var el = document.getElementById('story-upload');
    if (el) el.classList.add('hidden');
    var o = suOpts;
    suOpts = null;
    // Cancelling lands back in the chooser, where the reader was.
    if (reopenMenu && typeof openStoryNewMenu === 'function') openStoryNewMenu(o || {});
  }

  function storyUploadFile(file) {
    if (!file) return;
    if (!/^(image|video)\//.test(file.type || '')) { toast('Pick a photo or a video'); return; }
    var o = suOpts || {};
    closeStoryUpload(false);
    openStoryComposer(Object.assign({}, o, { file: file }));
  }

  // Same "is this an external file drag" check the chat uses (an in-app drag
  // must never count as a file drop).
  function suHasFiles(e) {
    if (typeof dragHasFiles === 'function') return dragHasFiles(e);
    var types = (e.dataTransfer && e.dataTransfer.types) || [];
    return Array.prototype.indexOf.call(types, 'Files') !== -1;
  }

  // Take over the chooser's upload row: open the dialog instead of the
  // picker. (stories.js owns the row's original onclick; assigning it here
  // replaces it because this script loads after.)
  var uploadRow = document.getElementById('sn-upload');
  if (uploadRow) {
    uploadRow.onclick = function () {
      var o = (typeof snOpts !== 'undefined' && snOpts) || {};
      if (typeof closeStoryNewMenu === 'function') closeStoryNewMenu();
      openStoryUpload(o);
    };
  }

  var dlg = document.getElementById('story-upload');
  var zone = document.getElementById('su-drop');
  var fileInput = document.getElementById('su-file');
  var closeBtn = document.getElementById('su-close');

  if (dlg) {
    // Backdrop click closes back to the chooser.
    dlg.addEventListener('click', function (e) { if (e.target === dlg) closeStoryUpload(true); });
  }
  if (closeBtn) closeBtn.onclick = function () { closeStoryUpload(true); };

  if (zone) {
    // The whole drop zone is also the browse button.
    zone.addEventListener('click', function () { if (fileInput) fileInput.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (fileInput) fileInput.click(); }
    });
    zone.addEventListener('dragenter', function (e) {
      if (!storyUploadOpen() || !suHasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      zone.classList.add('su-dropping');
    });
    zone.addEventListener('dragover', function (e) {
      if (!storyUploadOpen() || !suHasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', function (e) {
      if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
      zone.classList.remove('su-dropping');
    });
    zone.addEventListener('drop', function (e) {
      if (!storyUploadOpen() || !suHasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('su-dropping');
      var files = (e.dataTransfer && e.dataTransfer.files) ? Array.from(e.dataTransfer.files) : [];
      if (files.length) storyUploadFile(files[0]);
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      storyUploadFile(file);
    });
  }

  document.addEventListener('paste', function (e) {
    if (!storyUploadOpen()) return;
    var cd = e.clipboardData;
    var files = cd && cd.files ? Array.from(cd.files) : [];
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    storyUploadFile(files[0]);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && storyUploadOpen()) { e.preventDefault(); closeStoryUpload(true); }
  });
})();
