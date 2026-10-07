import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL(process.env.RESEARCHTUBE_TEST_BUNDLE ? '../dist/background.js' : '../background.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function googleTranslateAbort('), source.indexOf('\nasync function speechStatus('));

function harness(options = {}) {
  let now = 0;
  const observers = [];
  const events = [];
  class Element {
    constructor(label) { this.label = label; this.isConnected = true; this.disabled = false; this.clicks = 0; this.style = { visibility: 'visible', display: 'block' }; this.source = false; }
    getBoundingClientRect() { return { left: 5, top: 10, width: 30, height: 30 }; }
    getAttribute(name) { return name === 'aria-label' ? this.label : this.source && name === 'data-aria-label-off' ? 'Listen to source text' : this.source && name === 'data-aria-label-on' ? 'Stop listening' : null; }
    setLabel(label) {
      const oldValue = this.label;
      this.label = label;
      for (const observer of observers) if (observer.target === this || observer.target === page.document.documentElement) observer.records.push({ target: this, attributeName: 'aria-label', oldValue });
    }
    click() {
      this.clicks += 1;
      events.push(['direct', now, this.label]);
      if (this.label === 'Stop listening') this.setLabel('Listen to source text');
      else if (options.directWorks !== false) this.setLabel('Stop listening');
    }
    dispatchEvent() {}
  }
  class TextArea extends Element {
    constructor() { super(null); this.text = options.text ?? 'Hello'; }
    get value() { return this.text; }
    set value(value) { this.text = value; }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
    observe(target) { this.target = target; }
    takeRecords() { return this.records.splice(0); }
    disconnect() { this.target = null; this.records.length = 0; }
  }
  const field = new TextArea();
  const button = new Element('Listen to source text'); button.source = true; button.disabled = options.readyAt != null;
  const targetButton = new Element('Listen to translation');
  const buttons = [button, targetButton];
  const root = { contains: element => element.source && element.isConnected };
  button.parentElement = root;
  const currentButton = () => buttons.find(element => element.source && element.isConnected) ?? button;
  const replaceButton = label => {
    const old = currentButton(); old.isConnected = false;
    const replacement = new Element(label); replacement.source = true; replacement.parentElement = root;
    buttons.splice(buttons.indexOf(old), 1, replacement);
    for (const observer of observers) if (observer.target === root) observer.records.push({ addedNodes: [replacement], removedNodes: [old] });
    return replacement;
  };
  const page = vm.createContext({
    document: { readyState: 'complete', documentElement: root, querySelectorAll(selector) {
      if (selector.startsWith('textarea')) return [field];
      if (selector.includes('Listen to source text')) return buttons.filter(item => item.label === 'Listen to source text' || selector.includes('Stop listening') && (item.label === 'Stop listening' || item.source));
      return [];
    } },
    getComputedStyle: element => element.style,
    HTMLTextAreaElement: TextArea,
    MutationObserver: Observer,
    InputEvent: class {}, Event: class {}
  });
  const evaluate = async (_tabId, expression) => ({ value: vm.runInContext(expression, page) });
  const controller = new AbortController();
  const context = vm.createContext({
    Date: { now: () => now }, DOMException, AbortController, Uint8Array,
    GOOGLE_TRANSLATE_URL: 'https://translate.google.com/',
    GOOGLE_TRANSLATE_TAB_TIMEOUT_MS: 3_000,
    GOOGLE_TRANSLATE_PLAYBACK_START_TIMEOUT_MS: options.startTimeout ?? 3_000,
    GOOGLE_TRANSLATE_PLAYBACK_TIMEOUT_MS: 10_000,
    googleTranslateSpeechRunners: new Map(), googleTranslateSpeechTabId: 9,
    cdpEvaluate: evaluate,
    cdpCommand: async (tabId, method, params) => {
      events.push([method, now, params]);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && options.pointerWorks !== false) {
        if (options.pendingStartAt != null) button.disabled = true;
        else button.setLabel('Stop listening');
        if (options.short) button.setLabel('Listen to source text');
      }
    },
    cdpAttach: async () => events.push(['attach', now]),
    cdpDetach: async () => events.push(['detach', now]),
    cdpLog: () => {}, cdpErrorLog: () => {}, safeErrorMessage: error => error.message,
    sleep: async ms => {
      now += ms;
      const source = currentButton();
      if (options.readyAt != null && now >= options.readyAt) source.disabled = false;
      if (options.pendingStartAt != null && now >= options.pendingStartAt && !source.startedOnce) { source.startedOnce = true; source.disabled = false; source.setLabel('Stop listening'); }
      if (options.endAt != null && now >= options.endAt && source.label === 'Stop listening') source.setLabel('Listen to source text');
      options.onSleep?.({ now, button: currentButton(), field, replaceButton, targetButton, controller: context.googleTranslateSpeechRunners.get("test")?.controller ?? controller });
    },
    agentJsonRequest: async (route, request) => { events.push([route.split('/').at(-1), now, request.body]); return {}; },
    chrome: { tabs: {
      get: async () => ({ id: 9, url: 'https://translate.google.com/', status: 'complete', mutedInfo: { muted: options.muted === true } }),
      update: async (_id, params) => events.push(['tabUpdate', now, params])
    }, scripting: { executeScript: async ({ func, args = [] }) => {
      const result = vm.runInContext(`(${func.toString()})(...${JSON.stringify(args)})`, page);
      if (options.revertText) field.value = 'reverted';
      return [{ result }];
    } } }
  });
  vm.runInContext(section, context);
  // File capture is independent of playback; prefetch must never prove a start.
  context.googleTranslateNetworkAudioCapture = async () => ({
    waitForAudio: async () => { events.push(['audioPrefetch', now]); return new Uint8Array([255, 251, 1]); },
    dispose: () => events.push(['captureDisposed', now])
  });
  context.uploadGoogleTranslateAudio = async () => events.push(['audioSaved', now]);
  return { context, page, field, button, buttons, targetButton, events, controller, observers, evaluate, replaceButton, currentButton };
}

