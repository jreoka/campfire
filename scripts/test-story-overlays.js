// Story markup (text / emoji stickers / freehand drawing) — the parts of the
// feature that must not drift.
//
// The overlay list is the single source of truth for the composer preview, the
// story viewer and the view-once player, and it travels through untrusted JSON
// (the post body, a WS push, a DM open). It also has to survive a hard payload
// budget: the post body is JSON and the server caps it, so the model has to
// trim itself before a post 413s.
//
// This runs the REAL ovSanitize/ovParse/ovContentRect out of
// public/js/story-edit.js and the real storyDestDims/storyDrawFrame out of
// public/js/stories.js, offline. The framing math gets a recording canvas so
// the crop/zoom transform is checked as numbers, not pixels: the shot must be
// the rectangle the preview showed (cover + zoom + pan).
//
// Usage: node scripts/test-story-overlays.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(cond, name, detail) {
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail) : detail;
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name + (d ? ' — ' + d : '')); console.log('  FAIL ' + name + (d ? ' — ' + d : '')); }
}

// ---------- the model, straight out of story-edit.js ----------
const editSrc = fs.readFileSync(path.join(ROOT, 'public/js/story-edit.js'), 'utf8');
const mStart = editSrc.indexOf('const OV_MAX');
const mEnd = editSrc.indexOf('/* ---------- rendering ---------- */');
if (mStart < 0 || mEnd < 0) {
  console.error('[test] could not find the overlay model in public/js/story-edit.js');
  process.exit(1);
}
const editApi = eval(editSrc.slice(mStart, mEnd) + '\n;({ OV_MAX, OV_TEXT_MAX, OV_POINTS_MAX, OV_POINTS_TOTAL, OV_JSON_MAX, ovNum, ovColor, ovSanitize, ovTrimToBudget, ovParse, ovSerialize, ovIsEmpty, ovContentRect })');
const { OV_MAX, OV_TEXT_MAX, OV_JSON_MAX, ovSanitize, ovParse, ovSerialize, ovIsEmpty, ovContentRect } = editApi;

// ---------- the framing math, straight out of stories.js ----------
const storySrc = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
const fStart = storySrc.indexOf('function storyDestDims(');
const fEnd = storySrc.indexOf('function paintScCam()');
if (fStart < 0 || fEnd < 0) {
  console.error('[test] could not find storyDestDims/storyDrawFrame in public/js/stories.js');
  process.exit(1);
}
// storyDrawFrame reads the composer's live framing state; stand it up here.
global.sc = { zoom: 1, ox: 0, oy: 0 };
const frameApi = eval(storySrc.slice(fStart, fEnd) + '\n;({ storyDestDims, storyDrawFrame })');
const { storyDestDims, storyDrawFrame } = frameApi;

