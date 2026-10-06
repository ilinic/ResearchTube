import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inspectChatComposer, installChatComposerGuard, readChatComposerGuard, disposeChatComposerGuard } from '../chat-composer.js';

function pageFixture() {
  const listeners = new Map();
  const root = {
    controls: [], images: [],
    querySelectorAll(selector) { return selector === 'img' ? this.images : this.controls; },
    contains(target) { return target === composer || target?.root === this; }
  };
  const composer = { innerText: '', closest: () => root, contains: () => false };
  const input = { root, files: [], closest: () => root, matches: (selector) => selector === 'input[type="file"]' };
  const historyForm = {};
  const historicalInput = { files: [{ name: 'old-history.pdf', size: 10 }], closest: () => historyForm };
  const historyRemove = { getAttribute: () => 'Remove file' };
  const document = {
    querySelector: () => composer,
    querySelectorAll: (selector) => selector === 'input[type="file"]' ? [input, historicalInput] : [historyRemove],
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }
  };
  const window = {};
  const context = vm.createContext({ document, window, getComputedStyle: (element) => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible' }) });
  const run = (fn, ...args) => vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`, context);
  const event = (type, target, extra = {}) => { for (const listener of listeners.get(type) || []) listener({ type, target, isTrusted: true, ...extra }); };
  const button = (label, fileName, { disabled = false, hidden = false } = {}) => {
    const card = { innerText: fileName, getAttribute: () => '', querySelector: () => null };
    const node = { root, disabled, hidden, parentElement: card,
      getAttribute: (name) => name === 'aria-label' ? label : '',
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 20, height: 20 }),
      closest: (selector) => selector === 'button, [role="button"]' ? node : null };
    root.controls.push(node); return node;
  };
  return { root, composer, input, document, window, listeners, run, event, button, historicalInput };
}
const page = pageFixture();
let snapshot = page.run(inspectChatComposer);
assert.equal(snapshot.found, true);
assert.equal(snapshot.textEmpty, true);
assert.equal(snapshot.attachments.length, 0, 'files in previous messages must not count as Composer attachments');
assert.equal(snapshot.selectedFiles.length, 0);
page.composer.innerText = 'user draft';
page.input.files = [{ name: 'draft.pdf', size: 123, lastModified: 5 }];
page.button('Remove file', 'draft.pdf');
page.button('Remove image', 'photo.png');
page.button('Remove file', 'hidden.pdf', { hidden: true });
page.button('Send', '');
page.button('Delete conversation', '');
snapshot = page.run(inspectChatComposer);
assert.equal(snapshot.textEmpty, false);
assert.deepEqual(JSON.parse(JSON.stringify(snapshot.selectedFiles)), [{ name: 'draft.pdf', size: 123, lastModified: 5 }]);
assert.equal(snapshot.attachments.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(snapshot.removeTargets[0])), { x: 20, y: 30, enabled: true });
page.document.querySelector = () => null;
assert.equal(page.run(inspectChatComposer).found, false);
page.document.querySelector = () => page.composer;

assert.equal(page.run(installChatComposerGuard, ['output.pdf'], 'task-one'), true);
page.input.files = [{ name: 'output.pdf' }];
page.event('change', page.input);
assert.equal(page.run(readChatComposerGuard, 'task-one').changed, false, 'native task file selection is allowed once');
page.event('click', page.button('Send', ''));
page.event('input', { root: {} });
page.event('change', page.historicalInput);
assert.equal(page.run(readChatComposerGuard, 'task-one').changed, false);
page.event('beforeinput', page.composer);
page.composer.innerText = ''; // deleting the text again does not undo the edit signal
assert.equal(page.run(readChatComposerGuard, 'task-one').changed, true);
assert.equal(page.run(readChatComposerGuard, 'another-task').present, false);
page.run(disposeChatComposerGuard, 'task-one');
assert.ok([...page.listeners.values()].every((listeners) => listeners.size === 0));

for (const type of ['change', 'drop', 'paste', 'click']) {
  page.run(installChatComposerGuard, ['output.pdf'], type);
  page.input.files = [{ name: 'output.pdf' }];
  page.event('change', page.input);
  if (type === 'change') {
    page.input.files = [{ name: 'user.pdf' }]; page.event('change', page.input);
  } else if (type === 'drop') page.event('drop', page.composer, { dataTransfer: { files: [{}] } });
  else if (type === 'paste') page.event('paste', page.composer, { clipboardData: { files: [{}] } });
  else page.event('click', page.button('Remove file', 'output.pdf'));
  assert.equal(page.run(readChatComposerGuard, type).changed, true, `user ${type} must stop Send`);
}
// Installing another monitor replaces old handlers rather than accumulating them.
page.run(installChatComposerGuard, ['output.pdf'], 'replacement');
assert.ok([...page.listeners.values()].every((listeners) => listeners.size === 1));
page.run(disposeChatComposerGuard, 'replacement');
assert.ok([...page.listeners.values()].every((listeners) => listeners.size === 0));
// React replacing the draft DOM must not detach the protection from user input.
page.run(installChatComposerGuard, ['output.pdf'], 'react-remount');
const replacement = pageFixture();
page.document.querySelector = () => replacement.composer;
page.event('input', replacement.composer);
assert.equal(page.run(readChatComposerGuard, 'react-remount').changed, true);
page.run(disposeChatComposerGuard, 'react-remount');
console.log('Chat Composer: scoped attachments, text, user editing guard and cleanup passed');
