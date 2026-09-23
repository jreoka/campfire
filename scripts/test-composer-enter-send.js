#!/usr/bin/env node
// Offline checks for the document-level Enter-to-send (final.js): Enter posts
// a staged message even when the composer input isn't focused.
// [1] enterSendTarget() routes to the composer that has something to send:
// staged attachments of any type, or typed-but-unposted text.
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

const targetBody = extractFn(finalJs, 'enterSendTarget');
const allowedBody = extractFn(finalJs, 'globalEnterSendAllowed');
check(!!targetBody, 'final.js defines enterSendTarget()');
check(!!allowedBody, 'final.js defines globalEnterSendAllowed()');
// The document listener consults both — a wiring change that drops one fails.
check(finalJs.includes('globalEnterSendAllowed(e)') && finalJs.includes('enterSendTarget()'),
  'the document keydown listener consults both functions');

// Drive the REAL functions against stubs: a refactor that changes what they
// compute (rather than deleting them) fails here too.
const enterSendTargetFactory = new Function('S', 'threadAtts', 'document',
  'function enterSendTarget(){' + targetBody + '}\nreturn enterSendTarget;');
const globalEnterSendAllowed = new Function('cfVisible', 'CF_BACK_LAYERS',
  'function globalEnterSendAllowed(e){' + allowedBody + '}\nreturn globalEnterSendAllowed;');

console.log('\n[1] enterSendTarget routes to the composer holding something to send');
{
  const docStub = (msgVal, threadVal) => ({
    getElementById: (id) => {
      if (id === 'in-message') return msgVal === null ? null : { value: msgVal };
      if (id === 'in-thread') return threadVal === null ? null : { value: threadVal };
      return null;
    },
  });
  const T = (S, threadAtts, msgVal = '', threadVal = '') =>
    enterSendTargetFactory(S, threadAtts, docStub(msgVal, threadVal))();
  const noThread = () => [];
  check(T({ thread: { rootId: 'r1' }, pendingAtts: [{}, {}] }, () => [{}]) === 'thread-composer',
    'a thread with staged files wins over the chat bar');
  check(T({ thread: { rootId: 'r1' }, pendingAtts: [{}] }, noThread) === 'composer',
    'a thread with nothing staged or typed falls through to the chat bar');
  check(T({ thread: { rootId: 'r1' }, pendingAtts: [] }, noThread, '', 'typed reply') === 'thread-composer',
    'typed-but-unposted thread text routes to the thread composer');
  check(T({ thread: null, pendingAtts: [{}] }, noThread) === 'composer',
    'staged chat attachments route to the chat composer');
  check(T({ thread: null, pendingAtts: [] }, noThread, 'typed message') === 'composer',
    'typed-but-unposted chat text routes to the chat composer');
  check(T({ thread: null, pendingAtts: [] }, noThread, '   \n  ') === null,
    'whitespace-only text counts as nothing to send');
  check(T({ thread: null, pendingAtts: [] }, noThread) === null,
    'nothing staged and nothing typed routes nowhere');
  check(T(undefined, noThread) === null,
    'an undefined S (logged-out view) routes nowhere');
  check(T({ thread: { rootId: 'r1' }, pendingAtts: [{}] }, () => { throw new Error('boom'); }, 'hi') === 'composer',
    'a throwing threadAtts does not wedge the chat-bar fallback');
  check(T({ thread: null, pendingAtts: [{}] }, noThread, null) === 'composer',
    'staged attachments route even when the input element is absent');
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
