import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { pageFixture } from './fixtures/chat-composer-page.mjs';
import { inspectChatComposer } from '../chat-composer.js';

const bundle = await readFile(new URL('../dist/background.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function worker() {
  let now = Date.parse('2026-10-06T10:00:00Z'), timerId = 0, onAlarm;
  const storage = {}, alarms = new Map(), timers = new Map(), debuggers = new Set(), commands = [], sends = [];
  const tabs = new Map([42, 81].map(id => [id, { id, url: `https://chatgpt.com/c/test-${id}` }]));
  const pages = new Map([...tabs.keys()].map(id => {
    const page = pageFixture();
    page.document.readyState = 'complete';
    page.sendButton = { disabled: false, getAttribute: () => '', getBoundingClientRect: () => ({ left: 200, top: 100, width: 20, height: 20 }) };
    page.root.querySelector = selector => selector === 'button[type="submit"]' ? page.sendButton : null;
    return [id, page];
  }));
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ URL, Intl, TextEncoder, TextDecoder, AbortController, crypto: webcrypto, Date: Clock,
    console: { info() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, deadline: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: {
      runtime: { id: 'extension', getURL: path => path, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
      alarms: { onAlarm: { addListener(fn) { onAlarm = fn; } }, create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name) },
      tabs: { query: async () => [...tabs.values()], get: async id => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); } },
      storage: { local: { get: async () => clone(storage), set: async value => Object.assign(storage, clone(value)) } }
    }
  });
  vm.runInContext(bundle, context);
  context.configuredToolLimits = async () => ({ mediaToChatMaxFiles: 10 });
  context.refreshTaskHistorySettings = async () => {};
  context.reportMcpToolToAgent = async () => {};
  context.cdpLog = () => {}; context.cdpErrorLog = () => {};
  context.sleep = async ms => { now += ms; };
  context.resolveLibraryStoreFiles = async files => ({ localPaths: files.map(file => `/private/${file.workspacePath}`), submittedFiles: files, skippedFiles: [] });
  context.cdpAttach = async id => { assert.ok(!debuggers.has(id), 'debugger lifecycles must be serialized'); debuggers.add(id); };
  context.cdpDetach = async id => debuggers.delete(id);
  context.cdpEvaluate = async (id, expression) => {
    if (!tabs.has(id)) throw new Error('closed');
    return { value: vm.runInContext(expression, pages.get(id).context) };
  };
  context.cdpWaitForTextComposer = async () => {};
  context.cdpOpenStableFileChooser = async () => ({ backendNodeId: 7 });
  let commandHook = async () => {};
  context.cdpCommand = async (id, method, params) => {
    commands.push({ id, method, params });
    await commandHook(id, method, params);
    const page = pages.get(id);
    if (method === 'DOM.setFileInputFiles') {
      page.input.files = params.files.map(path => ({ name: path.split('/').pop(), size: 1, lastModified: 1 }));
      for (const file of page.input.files) page.button(`Remove ${file.name}`, file.name, { markedCard: true });
      page.event('change', page.input);
      page.input.files = [];
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      sends.push({ id, at: now });
      page.root.cards = []; page.root.controls = [];
    }
    return {};
  };
  const start = async (delay, tabId = 42) => {
    const args = { files: [{ workspacePath: 'report.pdf' }] };
    if (delay !== undefined) args.sendDelaySeconds = delay;
    const { task } = await context.mediaToChatStart(args);
    vm.runInContext('mediaToChatDraining = true', context);
    await context.bindMediaToChatTarget(context.mediaToChatWidgetMetadata(task.taskId), { id: 'extension', tab: tabs.get(tabId) });
    vm.runInContext('mediaToChatDraining = false', context);
    await context.drainMediaToChatQueue();
    return context.mediaToChatStatus(task.taskId);
  };
  return { context, pages, tabs, storage, alarms, timers, debuggers, commands, sends, start,
    advance(ms) { now += ms; }, now: () => now,
    hook(fn) { commandHook = fn; },
    fireAlarm(taskId) { onAlarm({ name: `media-chat-send:${taskId}` }); }
  };
}

