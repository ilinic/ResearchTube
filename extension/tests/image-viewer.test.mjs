import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const [widgetHtml, bridgeCode, viewerCode, manifestText, bundle] = await Promise.all([
  readFile(new URL('../ui/capture-frame-widget-v27.html', import.meta.url), 'utf8'),
  readFile(new URL('../chatgpt-image-viewer-bridge.js', import.meta.url), 'utf8'),
  readFile(new URL('../media-viewer.js', import.meta.url), 'utf8'),
  readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
  readFile(new URL('../dist/background.js', import.meta.url), 'utf8')
]);
const widgetCode = widgetHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const manifest = JSON.parse(manifestText);
const registration = manifest.content_scripts.find(item => item.js.includes('chatgpt-image-viewer-bridge.js'));
assert.equal(registration.match_origin_as_fallback, true);
assert.equal(registration.match_about_blank, true);
assert.equal(registration.all_frames, true);
assert.ok(registration.matches.includes('https://*.web-sandbox.oaiusercontent.com/*'));
assert.equal(registration.css, undefined);
assert.deepEqual(manifest.web_accessible_resources[0].resources, ['media-viewer.html'], 'packaged script loads inside its own Extension origin without public exposure');

function events(target = {}) {
  const listeners = new Map();
  target.addEventListener = (type, fn) => { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); };
  target.removeEventListener = (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn));
  target.dispatchEvent = event => { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); };
  return target;
}
function clock() {
  let now = 0, nextId = 1;
  const pending = new Map();
  return { pending, now: () => now,
    setTimeout(fn, delay = 0) { const id = nextId++; pending.set(id, { fn, at: now + delay, repeat: 0 }); return id; },
    setInterval(fn, delay) { const id = nextId++; pending.set(id, { fn, at: now + delay, repeat: delay }); return id; },
    clearTimeout(id) { pending.delete(id); }, clearInterval(id) { pending.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const entries = [...pending].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at);
        if (!entries.length) break;
        const [id, item] = entries[0]; now = item.at;
        if (item.repeat) item.at += item.repeat; else pending.delete(id);
        item.fn();
      }
      now = until;
    }
  };
}
function node() {
  const attrs = new Map();
  return events({ style: {}, dataset: {}, isConnected: true, textContent: '', title: '', children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { attrs.set(name, value); }, getAttribute(name) { return attrs.get(name); }, removeAttribute(name) { attrs.delete(name); },
    append(item) { this.children.push(item); item.parentElement = this; }, replaceChildren() { this.children = []; },
    remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); },
    pause() {}, load() {}, scrollHeight: 130,
    getBoundingClientRect() { return { left: 100, top: 150, right: 600, bottom: 470, width: 500, height: 320 }; }
  });
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function surface(time, top = false) {
  const root = node(), body = node();
  const ids = new Map(['capture','status','details','path','metadata','brand-context','refresh-frame','copy-frame-name','image','video','audio','kind','refresh','copy'].map(id => [id, id === 'capture' ? root : node()]));
  const window = events({}); window.top = top ? window : {}; window.parent = top ? window : { postMessage() {} };
  const frames = [], observers = [], created = [], posts = [];
  const document = { body, documentElement: { scrollHeight: 320 }, referrer: '',
    getElementById: id => ids.get(id),
    querySelector: selector => selector === '[data-researchtube-image-view]' ? (root.getAttribute('data-researchtube-image-view') ? root : null) : selector === 'main' ? root : null,
    querySelectorAll: () => frames,
    createElement: tag => { const item = node(); if (tag === 'iframe') item.contentWindow = {}; created.push(item); return item; },
    createDocumentFragment: node, createTextNode: value => value
  };
  class Clock extends Date { static now() { return time.now(); } }
  const context = vm.createContext({ window, document, location: { origin: top ? 'https://chatgpt.com' : 'null', hash: '' }, URL,
    chrome: { runtime: { getManifest: () => ({ version: manifest.version }), getURL: path => `chrome-extension://test/${path}` } },
    crypto: webcrypto, AbortController, Date: Clock, console: { info() {} },
    CustomEvent: class { constructor(type, value) { this.type = type; this.detail = value.detail; } },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { observers.push(this.fn); } disconnect() { const i = observers.indexOf(this.fn); if (i >= 0) observers.splice(i, 1); } },
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
    getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible' }),
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, setInterval: time.setInterval, clearInterval: time.clearInterval,
    requestAnimationFrame: fn => time.setTimeout(fn, 0)
  });
  Object.assign(window, { innerWidth: 1200, innerHeight: 900, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  window.parent.postMessage = value => posts.push(value);
  return { context, root, ids, window, frames, observers, created, posts, document,
    bridge() { vm.runInContext(bridgeCode, context); },
    widget(timeout = 10) { vm.runInContext(widgetCode.replace('const IMAGE_HANDSHAKE_TIMEOUT_SECONDS = 10;', `const IMAGE_HANDSHAKE_TIMEOUT_SECONDS = ${timeout};`), context); },
    message(value, source = window.parent, origin = 'null') { window.dispatchEvent({ type: 'message', data: value, source, origin }); }
  };
}
const output = { showInChat: true, image: { workspacePath: 'crops/test-crop.jpg', mimeType: 'image/jpeg', mediaKind: 'image' } };
const start = page => page.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: output } });
const requests = page => page.posts.filter(item => item.source === 'researchtube-image-view');