console.log('\n[1] the model rejects junk and clamps everything else');
{
  const out = ovSanitize([
    null, 42, 'nope', {},
    { t: 'text' },                                  // empty text: dropped
    { t: 'text', text: '   ' },                      // whitespace only: dropped
    { t: 'text', text: 'hi', x: 9, y: -9, r: 720, s: 99, color: 'red; background:url(x)' },
    { t: 'emoji', e: '🔥', x: 0.25, y: 0.75, s: 2, r: 45 },
    { t: 'draw', p: [[0.1, 0.1], [0.2, 0.2]], color: '#00ff00', w: 0.01 },
    { t: 'draw', p: [[0.1, 0.1]], color: 'javascript:alert(1)' },  // 1 point is still a dot
  ]);
  check(out.length === 4, 'only well-formed items survive', out);
  const text = out[0];
  check(text.t === 'text' && text.text === 'hi', 'text item kept', text);
  check(text.x <= 1.5 && text.y >= -0.5, 'coordinates are clamped to the box', text);
  check(text.r >= -360 && text.r <= 360, 'rotation is clamped', text);
  check(text.s <= 12, 'scale is clamped', text);
  check(text.color === '#ffffff', 'a colour that is not a hex triplet falls back to white', text);
  check(out[1].t === 'emoji' && out[1].e === '🔥', 'emoji kept', out[1]);
  check(out[2].t === 'draw' && out[2].color === '#00ff00', 'stroke kept with its colour', out[2]);
  check(out[3].t === 'draw' && out[3].color === '#ffffff', 'a bad stroke colour falls back to white', out[3]);
}
{
  const long = 'x'.repeat(500);
  const out = ovSanitize([{ t: 'text', text: long }]);
  check(out[0].text.length === OV_TEXT_MAX, 'text is capped', out[0].text.length);
  const many = ovSanitize(Array.from({ length: 200 }, (_, i) => ({ t: 'emoji', e: '😀', x: i / 200 })));
  check(many.length === OV_MAX, 'item count is capped', many.length);
}
console.log('\n[2] drawing is the cheap-to-lose part of a hard payload budget');
{
  const big = [];
  for (let s = 0; s < 12; s++) {
    big.push({ t: 'draw', color: '#ffffff', w: 0.01, p: Array.from({ length: 300 }, (_, i) => [i / 300, (i % 7) / 7]) });
  }
  const withText = [{ t: 'text', text: 'read me', x: 0.5, y: 0.2 }].concat(big);
  const out = ovSanitize(withText);
  const bytes = JSON.stringify(out).length;
  check(bytes <= OV_JSON_MAX, 'the list fits the post body budget', bytes + ' <= ' + OV_JSON_MAX);
  check(out.length && out[0].t === 'text' && out[0].text === 'read me', 'the text survives the trim', out[0]);
  check(out.filter((o) => o.t === 'draw').length < 12, 'strokes are what got dropped', out.filter((o) => o.t === 'draw').length);
  const per = ovSanitize([{ t: 'draw', p: Array.from({ length: 5000 }, (_, i) => [i / 5000, 0]) }]);
  check(per[0].p.length <= 300, 'a single stroke is point-capped', per[0].p.length);
  check(per[0].p.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), 'points are numbers', per[0].p.slice(0, 3));
}
console.log('\n[3] round-trips (a post body, a WS push, a DM open all send JSON)');
{
  const list = [{ t: 'text', text: 'hey', x: 0.2, y: 0.3, r: 12, s: 1.5, color: '#ff4d6d', bg: 'pill' }, { t: 'emoji', e: '🔥', x: 0.5, y: 0.5, r: 0, s: 1 }];
  const json = ovSerialize(list);
  const back = ovParse(json);
  check(back.length === 2, 'parse(serialize(x)) keeps every item', back);
  check(back[0].bg === 'pill' && back[0].color === '#ff4d6d' && back[0].s === 1.5, 'text fields survive the round trip', back[0]);
  check(ovParse(json).length === ovParse(JSON.parse(json)).length, 'a string and an array parse the same', null);
  check(ovSerialize([]) === '', 'an empty list serialises to nothing', ovSerialize([]));
  check(ovIsEmpty([]) && ovIsEmpty(null) && !ovIsEmpty(list), 'isEmpty is honest', null);
  check(ovParse('{not json').length === 0, 'broken JSON is an empty list, never a throw', null);
  check(ovParse(null).length === 0 && ovParse(undefined).length === 0, 'missing markup is an empty list', null);
  check(ovParse([{ t: 'text', text: 'x' }]).length === 1, 'a live array is accepted', null);
}
console.log('\n[4] overlays are anchored to the picture, not to the screen');
{
  // A 200x100 photo in a 100x100 box: object-fit:contain paints 100x50 centred,
  // and that is the rectangle the overlay coordinates are normalised to.
  const el = {
    naturalWidth: 200, naturalHeight: 100,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 100 }),
  };
  const r = ovContentRect(el);
  check(Math.abs(r.width - 100) < 1e-6 && Math.abs(r.height - 50) < 1e-6, 'contain letterboxes to the media aspect', r);
  check(Math.abs(r.left - 10) < 1e-6 && Math.abs(r.top - 45) < 1e-6, 'and centres inside the box', r);
  // A media element that is already the right shape fills its box exactly.
  const square = { naturalWidth: 100, naturalHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300 }) };
  const s = ovContentRect(square);
  check(s.width === 300 && s.height === 300 && s.left === 0 && s.top === 0, 'a matching aspect fills the box', s);
  // No decoded bytes yet (a hidden <img>, a video before metadata): the box.
  const empty = { naturalWidth: 0, naturalHeight: 0, getBoundingClientRect: () => ({ left: 5, top: 6, width: 40, height: 80 }) };
  const e = ovContentRect(empty);
  check(e.width === 40 && e.height === 80, 'no intrinsic size falls back to the element box', e);
  check(ovContentRect(null) === null, 'no element is null, not a throw', null);
}
console.log('\n[5] the shot is the rectangle the preview showed');
{
  // Portrait stage 360x640, landscape camera 1280x720: cover crops the sides.
  const dim = storyDestDims({ clientWidth: 360, clientHeight: 640 }, 1280);
  check(dim.h === 1280 && dim.w === 720, 'the capture matches the stage aspect at the long-edge cap', dim);
  const stage = { clientWidth: 360, clientHeight: 640 };
  const vid = { videoWidth: 1280, videoHeight: 720 };
  const calls = [];
  const ctx = { drawImage: (...a) => calls.push(a) };
  global.sc = { zoom: 1, ox: 0, oy: 0 };
  check(storyDrawFrame(ctx, vid, dim.w, dim.h, stage) === true, 'a frame with pixels draws', null);
  const [, dx, dy, dw, dh] = calls[0];
  check(dw / dh > 1, 'the sensor frame keeps its landscape aspect', { dw, dh });
  check(dw >= dim.w - 0.5 && dh >= dim.h - 0.5, 'and covers the whole shot (no black bars)', { dw, dh, dim });
  check(Math.abs((dx + dw / 2) - dim.w / 2) < 1 && Math.abs((dy + dh / 2) - dim.h / 2) < 1, 'centred at rest', { dx, dy });
  // Cover at zoom 1 shows the mid 56% of the sensor (720/1280); doubling the
  // zoom must show half of that, still centred.
  calls.length = 0;
  global.sc = { zoom: 2, ox: 0, oy: 0 };
  storyDrawFrame(ctx, vid, dim.w, dim.h, stage);
  const [, dx2, , dw2] = calls[0];
  check(Math.abs(dw2 - dw * 2) < 0.5, 'zoom 2 doubles the drawn width', { dw, dw2 });
  // Panning moves the crop exactly like the preview's translate(ox) does: the
  // same offset, scaled into capture pixels.
  calls.length = 0;
  global.sc = { zoom: 2, ox: -40, oy: 0 };
  storyDrawFrame(ctx, vid, dim.w, dim.h, stage);
  const [, dx3] = calls[0];
  const k = dim.w / stage.clientWidth;
  check(Math.abs(dx3 - (dx2 + -40 * k)) < 0.5, 'the pan is carried into the crop', { dx3, expected: dx2 + -40 * k });
  check(storyDrawFrame(ctx, { videoWidth: 0, videoHeight: 0 }, 10, 10, stage) === false, 'a camera with no frame draws nothing', null);
  global.sc = { zoom: 1, ox: 0, oy: 0 };
}
console.log('\n[6] the surfaces and the wiring are all present');
{
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');
  check(html.includes('id="sc-ov"'), 'the composer has an overlay layer', null);
  check(html.includes('id="sv-ov"'), 'the story viewer has one', null);
  check(html.includes('id="vo-ov"'), 'and the view-once player has one', null);
  check(html.includes('id="sc-textedit"') && html.includes('id="sc-te-input"'), 'the text tool has its editor', null);
  check(html.includes('id="sc-emoji-grid"'), 'the emoji tool has its grid', null);
  check(html.includes('id="sc-colors"') && html.includes('id="sc-tool-draw"'), 'and drawing has colours + a pen', null);
  check(html.includes('id="sc-textonly"'), 'a text-only story can be started without the camera', null);
  check(!html.includes('data-smode'), 'the old photo/video mode toggle is gone (tap vs hold replaced it)', null);
  check(/story-edit\.js"><\/script>\s*<script src="\/js\/stories\.js"/.test(html), 'story-edit.js loads before stories.js', null);
  check(sw.includes("'/js/story-edit.js'"), 'the new module is in the app-shell cache', null);
  check(/campfire-v\d+/.test(sw) && sw.includes('campfire-v416'), 'the service worker cache was bumped', null);
  for (const rule of ['.ov-layer', '.ov-item', '.ov-draw', '.sc-tools', '.ov-editable', '.ov-pill', '.ov-sel']) {
    check(css.includes(rule), 'stylesheet has ' + rule, null);
  }
  check(/ov-layer[^}]*--ov-h/.test(css.replace(/\n/g, ' ')) || css.includes('.ov-layer{'), 'the layer owns the sizing vars items read', null);
  const js = fs.readFileSync(path.join(ROOT, 'public/js/stories.js'), 'utf8');
  for (const fn of ['storyShutterDown', 'storyShutterUp', 'storyDrawFrame', 'storyNeedsComposite', 'storyRecordStream', 'storyPaintOv', 'storyOpenTextEditor', 'storyAddSticker', 'storyStartTextOnly', 'svPaintOverlays']) {
    check(js.includes('function ' + fn + '('), 'stories.js defines ' + fn, null);
  }
  const vo = fs.readFileSync(path.join(ROOT, 'public/js/viewonce.js'), 'utf8');
  check(vo.includes('function voPaintOverlays('), 'view-once paints overlays too', null);
  // Removing the media must not take the overlay layer's custom emoji with it.
  check(vo.includes(':scope > img, :scope > video'), 'the view-once teardown only removes direct media children', null);
  check(!js.includes("querySelectorAll('.sc-mode')"), 'no leftover mode-mode wiring', null);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
