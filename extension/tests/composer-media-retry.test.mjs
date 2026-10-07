import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { waitForComposerMedia } from '../composer-media-retry.js';
import { pageFixture } from './fixtures/chat-composer-page.mjs';
import { inspectChatComposer } from '../chat-composer.js';

const policy = { retryCount: 15, retryIntervalSeconds: 2 };
for (const readyAt of [0, 28000, 30000, Infinity]) {
  let now = 0, probes = 0, guards = 0;
  const work = waitForComposerMedia(async () => ({ ready: (++probes, now >= readyAt) }), policy, {
    stage: 'acceptance', now: () => now, sleep: async ms => { now += ms; }, beforeCheck: async () => { guards++; }
  });
  if (readyAt === Infinity) await assert.rejects(work, error => error.code === 'MEDIA_TO_CHAT_TIMEOUT');
  else await work;
  assert.equal(now, Math.min(readyAt, 30000));
  assert.equal(probes, now / 2000 + 1);
  assert.equal(guards, probes);
}
let busyClock = 0;
await assert.rejects(waitForComposerMedia(async () => ({ busy: true }), policy, {
  stage: 'Send', now: () => busyClock, sleep: async ms => { busyClock += ms; }, busyTimeoutMs: 300000
}), error => error.code === 'MEDIA_TO_CHAT_TIMEOUT');
assert.equal(busyClock, 300000, 'active generation retains a bounded separate wait');