// No Extension: one initial attempt and one per second, bounded to ten seconds.
const absentTime = clock(), absent = surface(absentTime); absent.widget(); start(absent);
assert.equal(requests(absent).length, 1); absentTime.advance(999); assert.equal(requests(absent).length, 1);
absentTime.advance(1); assert.equal(requests(absent).length, 2);
absentTime.advance(9000); assert.equal(requests(absent).length, 10);
assert.match(absent.ids.get('status').textContent, /Retry/);
absentTime.advance(60_000); assert.equal(requests(absent).length, 10);
absent.ids.get('refresh-frame').dispatchEvent({ type: 'click' });
assert.equal(requests(absent).length, 11);
assert.notEqual(requests(absent).at(-1).requestId, requests(absent)[0].requestId);
// Refresh uses the tool-result event's output through the compatibility state.
// A fresh result in a restored widget also starts a new bounded attempt.
const customTime = clock(), custom = surface(customTime); custom.widget(3); start(custom); customTime.advance(3000);
assert.equal(requests(custom).length, 3); assert.match(custom.ids.get('status').textContent, /Retry/);
const cachedTime = clock(), cached = surface(cachedTime); cached.widget(10);
cached.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: output,
  _meta: { 'researchtube/mediaWidget': { handshakeTimeoutSeconds: 2 } } } });
cachedTime.advance(2000);
assert.equal(requests(cached).length, 2, 'per-call metadata overrides the cached HTML timeout');
assert.match(cached.ids.get('status').textContent, /Retry/);

// A nested opaque widget arrives before its content script. Its marker recovers
// injection, relays through an outer sandbox, and receives loaded confirmation.
const time = clock(), top = surface(time, true), outer = surface(time), inner = surface(time);
const connect = (child, parent) => {
  child.window.top = top.window; child.window.parent = parent.window;
  const frame = node(); frame.contentWindow = child.window; frame.parentElement = parent.document.body; parent.frames.push(frame);
  child.window.parent = { postMessage: value => time.setTimeout(() => parent.message(value, child.window), 0) };
  // Parent source seen in the child must be the same WindowProxy it posts to.
  child.parentProxy = child.window.parent;
  child.window.postMessage = value => time.setTimeout(() => child.message(value, child.parentProxy), 0);
  return frame;
};
connect(outer, top); connect(inner, outer);
top.bridge(); outer.bridge(); inner.widget(); start(inner); time.advance(0);
assert.equal(top.created.length, 1);
const initial = requests(absent)[0];
const marker = JSON.parse(inner.root.getAttribute('data-researchtube-image-view'));
// Only the page-side widget markers are inspected: late inner bridge scans it.
inner.bridge(); time.advance(0);
assert.equal(top.created.length, 1, 'repeated metadata never creates a second viewer');
const queuedBeforeScan = time.pending.size;
for (let i = 0; i < 100; i++) inner.observers[0]();
assert.equal(time.pending.size, queuedBeforeScan, 'acknowledgment DOM changes do not recursively resend unchanged markers');
const viewer = top.created[0];
const stageLogs = [];
top.context.console.info = (...args) => stageLogs.push(args);
const diagnostic = { source: 'researchtube-image-view', type: 'viewer-diagnostic',
  viewId: marker.viewId, requestId: marker.requestId, stage: 'local HTTP response',
  details: { status: 200, ok: true, privateUrl: 'http://127.0.0.1/private' } };