const defaults = worker();
const tool = defaults.context.publicMcpTools().find(tool => tool.name === 'media_to_chat');
assert.equal(tool.inputSchema.properties.sendDelaySeconds.default, 0);
assert.ok(!tool.inputSchema.required.includes('sendDelaySeconds'));
assert.ok(tool.outputSchema.properties.task.properties.phase.enum.includes('waitingToSend'));
for (const value of [-1, '20', null, true, NaN, Infinity, 1e20]) {
  await assert.rejects(defaults.context.mediaToChatStart({ files: [{ workspacePath: 'report.pdf' }], sendDelaySeconds: value }), /sendDelaySeconds/);
}
const immediate = await defaults.start();
assert.equal(immediate.sendDelaySeconds, 0);
assert.equal(immediate.status, 'completed');
assert.equal(immediate.sendNotBefore, null);
assert.equal(immediate.remainingSeconds, null);
assert.equal(defaults.sends.length, 1);
assert.equal((await defaults.context.mediaToChatCancel(immediate.taskId)).cancelled, false);

const delayed = worker();
const waiting = await delayed.start(600);
assert.equal(waiting.phase, 'waitingToSend');
assert.equal(waiting.progressPercent, 70);
assert.equal(waiting.remainingSeconds, 600);
assert.equal(Date.parse(waiting.sendNotBefore), delayed.now() + 600_000);
assert.equal(delayed.sends.length, 0);
assert.equal(delayed.debuggers.size, 0, 'pause must detach CDP');
assert.equal(delayed.timers.size, 0, 'a ten-minute pause must use an alarm, not hold an in-worker timer');
assert.deepEqual(clone(delayed.pages.get(42).run(inspectChatComposer).attachments.map(card => card.name)), ['report.pdf']);
delayed.advance(599_000);
await delayed.context.resumeDelayedMediaToChatTask(waiting.taskId); // early/duplicate alarm
assert.equal(delayed.sends.length, 0);
assert.equal((await delayed.context.mediaToChatStatus(waiting.taskId)).remainingSeconds, 1);
delayed.advance(1_000);
await Promise.all([delayed.context.resumeDelayedMediaToChatTask(waiting.taskId), delayed.context.resumeDelayedMediaToChatTask(waiting.taskId)]);
const done = await delayed.context.mediaToChatStatus(waiting.taskId);
assert.equal(done.status, 'completed'); assert.equal(done.progressPercent, 100);
assert.equal(delayed.sends.length, 1, 'duplicate wakes cannot send twice');
assert.deepEqual(clone(done.submittedFiles), [{ workspacePath: 'report.pdf' }]);
assert.ok(!JSON.stringify(waiting).includes('guardToken') && !JSON.stringify(waiting).includes('/private/'));

// Waiting releases the global file-automation queue and reserves only its own Composer.
const parallel = worker(); const reserved = await parallel.start(600);
assert.equal((await parallel.start(0, 81)).status, 'completed');
const conflicting = await parallel.context.mediaToChatStart({ files: [{ workspacePath: 'other.pdf' }], composerPolicy: 'clear' });
await assert.rejects(parallel.context.bindMediaToChatTarget(parallel.context.mediaToChatWidgetMetadata(conflicting.task.taskId), { id: 'extension', tab: parallel.tabs.get(42) }), /already using this Composer/);
assert.deepEqual(clone(parallel.pages.get(42).run(inspectChatComposer).attachments.map(card => card.name)), ['report.pdf']);
assert.equal((await parallel.context.mediaToChatCancel(reserved.taskId)).cancelled, true);
await settle();

const cancel = worker(); const cancellable = await cancel.start(20);
cancel.pages.get(42).composer.innerText = 'Keep this draft';
cancel.pages.get(42).event('input', cancel.pages.get(42).composer);
const cancelled = await cancel.context.mediaToChatCancel(cancellable.taskId);
assert.equal(cancelled.cancelled, true); assert.equal(cancelled.task.status, 'cancelled');
assert.equal(cancelled.task.remainingSeconds, null);
assert.ok(!cancel.alarms.has(`media-chat-send:${cancellable.taskId}`));
assert.equal(cancel.timers.size, 0);
cancel.advance(20_000); await cancel.context.resumeDelayedMediaToChatTask(cancellable.taskId);
await settle();
assert.equal(cancel.sends.length, 0);
assert.equal(cancel.pages.get(42).composer.innerText, 'Keep this draft');
assert.equal(cancel.pages.get(42).run(inspectChatComposer).attachments.length, 1);