// Exercise the shipped worker and real serialized Composer inspections/guards.
const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const bundle = await readFile(new URL('../dist/background.js', import.meta.url), 'utf8');
function worker({ acceptedAt = 0, enabledAt = 0, acknowledgedAfter = 0, busyUntil = 0, newMessage = false, nativeForm = true, ignorePointer = false, missingSendUntil = 0, sendWorksAt = 0 } = {}) {
  let now = 0, tabOpen = true, cancelled = false, sentAt = null, userMessages = [];
  let supplied = false, accepted = false, onSleep = () => {};
  const commands = [], logs = [], sleeps = [], submissions = [], page = pageFixture();
  const tab = { id: 42, url: 'https://chatgpt.com/c/exact' };
  const sendButton = { get disabled() { return now < enabledAt || sentAt !== null && now < sentAt + acknowledgedAfter; }, getAttribute: () => '', getBoundingClientRect: () => ({ left: 100, top: 100, width: 20, height: 20 }) };
  page.root.querySelector = selector => selector === 'button[type="submit"]' && now >= missingSendUntil ? sendButton : null;
  sendButton.form = nativeForm ? page.root : null;
  if (nativeForm) page.root.requestSubmit = button => {
    assert.equal(button, sendButton); assert.equal(button.disabled, false);
    submissions.push({ at: now }); if (now >= sendWorksAt && sentAt === null) sentAt = now;
  };
  const originalQuery = page.document.querySelector, originalQueryAll = page.document.querySelectorAll;
  page.document.querySelector = selector => selector.startsWith('button[data-testid=') ? (now < busyUntil ? {} : null) : originalQuery(selector);
  page.document.querySelectorAll = selector => selector === '[data-message-author-role="user"]' ? userMessages : originalQueryAll(selector);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const event = { addListener() {} };
  const context = vm.createContext({ URL, Intl, TextEncoder, TextDecoder, AbortController, crypto: webcrypto, Date: Clock, performance: { now: () => now },
    console: { info: (...args) => logs.push(args) }, setTimeout() {}, clearTimeout() {},
    chrome: { runtime: { id: 'extension', getURL: path => path, onInstalled: event, onStartup: event, onMessage: event },
      alarms: { onAlarm: event }, storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: { get: async id => { assert.equal(id, 42); if (!tabOpen) throw Error('closed'); return tab; },
        update: async () => { throw Error('Must never activate a tab'); }, query: async () => [tab] }
    }
  });
  vm.runInContext(bundle, context);
  context.configuredComposerMediaRetry = async () => policy;
  context.sleep = async ms => { sleeps.push(ms); now += ms; onSleep(); };
  context.cdpAttach = async id => { assert.equal(id, 42); };
  context.cdpDetach = async id => { assert.equal(id, 42); };
  context.cdpWaitForTextComposer = async () => {};
  context.cdpOpenStableFileChooser = async () => ({ backendNodeId: 7 });
  context.cdpEvaluate = async (id, expression) => {
    assert.equal(id, 42);
    if (supplied && !accepted && now >= acceptedAt) {
      accepted = true; page.button('Remove tiny.jpg', 'tiny.jpg', { markedCard: true }); page.input.files = [];
    }
    if (sentAt !== null && now >= sentAt + acknowledgedAfter) {
      if (tab.url === 'https://chatgpt.com/') tab.url = 'https://chatgpt.com/c/started';
      if (newMessage) userMessages = [{ getAttribute: () => 'new-user-turn' }];
      else { page.root.cards = []; page.root.controls = []; page.composer.innerText = ''; }
    }
    page.context.location = { pathname: new URL(tab.url).pathname };
    return { value: vm.runInContext(expression, page.context) };
  };
  context.cdpCommand = async (id, method, params) => {
    assert.equal(id, 42); commands.push({ method, params });
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && ['Backspace', 'Delete'].includes(params.key)) page.composer.innerText = '';
    if (method === 'Input.insertText') {
      page.event('beforeinput', page.composer, { inputType: 'insertText', data: params.text });
      page.composer.innerText = params.text; page.event('input', page.composer, { inputType: 'insertText', data: params.text });
    }
    if (method === 'DOM.setFileInputFiles') { supplied = true; page.input.files = [{ name: 'tiny.jpg' }]; page.event('change', page.input); }
    if (!ignorePointer && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && now >= sendWorksAt && sentAt === null) sentAt = now;
    return {};
  };
  const run = () => context.cdpAttachFilesNow(['/private/tiny.jpg'], {
    currentChatTarget: { tabId: 42, chatPath: '/c/exact' },
    checkCancelled: () => { if (cancelled) throw Object.assign(Error('cancelled'), { code: 'MEDIA_TO_CHAT_CANCELLED' }); }
  });
  return { context, commands, logs, sleeps, submissions, page, tab, run, now: () => now, sentAt: () => sentAt,
    onSleep(fn) { onSleep = fn; }, cancel() { cancelled = true; }, close() { tabOpen = false; },
    navigate() { tab.url = 'https://chatgpt.com/c/another'; }
  };
}
const slow = worker({ acceptedAt: 28000, enabledAt: 32000, acknowledgedAfter: 20000 });
await slow.run();
assert.equal(slow.now(), 52000, 'each independent stage receives its retry budget');
assert.equal(slow.sentAt(), 32000);
assert.equal(slow.commands.filter(c => c.method === 'DOM.setFileInputFiles').length, 1);
assert.equal(slow.commands.filter(c => c.params?.type === 'mouseReleased').length, 0);
assert.equal(slow.submissions.length, 1);
assert.ok(slow.commands.some(c => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled));
assert.ok(slow.commands.some(c => c.method === 'Emulation.setFocusEmulationEnabled' && !c.params.enabled));
assert.ok(slow.logs.every(args => args.length === 1 && /^\[1970-01-01T/.test(args[0])));
assert.ok(slow.logs.some(args => /Send and submission acknowledgement.*elapsedMs":24000/.test(args[0])));

const instant = worker(); await instant.run(); assert.equal(instant.now(), 0); assert.equal(instant.sleeps.length, 0);
const duringGeneration = worker({ enabledAt: 120000, busyUntil: 120000 });
await duringGeneration.run(); assert.equal(duringGeneration.sentAt(), 120000);
const messageAck = worker({ acknowledgedAfter: 10000, newMessage: true });
await messageAck.run(); assert.equal(messageAck.now(), 10000, 'a new user turn also acknowledges the Send');

const noAck = worker({ acknowledgedAfter: Infinity });
await assert.rejects(noAck.run(), error => error.code === 'MEDIA_TO_CHAT_TIMEOUT');
assert.equal(noAck.now(), 30000);
assert.equal(noAck.commands.filter(c => c.params?.type === 'mouseReleased').length, 0);
assert.equal(noAck.submissions.length, 1, 'unconfirmed Send must never be submitted twice');
assert.equal(noAck.page.run(inspectChatComposer).attachments.length, 1);

for (const mutation of ['cancel', 'close', 'navigate', 'edit']) {
  const w = worker({ enabledAt: 28000 });
  w.onSleep(() => {
    if (w.now() < 10000) return;
    if (mutation === 'edit') { w.page.composer.innerText = 'KEEP THIS'; w.page.event('input', w.page.composer); }
    else w[mutation]();
  });
  await assert.rejects(w.run());
  assert.equal(w.sentAt(), null, mutation);
  assert.equal(w.page.run(inspectChatComposer).attachments.length, 1, mutation);
  assert.equal(w.now(), 10000, 'guards are checked before every readiness retry');
}
console.log('Composer media: 30-second acceptance/readiness/ack retries, immediate success, bounded busy wait, exact background tab, one upload/Send, and cancellation/edit/closure preservation: ok');

// CDP mouse dispatch acknowledgement is not proof of a page click. The native
// form must submit in a background page even when all pointer events are ignored.
const ignoredPointer = worker({ ignorePointer: true });
await ignoredPointer.run();
assert.equal(ignoredPointer.submissions.length, 1);
assert.equal(ignoredPointer.commands.filter(c => c.method === 'Input.dispatchMouseEvent').length, 0);
assert.ok(ignoredPointer.logs.some(args => /form submission dispatched.*requestSubmit/.test(args[0])));

const noForm = worker({ nativeForm: false }); await noForm.run();
assert.equal(noForm.commands.filter(c => c.params?.type === 'mouseReleased').length, 1);
assert.equal(noForm.submissions.length, 0);
assert.ok(noForm.logs.some(args => /Send pointer target/.test(args[0])));

const stopMarkupChanged = worker({ missingSendUntil: 120000, enabledAt: 120000 });
await stopMarkupChanged.run();
assert.equal(stopMarkupChanged.sentAt(), 120000, 'missing Send retains the prior response wait without relying on a Stop label');

// Startup reads the same configured retry policy: exercise actual submission
// function and the real form probe/evaluation rather than a mocked startChat.
const startup = worker({ ignorePointer: true });
startup.page.composer.innerText = 'Study this site';
let checks = 0, commitments = 0;
await startup.context.cdpClickEnabledSendButton(42, 120000, async () => { checks++; }, () => { commitments++; });
assert.equal(startup.submissions.length, 1); assert.equal(commitments, 1);
assert.ok(checks >= 2);
assert.equal(startup.commands.filter(c => c.method === 'Input.dispatchMouseEvent').length, 0);
console.log('Composer form: background startup/media requestSubmit, one dispatch, explicit no-form pointer fallback, Stop-markup response wait and acknowledgement: ok');

const retryClick = worker({ sendWorksAt: 10000 });
await retryClick.run();
assert.equal(retryClick.sentAt(), 10000);
assert.equal(retryClick.submissions.length + retryClick.commands.filter(c => c.params?.type === 'mouseReleased').length, 6);
assert.equal(retryClick.commands.filter(c => c.method === 'DOM.setFileInputFiles').length, 1, 'Send retries do not duplicate uploads');
assert.ok(retryClick.logs.some(args => /Send attempt.*attempt":6/.test(args[0])));
assert.ok(retryClick.logs.some(args => /Send confirmed; attempts stopped/.test(args[0])));

const alwaysIgnored = worker({ sendWorksAt: Infinity });
await assert.rejects(alwaysIgnored.run(), error => error.code === 'MEDIA_TO_CHAT_TIMEOUT');
assert.equal(alwaysIgnored.now(), 30000);
assert.equal(alwaysIgnored.submissions.length + alwaysIgnored.commands.filter(c => c.params?.type === 'mouseReleased').length, 16);
assert.equal(alwaysIgnored.page.run(inspectChatComposer).attachments.length, 1);
console.log('Repeated Send: initial dispatch plus 15 retries/2 seconds, alternate form/pointer, disabled pending Send waits, confirmation stops repeats, one upload and preserved failed draft: ok');

// Exercise the actual startup host callback against the shipped worker's
// helpers and page expressions, including delayed restored text and guards.
const startOffset = source.indexOf('  startChat: (tabId, prompt, checkStarting, onPhase, trace) => {');
const endOffset = source.indexOf('\n  resourceCountLimit:', startOffset);
const startExpression = source.slice(startOffset, endOffset).trim().replace(/^startChat: /, '').replace(/,$/, '');
const study = worker({ sendWorksAt: 8000 });
study.tab.url = 'https://chatgpt.com/'; study.page.composer.innerText = 'RESTORED UNSENT DRAFT';
study.context.chrome.debugger = { sendCommand: async () => ({ result: { value: true } }) };
vm.runInContext('runStudyStartup = ' + startExpression, study.context);
const phases = [];
const trace = study.context.createBrowserDiagnostics({ enabled: false });
const chatPath = await study.context.runStudyStartup(42, 'Study this site using ResearchTube', () => {}, async p => phases.push(p), trace);
assert.equal(chatPath, '/c/started');
assert.ok(phases.includes('preparingPrompt') && phases.includes('sendingPrompt'));
assert.ok(study.logs.some(args => /Composer draft cleared and verified/.test(args[0])));
assert.ok(study.logs.some(args => /Send attempt.*attempt":4/.test(args[0])));
assert.equal(study.page.composer.innerText, '');
assert.equal(study.commands.filter(c => c.method === 'Input.insertText').length, 1, 'repeat Send must not replace its draft');
console.log('Study startup: clears restored draft in its exact new tab, inserts once, retries Send and confirms saved conversation: ok');


for (const mutation of ['close', 'navigate', 'edit']) {
  const retry = worker({ sendWorksAt: Infinity });
  retry.onSleep(() => {
    if (retry.now() < 8000) return;
    if (mutation === 'edit') { retry.page.composer.innerText = 'KEEP THIS EDIT'; retry.page.event('input', retry.page.composer); }
    else retry[mutation]();
  });
  await assert.rejects(retry.run());
  assert.equal(retry.now(), 8000);
  assert.equal(retry.submissions.length + retry.commands.filter(c => c.params?.type === 'mouseReleased').length, 4);
  assert.equal(retry.commands.filter(c => c.method === 'DOM.setFileInputFiles').length, 1);
  assert.equal(retry.page.run(inspectChatComposer).attachments.length, 1);
  if (mutation === 'edit') assert.equal(retry.page.composer.innerText, 'KEEP THIS EDIT');
}
console.log('Repeated Send guards: later user edits, target navigation and tab closure stop retries without clearing or reattaching files: ok');