top.message(diagnostic, {}, 'chrome-extension://test');
top.message({...diagnostic, requestId: webcrypto.randomUUID()}, viewer.contentWindow);
top.message({...diagnostic, stage: 'unrecognized stage'}, viewer.contentWindow);
assert.equal(stageLogs.length, 0, 'unbound, stale and unknown diagnostics are ignored');
top.message(diagnostic, viewer.contentWindow, 'chrome-extension://test');
assert.equal(stageLogs.length, 1);
assert.match(stageLogs[0][1], /viewer stage=local HTTP response/);
assert.equal(stageLogs[0][2].status, 200);
assert.ok(!JSON.stringify(stageLogs).includes('127.0.0.1'), 'relay exposes only allowlisted diagnostic metadata');
for (let i = 0; i < 100; i++) top.message(diagnostic, viewer.contentWindow);
assert.equal(stageLogs.length, 30, 'diagnostic volume is bounded per loading attempt');
assert.equal(viewer.parentElement, top.document.body);
assert.equal(viewer.style.visibility, 'hidden', 'blank viewer never covers the anchor');
assert.match(inner.ids.get('status').textContent, /Extension connected/);
time.advance(4000); assert.equal(top.created.length, 1);
top.message({ source: 'researchtube-image-view', type: 'viewer-state', viewId: marker.viewId, requestId: marker.requestId, state: 'loaded', height: 135 }, {}, 'chrome-extension://test');
assert.equal(viewer.style.visibility, 'hidden', 'an unrelated frame cannot mark an image loaded');
top.message({ source: 'researchtube-image-view', type: 'viewer-state', viewId: marker.viewId, requestId: marker.requestId, state: 'loaded', height: 135 }, viewer.contentWindow, 'chrome-extension://test');
time.advance(0);
assert.equal(viewer.style.visibility, 'visible');
assert.equal(inner.ids.get('status').textContent, '');
assert.equal(inner.root.style.minHeight, '135px');
time.advance(60_000); assert.equal(top.created.length, 1); assert.equal(inner.ids.get('status').textContent, '');
assert.equal(top.frames[0].isConnected, true, 'the original host frame is never replaced');
// Refresh retains the originating slot and starts a distinct attempt. Stale
// success from the removed viewer cannot complete its replacement.
inner.ids.get('refresh-frame').dispatchEvent({ type: 'click' }); time.advance(0);
const retryMarker = JSON.parse(inner.root.getAttribute('data-researchtube-image-view'));
assert.equal(retryMarker.viewId, marker.viewId); assert.notEqual(retryMarker.requestId, marker.requestId);
assert.equal(viewer.isConnected, false); assert.equal(top.created.length, 2);
const replacement = top.created[1];
top.message({ source: 'researchtube-image-view', type: 'viewer-state', viewId: marker.viewId, requestId: marker.requestId, state: 'loaded' }, viewer.contentWindow);
assert.equal(replacement.style.visibility, 'hidden');
top.message({ source: 'researchtube-image-view', type: 'viewer-state', viewId: retryMarker.viewId, requestId: retryMarker.requestId, state: 'error', error: 'Image unavailable. Retry.' }, replacement.contentWindow);
time.advance(0); assert.equal(replacement.isConnected, false); assert.match(inner.ids.get('status').textContent, /Retry/);