for (const mutation of ['text', 'textThenDelete', 'extraFile', 'removeFile', 'closed', 'navigated', 'guardLost']) {
  const w = worker(); const task = await w.start(20); const page = w.pages.get(42);
  if (mutation === 'text' || mutation === 'textThenDelete') {
    page.composer.innerText = 'Do not send'; page.event('input', page.composer);
    if (mutation === 'textThenDelete') page.composer.innerText = '';
  }
  if (mutation === 'extraFile') page.button('Remove user.txt', 'user.txt', { markedCard: true });
  if (mutation === 'removeFile') { page.root.cards = []; page.root.controls = []; }
  if (mutation === 'closed') w.tabs.delete(42);
  if (mutation === 'navigated') w.tabs.get(42).url = 'https://chatgpt.com/c/different';
  if (mutation === 'guardLost') delete page.window.__researchtubeChatComposerGuard;
  w.advance(20_000); await w.context.resumeDelayedMediaToChatTask(task.taskId);
  const result = await w.context.mediaToChatStatus(task.taskId);
  assert.equal(result.status, 'failed', mutation); assert.equal(w.sends.length, 0, mutation);
  assert.deepEqual(clone(result.submittedFiles), []);
  assert.equal(result.submittedAt, null);
  if (mutation === 'text') assert.equal(page.composer.innerText, 'Do not send');
}

// Cancellation is linearized immediately before the trusted Send starts.
for (const boundary of ['mouseMoved', 'mousePressed']) {
  const w = worker(); const task = await w.start(20); let outcome;
  w.hook(async (_id, method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === boundary) outcome = await w.context.mediaToChatCancel(task.taskId);
  });
  w.advance(20_000); await w.context.resumeDelayedMediaToChatTask(task.taskId);
  assert.equal(outcome.cancelled, boundary === 'mouseMoved');
  assert.equal(w.sends.length, boundary === 'mouseMoved' ? 0 : 1);
  assert.equal((await w.context.mediaToChatStatus(task.taskId)).status, boundary === 'mouseMoved' ? 'cancelled' : 'completed');
}

// Cancelling during attachment leaves accepted files, and cannot resurrect the task.
const during = worker(); let duringId;
during.hook(async (_id, method) => {
  if (method === 'DOM.setFileInputFiles') {
    duringId = vm.runInContext('[...mediaToChatTasks.keys()][0]', during.context);
    assert.equal((await during.context.mediaToChatCancel(duringId)).cancelled, true);
  }
});
const stopped = await during.start(20);
assert.equal(stopped.status, 'cancelled'); assert.equal(during.sends.length, 0);
assert.equal(during.pages.get(42).run(inspectChatComposer).attachments.length, 1);

// Alarm wake survives normal MV3 worker suspension; a missing page guard refuses replay.
for (const loseGuard of [false, true]) {
  const w = worker(); const task = await w.start(600);
  if (loseGuard) delete w.pages.get(42).window.__researchtubeChatComposerGuard;
  vm.runInContext('mediaToChatLoaded = false', w.context);
  await w.context.ensureMediaToChatLoaded();
  assert.equal((await w.context.mediaToChatStatus(task.taskId)).phase, 'waitingToSend');
  w.advance(600_000); w.fireAlarm(task.taskId); await settle(); await settle();
  assert.equal((await w.context.mediaToChatStatus(task.taskId)).status, loseGuard ? 'failed' : 'completed');
  assert.equal(w.sends.length, loseGuard ? 0 : 1);
}
console.log('media to chat delay: defaults, countdown, alarms, queue release, cancellation boundary, preserved drafts and target/edit guards passed');
