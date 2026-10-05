// Story chooser: drag-and-drop + paste upload.
//
// The "Upload a photo or video" row in the Add-to-story chooser opens a file
// picker, but a file can also be dropped onto the chooser dialog or pasted
// from the clipboard while it is open. Everything funnels through
// storyUploadFile, the same intake the picker uses.
//
// The listeners are placed to run BEFORE the chat's global handlers:
//   - drop: attached to #story-new itself, so it fires on the way up before
//     the document-level chat drop handler; stopPropagation keeps a story
//     drop from also landing in the chat composer.
//   - paste: document-level in the CAPTURE phase, so it runs before the
//     chat's bubble-phase paste listener; stopPropagation keeps the image
//     out of the chat composer.
(function () {
  'use strict';

  function storyNewMenuOpen() {
    const el = document.getElementById('story-new');
    return !!el && !el.classList.contains('hidden');
  }

  function storyUploadFile(file) {
    const o = (typeof snOpts !== 'undefined' && snOpts) || {};
    if (!file) return;
    if (!/^(image|video)\//.test(file.type || '')) { toast('Pick a photo or a video'); return; }
    closeStoryNewMenu();
    openStoryComposer(Object.assign({}, o, { file: file }));
  }

  // Same "is this an external file drag" check the chat uses (an in-app drag
  // must never count as a file drop).
  function snHasFiles(e) {
    if (typeof dragHasFiles === 'function') return dragHasFiles(e);
    const types = (e.dataTransfer && e.dataTransfer.types) || [];
    return Array.prototype.indexOf.call(types, 'Files') !== -1;
  }

  const menu = document.getElementById('story-new');
  const card = menu && menu.querySelector('.sn-card');
  if (menu && card) {
    menu.addEventListener('dragenter', (e) => {
      if (!storyNewMenuOpen() || !snHasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      card.classList.add('sn-dropping');
    });
    menu.addEventListener('dragover', (e) => {
      if (!storyNewMenuOpen() || !snHasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    menu.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && menu.contains(e.relatedTarget)) return;
      card.classList.remove('sn-dropping');
    });
    menu.addEventListener('drop', (e) => {
      if (!storyNewMenuOpen() || !snHasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      card.classList.remove('sn-dropping');
      const files = (e.dataTransfer && e.dataTransfer.files) ? Array.from(e.dataTransfer.files) : [];
      if (files.length) storyUploadFile(files[0]);
    });
  }

  document.addEventListener('paste', (e) => {
    if (!storyNewMenuOpen()) return;
    const cd = e.clipboardData;
    const files = cd && cd.files ? Array.from(cd.files) : [];
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    storyUploadFile(files[0]);
  }, true);
})();