// Copy shares the acknowledged image route across nested opaque frames.
// It works without the legacy capture-frame content script, executes once
// despite dual DOM/message notifications, and returns worker failures.
let copies = 0, resolveCopy;
top.context.chrome.runtime.sendMessage = message => {
  copies++;
  assert.equal(message.type, 'researchtube_capture_frame_local_action');
  assert.equal(message.action, 'copyPath'); assert.equal(message.path, output.image.workspacePath);
  return new Promise(resolve => { resolveCopy = resolve; });
};
inner.ids.get('copy-frame-name').dispatchEvent({type: 'click'}); time.advance(0); await flush();
assert.equal(copies, 1);
const copying = JSON.parse(inner.root.getAttribute('data-researchtube-image-action'));
time.advance(2000); await flush(); assert.equal(copies, 1, 'retries do not execute Copy again');
resolveCopy({ok: true}); await flush(); time.advance(0); await flush();
assert.equal(inner.ids.get('status').textContent, 'Workspace path copied.');
assert.equal(inner.root.getAttribute('data-researchtube-image-action'), undefined);
assert.equal(inner.ids.get('copy-frame-name').disabled, false);
const unknownAction = {...copying, actionId: webcrypto.randomUUID(), expiresAt: time.now() + 10_000,
  media: {...copying.media, workspacePath: 'other.jpg'}};
top.message(unknownAction, outer.window); await flush();
assert.equal(copies, 1, 'an action cannot change the bound media path');
top.context.chrome.runtime.sendMessage = async () => { copies++; return {ok: false, error: 'Clipboard unavailable'}; };
inner.ids.get('copy-frame-name').dispatchEvent({type: 'click'}); time.advance(0); await flush(); time.advance(0); await flush();
assert.equal(copies, 2); assert.equal(inner.ids.get('status').textContent, 'Clipboard unavailable');
top.context.chrome.runtime.sendMessage = () => { copies++; throw new Error('Extension context invalidated.'); };
inner.ids.get('copy-frame-name').dispatchEvent({type: 'click'}); time.advance(0); await flush(); time.advance(0); await flush();
assert.equal(copies, 3); assert.match(inner.ids.get('status').textContent, /Extension context invalidated/);
top.context.chrome.runtime.sendMessage = () => { copies++; return new Promise(() => {}); };
inner.ids.get('copy-frame-name').dispatchEvent({type: 'click'}); time.advance(0); await flush();
assert.equal(copies, 4); time.advance(10_000); await flush();
assert.match(inner.ids.get('status').textContent, /Copy|copy/);
assert.equal(inner.ids.get('copy-frame-name').disabled, false, 'timeout enables Retry');


// No loaded signal (e.g. blocked extension iframe): keep anchor visible, report
// error, remove the failed overlay, and do not revive an expired marker.
const failTime = clock(), failTop = surface(failTime, true); failTop.bridge();
const source = {}, slot = node(); slot.contentWindow = source; slot.parentElement = failTop.document.body; failTop.frames.push(slot);
const responses = []; source.postMessage = value => responses.push(value);
const failRequest = { ...initial, expiresAt: 10_000 };
failTop.message(failRequest, source); assert.equal(failTop.created.length, 1);
failTime.advance(10_000); assert.equal(failTop.created[0].isConnected, false);
assert.equal(responses.at(-1).state, 'error');
failTop.message(failRequest, source); assert.equal(failTop.created.length, 1);
failTop.message({ ...failRequest, requestId: webcrypto.randomUUID(), expiresAt: 20_000 }, source);
assert.equal(failTop.created.length, 2, 'explicit retry creates a fresh viewer');
const inherited = surface(clock(), true); inherited.bridge();
const inheritedSource = {}, inheritedSlot = node();
inheritedSource.postMessage = () => {};
inheritedSlot.contentWindow = inheritedSource; inheritedSlot.parentElement = inherited.document.body; inherited.frames.push(inheritedSlot);
inherited.message({...initial, viewId: webcrypto.randomUUID(), expiresAt: 10_000}, inheritedSource, 'https://unrelated.example');
assert.equal(inherited.created.length, 0, 'unrelated child origins remain rejected');
inherited.message({...initial, viewId: webcrypto.randomUUID(), expiresAt: 10_000}, inheritedSource, 'https://chatgpt.com');
assert.equal(inherited.created.length, 1, 'about:blank/srcdoc children may inherit the ChatGPT origin');

