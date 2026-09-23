#!/usr/bin/env node
// Offline checks for the document-level Enter-to-send (final.js): Enter posts
// a staged message even when the composer input isn't focused.
// [1] stagedSendTarget() routes to the composer that actually has staged files.
// [2] globalEnterSendAllowed() only hijacks Enter when nothing else owns it.
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label); }
}

const finalJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'final.js'), 'utf8');

// Extract a top-level `function name(...)` body by brace counting — robust
// against the inner try/catch blocks that defeat non-greedy regexes.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(open + 1, i); }
  }
  return null;
}

const targetBody = extractFn(finalJs, 'stagedSendTarget');
const allowedBody = extractFn(finalJs, 'globalEnterSendAllowed');
check(!!targetBody, 'final.js defines stagedSendTarget()');
check(!!allowedBody, 'final.js defines globalEnterSendAllowed()');
// The document listener consults both — a wiring change that drops one fails.
check(finalJs.includes('globalEnterSendAllowed(e)') && finalJs.includes('stagedSendTarget()'),
  'the document keydown listener consults both functions');

// Drive the REAL functions against stubs: a refactor that changes what they
// compute (rather than deleting them) fails here too.
const stagedSendTarget = new Function('S', 'threadAtts',
  'function stagedSendTarget(){' + targetBody + '}\nreturn stagedSendTarget;');
const globalEnterSendAllowed = new Function('cfVisible', 'CF_BACK_LAYERS',
  'function globalEnterSendAllowed(e){' + allowedBody + '}\nreturn globalEnterSendAllowed;');

console.log('\n[1] stagedSendTarget routes to the composer holding staged files');
{
  const T = (S, threadAtts) => stagedSendTarget(S, threadAtts)();
  check(T({ thread: { rootId: 'r1' }, pendingAtts: [{}, {}] }, () => [{}, {}]) === 'thread-composer',
    'a thread with staged files wins over the chat bar');
  check(T({ thread: { rootId: 'r1' }, pendingAtts: [{}] }, () => []) === 'composer',
    'a thread with nothing staged falls through to the chat bar');
  check(T({ thread: null, pendingAtts: [{}] }, () => []) === 'composer',
    'staged chat attachments route to the chat composer');
  check(T({ thread: null, pendingAtts: [] }, () => []) === null,
    'nothing staged routes nowhere');
  check(T(undefined, () => []) === null,
    'an undefined S (logged-out view) routes nowhere');
  check(T({ thread: { rootId: 'r1' }, pendingAtts: [{}] }, () => { throw new Error('boom'); }) === 'composer',
    'a throwing threadAtts does not wedge the chat-bar fallback');
}

console.log('\n[2] globalEnterSendAllowed only hijacks Enter when nothing else owns it');
// A stub focused element: closest() answers from the element kind.
function elStub(kind) {
  return {
    closest: (sel) => {
      const parts = sel.split(',').map((s) => s.trim().toLowerCase());
      if (kind === 'INPUT' && parts.includes('input')) return {};
      if (kind === 'TEXTAREA' && parts.includes('textarea')) return {};
      if (kind === 'BUTTON' && (parts.includes('button') || parts.includes('[role="button"]'))) return {};
      if (kind === 'A' && parts.includes('a')) return {};
      if (kind === 'EDITABLE' && parts.some((p) => p.includes('contenteditable'))) return {};
      return null;
    },
  };
}
function keyEvent(key, opts = {}) {
  return {
    key,
    shiftKey: !!opts.shiftKey,
    isComposing: !!opts.isComposing,
    defaultPrevented: !!opts.defaultPrevented,
    cfAutocomplete: !!opts.cfAutocomplete,
    target: elStub(opts.kind || 'BODY'),
  };
}
const layersStub = (openNames) => [
  { name: 'lightbox', open: () => openNames.includes('lightbox') },
  { name: 'modal', open: () => openNames.includes('modal') },
  { name: 'thread', open: () => openNames.includes('thread') },
  // A broken layer predicate must never wedge the check (cfBack's own rule).
  { name: 'broken', open: () => { throw new Error('boom'); } },
];
const A = (e, pops = [], layers = []) =>
  globalEnterSendAllowed(
    (pop) => pops.includes(pop),
    layersStub(layers))(e);

{
  check(A(keyEvent('Enter')) === true, 'Enter on the page body is hijacked');
  check(A(keyEvent('a')) === false, 'other keys are ignored');
  check(A(keyEvent('Enter', { shiftKey: true })) === false, 'Shift+Enter is ignored');
  check(A(keyEvent('Enter', { isComposing: true })) === false, 'IME composition is ignored');
  check(A(keyEvent('Enter', { defaultPrevented: true })) === false,
    'an Enter the input handler already consumed (preventDefaulted) is ignored — no double send');
  check(A(keyEvent('Enter', { cfAutocomplete: true })) === false, 'autocomplete-owned Enter is ignored');
  for (const kind of ['INPUT', 'TEXTAREA', 'BUTTON', 'A', 'EDITABLE']) {
    check(A(keyEvent('Enter', { kind })) === false, `a focused ${kind} keeps its own Enter`);
  }
  check(A(keyEvent('Enter'), ['#mention-pop']) === false, 'an open mention popup keeps Enter');
  check(A(keyEvent('Enter'), ['#emoji-pop']) === false, 'an open emoji popup keeps Enter');
  check(A(keyEvent('Enter'), [], ['lightbox']) === false, 'an open lightbox keeps Enter');
  check(A(keyEvent('Enter'), [], ['modal']) === false, 'an open dialog keeps Enter');
  check(A(keyEvent('Enter'), [], ['thread']) === true, 'an open thread panel does not block it');
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