{
  const h = harness();
  await h.context.googleTranslateSetText(9, 'new text', h.controller.signal);
  assert.equal(h.field.value, 'new text');
}
{
  const h = harness({ revertText: true });
  await assert.rejects(h.context.googleTranslateSetText(9, 'new text', h.controller.signal), /did not retain/);
  assert.equal(h.events.length, 0, 'text mismatch must not click Listen');
}
{
  const h = harness({ pointerWorks: false, endAt: 2_400 });
  await h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello');
  assert.equal(h.button.clicks, 1, 'ignored pointer gets exactly one fallback after the full startup window');
  assert.equal(h.targetButton.clicks, 0, 'translation control must never be clicked');
  assert.equal(h.button.label, 'Stop listening');
  await h.context.waitForGoogleTranslatePlaybackEnd(9, h.controller.signal);
  assert.equal(h.button.label, 'Listen to source text');
}
{
  const h = harness({ pointerWorks: false, directWorks: false });
  await assert.rejects(h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello'), /did not start/);
  assert.equal(h.button.clicks, 1);
  await assert.rejects(h.context.waitForGoogleTranslatePlaybackEnd(9, h.controller.signal), /start was not confirmed/);
}
{
  const h = harness({ short: true });
  await h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello');
  await h.context.waitForGoogleTranslatePlaybackEnd(9, h.controller.signal);
  assert.equal(h.button.clicks, 0, 'short Stop/Listen transition must not trigger another play');
}
{
  const h = harness({ pointerWorks: false, onSleep({ now, field }) { if (now >= 1_000) field.value = 'user edit'; } });
  await assert.rejects(h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello'), /changed before playback retry/);
  assert.equal(h.button.clicks, 0);
}
{
  const h = harness();
  h.buttons.push(new h.button.constructor('Listen to source text'));
  await assert.rejects(h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello'), /unique listen control/);
  assert.equal(h.events.length, 0, 'ambiguous controls must fail before input');
}
for (const outputMode of ['speakers', 'file', 'both']) {
  const h = harness({ endAt: 500 });
  await h.context.startGoogleTranslateSpeechTask('test', 'token', { text: 'Hello', outputMode });
  const terminal = h.events.find(event => event[0] === (outputMode === 'speakers' ? 'google-translate-complete' : 'audioSaved'));
  assert.ok(terminal, `${outputMode} must complete`);
  assert.ok(terminal[1] >= 500, `${outputMode} must not complete before playback ends`);
  const focusEvents = h.events.filter(event => event[0] === 'Emulation.setFocusEmulationEnabled');
  assert.equal(focusEvents[0][2].enabled, true);
  assert.equal(focusEvents.at(-1)[2].enabled, false);
  assert.ok(focusEvents.at(-1)[1] >= terminal[1], 'focus must persist through completion');
  assert.equal(h.page.__researchTubeSourcePlayback, undefined, 'observer must be removed');
  assert.equal(h.context.googleTranslateSpeechRunners.size, 0);
  if (outputMode === 'file') assert.deepEqual(h.events.filter(event => event[0] === 'tabUpdate').map(event => event[2].muted), [true, false]);
}
{
  const h = harness({ pointerWorks: false, directWorks: false });
  await h.context.startGoogleTranslateSpeechTask('test', 'token', { text: 'Hello', outputMode: 'both' });
  assert.equal(h.events.find(event => event[0] === 'google-translate-fail')[2].code, 'GOOGLE_TRANSLATE_PLAYBACK_FAILED');
  assert.ok(!h.events.some(event => ['audioSaved', 'google-translate-complete'].includes(event[0])), 'prefetched audio and ignored click cannot complete');
  assert.equal(h.page.__researchTubeSourcePlayback, undefined);
  assert.equal(h.events.at(-1)[0], 'detach');
}
{
  const h = harness({ onSleep({ controller }) { controller.abort(); } });
  await h.context.startGoogleTranslateSpeechTask('test', 'token', { text: 'Hello', outputMode: 'speakers' });
  assert.equal(h.button.label, 'Listen to source text', 'cancellation must stop confirmed playback');
  assert.equal(h.button.clicks, 1);
  assert.equal(h.page.__researchTubeSourcePlayback, undefined);
  assert.ok(!h.events.some(event => ['audioSaved', 'google-translate-complete', 'google-translate-fail'].includes(event[0])));
  assert.equal(h.events.at(-1)[0], 'detach');
}
{
  const h = harness({ muted: true, endAt: 500 });
  await h.context.startGoogleTranslateSpeechTask('test', 'token', { text: 'Hello', outputMode: 'file' });
  assert.ok(!h.events.some(event => event[0] === 'tabUpdate'), 'user mute must remain unchanged');
}
// The Google engine can start late, while the control remains disabled.
// An audible/accepted start is not rejected or clicked again after 2 seconds.
{
  const h = harness({ startTimeout: 60_000, pendingStartAt: 45_000 });
  await h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello');
  assert.equal(h.button.clicks, 0, '45-second startup must not be clicked twice');
  assert.equal(h.button.label, 'Stop listening');
  assert.equal(h.events.filter(event => event[0] === 'Input.dispatchMouseEvent' && event[2].type === 'mouseReleased').length, 1);
}
{
  const h = harness({ readyAt: 750, pendingStartAt: 2_500, endAt: 3_000 });
  await h.context.startGoogleTranslateSpeechTask('test', 'token', { text: 'Hello', outputMode: 'speakers' });
  const input = h.events.find(event => event[0] === 'Input.dispatchMouseEvent');
  assert.ok(input[1] >= 750, 'recognition/readiness must finish before Listen');
  const playing = h.events.find(event => event[0] === 'google-translate-progress' && event[2].phase === 'playing');
  assert.ok(playing[1] >= 2_500, 'playing cannot precede Stop listening');
  assert.ok(h.events.some(event => event[0] === 'google-translate-complete'));
  assert.equal(h.button.clicks, 0);
}
{
  let replaced = false;
  const h = harness({ pointerWorks: false, onSleep({ now, replaceButton }) {
    if (now >= 2_500 && !replaced) { replaced = true; replaceButton('Stop listening'); }
  } });
  await h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello');
  assert.equal(h.currentButton().label, 'Stop listening');
  assert.equal(h.currentButton().clicks, 0, 'replacement Stop must confirm source playback');
  assert.equal(h.targetButton.clicks, 0);
}
{
  const h = harness({ pendingStartAt: 2_500, onSleep({ now, button }) {
    button.style.display = now >= 100 && now < 2_000 ? 'none' : 'block';
  } });
  await h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello');
  assert.equal(h.button.clicks, 0, 'temporary disappearance is pending, not failure');
}
{
  const h = harness({ pointerWorks: false, directWorks: false });
  h.targetButton.setLabel('Stop listening');
  await assert.rejects(h.context.googleTranslatePressListen(9, h.controller.signal, 'Hello'), /did not start/);
  assert.equal(h.targetButton.clicks, 0, 'target-language Stop cannot confirm source speech');
}
{
  let replaced = false;
  const h = harness({ endAt: 2_000, onSleep({ now, replaceButton }) {
    if (now >= 500 && !replaced) { replaced = true; replaceButton('Stop listening'); }
  } });
  await h.context.startGoogleTranslateSpeechTask('test', 'token', { text: 'Hello', outputMode: 'speakers' });
  assert.ok(h.events.find(event => event[0] === 'google-translate-complete')[1] >= 3_000, 'replacement during playback must settle, not fail');
}
console.log('Google Translate confirmed asynchronous background playback: ok');

{
 const h=harness();await h.context.googleTranslatePlaybackState(9,'arm','Hello');
 h.observers[0].records.push({addedNodes:[{nodeType:3}],removedNodes:[]});
 const state=await h.context.googleTranslatePlaybackState(9);
 assert.equal(state.started,false,'unrelated text mutations must neither crash nor confirm playback');
}