// Reloading an Extension leaves old page scripts without a runtime. Stop them
// cleanly, release their listeners/overlays and permit fresh injection.
const staleTime = clock(), stale = surface(staleTime, true);
const staleSource = {}, staleSlot = node(), staleReplies = [], staleLogs = [];
staleSource.postMessage = value => staleReplies.push(value);
staleSlot.contentWindow = staleSource; staleSlot.parentElement = stale.document.body; stale.frames.push(staleSlot);
stale.context.console.info = (...args) => staleLogs.push(args);
stale.bridge();
stale.context.chrome.runtime.getURL = () => { throw new Error('Extension context invalidated.'); };
const staleRequest = { ...initial, expiresAt: 10_000 };
assert.doesNotThrow(() => stale.message(staleRequest, staleSource));
assert.equal(stale.created.length, 0, 'invalid runtime cannot leave a blank iframe');
assert.equal(staleReplies.at(-1).state, 'error');
assert.match(staleReplies.at(-1).error, /Reload this ChatGPT tab/);
assert.equal(stale.context.__researchTubeImageViewerBridgeInstalled, false);
for (let i = 0; i < 10; i++) stale.message(staleRequest, staleSource);
assert.equal(staleLogs.filter(args => String(args[0]).includes('ResearchTube') && args.some(arg => String(arg).includes('bridge stopped'))).length, 1);
stale.context.chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
stale.bridge(); stale.message(staleRequest, staleSource);
assert.equal(stale.created.length, 1, 'a fresh bridge can install after old cleanup');
assert.equal(staleTime.pending.size, 1);
stale.context.chrome.runtime.getManifest = () => { throw new Error('Extension context invalidated.'); };
assert.doesNotThrow(() => stale.message(staleRequest, staleSource));
assert.equal(stale.created[0].isConnected, false, 'runtime loss removes only the owned overlay');
assert.equal(staleSlot.isConnected, true, 'host widget is preserved');
assert.equal(staleTime.pending.size, 0, 'pending deadlines are released');
assert.doesNotThrow(() => stale.bridge(), 'even initial manifest lookup is guarded');
assert.equal(stale.context.__researchTubeImageViewerBridgeInstalled, false);
const restored = surface(clock(), true); restored.bridge();
restored.window.dispatchEvent({type: 'pagehide', persisted: true});
assert.equal(restored.context.__researchTubeImageViewerBridgeInstalled, true, 'back-forward cache preserves the live bridge');
restored.window.dispatchEvent({type: 'pagehide', persisted: false});
assert.equal(restored.context.__researchTubeImageViewerBridgeInstalled, false);
const staleChild = surface(clock()); staleChild.bridge();
assert.equal(staleChild.observers.length, 1);
staleChild.context.chrome.runtime.getManifest = () => { throw new Error('Extension context invalidated.'); };
staleChild.root.setAttribute('data-researchtube-image-view', JSON.stringify(staleRequest));
assert.doesNotThrow(() => staleChild.observers[0]());
assert.equal(staleChild.observers.length, 0, 'invalid nested scripts disconnect DOM observers');

// A real viewer script requests a private URL through the Extension, then waits
// for image.onload before announcing success. Error messages contain no URL.
const viewerTime = clock(), page = surface(viewerTime);
const payload = { ...marker.media, viewId: marker.viewId, requestId: marker.requestId, timeoutSeconds: 10 };
page.context.location.hash = `#${encodeURIComponent(JSON.stringify(payload))}`;
page.context.requestAnimationFrame = () => { throw new Error('A hidden iframe cannot supply a paint callback.'); };
let requestsToAgent = 0;
const createdUrls = [], revokedUrls = [], fetched = [];
page.context.URL = class extends URL {
  static createObjectURL(blob) { const url = `blob:chrome-extension://test/image-${createdUrls.length}`; createdUrls.push({url, blob}); return url; }
  static revokeObjectURL(url) { revokedUrls.push(url); }
};
page.context.fetch = async (url, options) => {
  fetched.push({url, options});
  assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  return { ok: true, blob: async () => new Blob(['test-image'], {type: 'image/jpeg'}) };
};
page.context.chrome.runtime.sendMessage = async message => { requestsToAgent++; assert.equal(message.path, 'crops/test-crop.jpg'); return { ok: true, data: { localAgentImageUrl: 'http://127.0.0.1:17843/private-image' } }; };
vm.runInContext(viewerCode, page.context); await flush();
assert.equal(requestsToAgent, 1); assert.ok(!page.posts.some(item => item.state === 'loaded'));
assert.ok(page.posts.some(item => item.type === 'viewer-diagnostic' && item.stage === 'waiting for media decode'));
assert.equal(fetched.length, 1); assert.match(fetched[0].url, /^http:\/\/127\.0\.0\.1/);
assert.match(page.ids.get('image').src, /^blob:chrome-extension:/, 'the img element never receives an insecure HTTP URL');
page.ids.get('image').dispatchEvent({ type: 'load' }); await flush();
assert.equal(page.posts.at(-1).state, 'loaded', 'successful decode acknowledges readiness without a paint callback or observer');
assert.equal(page.posts.at(-1).state, 'loaded'); assert.equal(page.ids.get('image').style.display, 'block');
page.ids.get('copy').dispatchEvent({ type: 'click' }); await flush(); assert.equal(requestsToAgent, 2);
page.ids.get('refresh').dispatchEvent({ type: 'click' }); await flush(); assert.equal(requestsToAgent, 3);
assert.equal(revokedUrls[0], createdUrls[0].url, 'Refresh releases the previous image bytes');
page.ids.get('image').dispatchEvent({ type: 'error' }); await flush();
assert.equal(page.posts.at(-1).state, 'error'); assert.ok(!JSON.stringify(page.posts).includes('127.0.0.1'));
assert.equal(revokedUrls.length, 2, 'image decode failure releases the new Blob');
page.context.fetch = async () => ({ok: false, status: 416});
page.ids.get('refresh').dispatchEvent({type: 'click'}); await flush();
assert.equal(page.posts.at(-1).state, 'error'); assert.match(page.posts.at(-1).error, /HTTP 416/);
assert.equal(createdUrls.length, 2, 'failed HTTP responses do not become image URLs');
page.context.fetch = async () => ({ok: true, blob: async () => new Blob(['error'], {type: 'application/json'})});
page.ids.get('refresh').dispatchEvent({type: 'click'}); await flush();
assert.equal(page.posts.at(-1).state, 'error'); assert.match(page.posts.at(-1).error, /did not return an image/);
let aborted = false;
page.context.fetch = (_url, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, {once: true});
});
page.ids.get('refresh').dispatchEvent({type: 'click'}); await flush();
viewerTime.advance(10_000); await flush();
assert.equal(aborted, true, 'the image deadline aborts a stalled local fetch');
assert.equal(page.posts.at(-1).state, 'error'); assert.match(page.posts.at(-1).error, /Retry/);

// Resource serving inserts the actual configured timeout without requiring a
// new interface version. Older Agents use ten; invalid settings are surfaced.
const worker = vm.createContext({ URL, console, setTimeout, clearTimeout, crypto: webcrypto,
  chrome: { runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getURL: path => path }, alarms: { onAlarm: { addListener() {} } } } });
vm.runInContext(bundle, worker);
worker.fetch = async () => ({ ok: true, text: async () => widgetHtml });
worker.agentJsonRequest = async () => ({ mediaWidgetHandshakeTimeoutSeconds: 7 });
assert.match(await worker.readCaptureFrameWidgetHtml(), /const IMAGE_HANDSHAKE_TIMEOUT_SECONDS = 7;/);
worker.agentJsonRequest = async () => ({});
assert.match(await worker.readCaptureFrameWidgetHtml(), /const IMAGE_HANDSHAKE_TIMEOUT_SECONDS = 10;/);
worker.agentJsonRequest = async () => ({ mediaWidgetHandshakeTimeoutSeconds: 0 });
await assert.rejects(worker.readCaptureFrameWidgetHtml(), error => error.code === 'AGENT_INVALID_RESPONSE');
worker.agentJsonRequest = async () => ({ mediaWidgetHandshakeTimeoutSeconds: 4 });
worker.showWorkspaceImage = async () => ({ metadata: output, localAgentImageUrl: 'http://127.0.0.1/private' });
worker.recordCommandDiagnostic = () => {};
const displayed = await worker.executeShowWorkspaceImageToolCall(1, 'crops/test-crop.jpg');
assert.equal(displayed.result._meta['researchtube/mediaWidget'].handshakeTimeoutSeconds, 4);
assert.ok(!JSON.stringify(displayed).includes('127.0.0.1'));
console.log('Image viewer: timed retries, late/nested opaque frames, idempotence, load acknowledgment, Retry, private transport and configured timeout passed');
