import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const [widgetHtml, bridgeCode, viewerCode, manifestText, bundle] = await Promise.all([
  readFile(new URL('../ui/capture-frame-widget-v30.html', import.meta.url), 'utf8'),
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
  return events({ style: {}, dataset: {}, isConnected: true, title: '', children: [],
    get textContent() { return this.children.length ? this.children.map(item => item.textContent).join('') : this._text || ''; },
    set textContent(value) { this._text = value; this.children = []; },
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { attrs.set(name, value); }, getAttribute(name) { return attrs.get(name); }, hasAttribute(name) { return attrs.has(name); }, removeAttribute(name) { attrs.delete(name); },
    append(item) { this._text = ''; if (item.isFragment) { for (const child of item.children) this.append(child); } else { this.children.push(item); item.parentElement = this; } },
    replaceChildren(...items) { this.children = []; this._text = ''; for (const item of items) this.append(item); },
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
  const frames = [], observers = [], resizeObservers = [], created = [], posts = [];
  const document = { body, documentElement: { scrollHeight: 320 }, referrer: '',
    getElementById: id => ids.get(id),
    querySelector: selector => selector === '[data-researchtube-image-view]' ? (root.getAttribute('data-researchtube-image-view') ? root : null) : selector === 'main' ? root : null,
    querySelectorAll: () => frames,
    createElement: tag => { const item = node(); if (tag === 'iframe') item.contentWindow = {}; created.push(item); return item; },
    createDocumentFragment: () => Object.assign(node(), {isFragment: true}), createTextNode: value => Object.assign(node(), {textContent: value})
  };
  class Clock extends Date { static now() { return time.now(); } }
  const context = vm.createContext({ window, document, location: { origin: top ? 'https://chatgpt.com' : 'null', hash: '' }, URL,
    chrome: { runtime: { getManifest: () => ({ version: manifest.version }), getURL: path => `chrome-extension://test/${path}` } },
    crypto: webcrypto, AbortController, Date: Clock, console: { info() {} },
    CustomEvent: class { constructor(type, value) { this.type = type; this.detail = value.detail; } },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { observers.push(this.fn); } disconnect() { const i = observers.indexOf(this.fn); if (i >= 0) observers.splice(i, 1); } },
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { resizeObservers.push(this.fn); } disconnect() {} },
    getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible' }),
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, setInterval: time.setInterval, clearInterval: time.clearInterval,
    requestAnimationFrame: fn => time.setTimeout(fn, 0)
  });
  Object.assign(window, { innerWidth: 1200, innerHeight: 900, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  window.parent.postMessage = value => posts.push(value);
  return { context, root, ids, window, frames, observers, resizeObservers, created, posts, document,
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
const connect = (child, parent, scheduler = time, topWindow = top.window) => {
  child.window.top = topWindow; child.window.parent = parent.window;
  const frame = node(); frame.contentWindow = child.window; frame.parentElement = parent.document.body; parent.frames.push(frame);
  child.window.parent = { postMessage: value => scheduler.setTimeout(() => parent.message(value, child.window), 0) };
  // Parent source seen in the child must be the same WindowProxy it posts to.
  child.parentProxy = child.window.parent;
  child.window.postMessage = value => scheduler.setTimeout(() => child.message(value, child.parentProxy), 0);
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
// Wheel input from the fixed viewer follows its original conversation slot.
// Native-like clamping verifies boundary chaining rather than merely asserting
// the parameters passed to scrollBy.
const scrollBox = (height, clientHeight, width = 500, clientWidth = 500) => {
  const item = node(); Object.assign(item,{scrollHeight:height,clientHeight,scrollWidth:width,clientWidth,scrollTop:0,scrollLeft:0});
  item.scrollBy = ({top,left}) => {
    item.scrollTop = Math.max(0,Math.min(height-clientHeight,item.scrollTop+top));
    item.scrollLeft = Math.max(0,Math.min(width-clientWidth,item.scrollLeft+left));
  };
  item.scrollStyle={overflowX:'auto',overflowY:'auto',lineHeight:'20px'}; return item;
};
const chatScroll=scrollBox(1000,300,900,500), outerScroll=scrollBox(1400,400), documentScroll=scrollBox(1800,600);
chatScroll.parentElement=outerScroll; outerScroll.parentElement=top.document.body;
top.frames[0].parentElement=chatScroll; top.document.scrollingElement=documentScroll;
top.context.getComputedStyle=item=>item.scrollStyle||{overflowX:'visible',overflowY:'visible'};
const wheelPacket={source:'researchtube-image-view',type:'viewer-wheel',viewId:marker.viewId,requestId:marker.requestId,deltaX:0,deltaY:40,deltaMode:0};
const wheel=(extra={})=>top.message({...wheelPacket,...extra},viewer.contentWindow,'chrome-extension://test');
wheel(); assert.equal(chatScroll.scrollTop,40); assert.equal(outerScroll.scrollTop,0);
chatScroll.scrollTop=680; wheel(); assert.equal(chatScroll.scrollTop,700); assert.equal(outerScroll.scrollTop,20,'remaining wheel movement chains at the inner bottom');
chatScroll.scrollTop=10; outerScroll.scrollTop=100; wheel({deltaY:-40});
assert.equal(chatScroll.scrollTop,0); assert.equal(outerScroll.scrollTop,70,'upward wheel chains at the inner top');
wheel({deltaY:2,deltaMode:1}); assert.equal(chatScroll.scrollTop,40,'line deltas use the scroll container line height');
wheel({deltaY:1,deltaMode:2}); assert.equal(chatScroll.scrollTop,340,'page deltas use the scroll container viewport');
wheel({deltaX:60,deltaY:0}); assert.equal(chatScroll.scrollLeft,60,'horizontal touchpad movement is preserved');
const beforeInvalid=chatScroll.scrollTop;
top.message(wheelPacket,{},'chrome-extension://test');
wheel({requestId:webcrypto.randomUUID()}); wheel({deltaY:NaN}); wheel({deltaMode:9});
assert.equal(chatScroll.scrollTop,beforeInvalid,'unbound, stale and malformed wheel messages cannot scroll');
chatScroll.scrollTop=700; outerScroll.scrollTop=1000; wheel({deltaY:30});
assert.equal(documentScroll.scrollTop,30,'the document scroller is the final fallback');
top.frames[0].parentElement=top.document.body; delete top.document.scrollingElement;
top.context.getComputedStyle=()=>({overflowX:'visible',overflowY:'visible'});

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
page.ids.get('image').naturalWidth = 640; page.ids.get('image').naturalHeight = 360;
page.document.documentElement.scrollHeight = 620;
let contentHeight = 476; page.root.getBoundingClientRect = () => ({height: contentHeight});
page.context.chrome.runtime.sendMessage = async message => { requestsToAgent++; assert.equal(message.path, 'crops/test-crop.jpg'); return { ok: true, data: { metadata: {sizeBytes: 4096}, localAgentImageUrl: 'http://127.0.0.1:17843/private-image' } }; };
vm.runInContext(viewerCode, page.context); await flush();
assert.equal(requestsToAgent, 1); assert.ok(!page.posts.some(item => item.state === 'loaded'));
assert.ok(page.posts.some(item => item.type === 'viewer-diagnostic' && item.stage === 'waiting for media decode'));
assert.equal(fetched.length, 1); assert.match(fetched[0].url, /^http:\/\/127\.0\.0\.1/);
assert.match(page.ids.get('image').src, /^blob:chrome-extension:/, 'the img element never receives an insecure HTTP URL');
page.ids.get('image').dispatchEvent({ type: 'load' }); await flush();
assert.equal(page.posts.at(-1).state, 'loaded', 'successful decode acknowledges readiness without a paint callback or observer');
assert.equal(page.posts.at(-1).state, 'loaded'); assert.equal(page.ids.get('image').style.display, 'block');
assert.equal(page.posts.at(-1).height, 476, 'content height ignores the old 620px iframe viewport');
assert.deepEqual(page.ids.get('metadata').children.map(item => item.textContent), ['640 × 360', 'JPG', '4 KB']);
assert.equal(page.ids.get('path').textContent, 'crops/test-crop.jpg');
contentHeight = 180; page.resizeObservers[0]();
assert.equal(page.posts.at(-1).height, 180, 'wrapping or a smaller card can shrink the host');
const countBeforeResize = page.posts.length; page.resizeObservers[0]();
assert.equal(page.posts.length, countBeforeResize, 'unchanged geometry cannot start a resize loop');
let wheelPrevented=0;
page.window.dispatchEvent({type:'wheel',deltaX:0,deltaY:45,deltaMode:0,preventDefault(){wheelPrevented++;}});
assert.equal(wheelPrevented,1); assert.equal(page.posts.at(-1).type,'viewer-wheel');
assert.equal(page.posts.at(-1).deltaY,45); assert.equal(page.posts.at(-1).viewId,payload.viewId); assert.equal(page.posts.at(-1).requestId,payload.requestId);
page.window.dispatchEvent({type:'wheel',deltaX:0,deltaY:3,deltaMode:1,shiftKey:true,preventDefault(){wheelPrevented++;}});
assert.equal(page.posts.at(-1).deltaX,3); assert.equal(page.posts.at(-1).deltaY,0);
const beforeZoom=page.posts.length;
for (const extra of [{ctrlKey:true},{metaKey:true},{deltaY:NaN},{deltaMode:4}])
  page.window.dispatchEvent({type:'wheel',deltaX:0,deltaY:45,deltaMode:0,preventDefault(){throw new Error('Zoom or invalid input must not be cancelled');},...extra});
assert.equal(page.posts.length,beforeZoom,'browser zoom gestures are not forwarded');


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

// Audio and video use the same opaque-frame binding, acknowledgment and Copy
// route as the image. Their native elements receive only an Extension URL and
// may seek without ever invoking Blob/fetch collectors in the viewer.
for (const [mediaKind, mimeType, workspacePath] of [['video','video/mp4','downloads/test.mp4'], ['audio','audio/wav','text-to-speech/test.wav']]) {
  const avTime = clock(), avTop = surface(avTime,true), avOuter = surface(avTime), avInner = surface(avTime);
  connect(avOuter,avTop,avTime,avTop.window); connect(avInner,avOuter,avTime,avTop.window);
  avTop.bridge(); avOuter.bridge(); avInner.bridge(); avInner.widget();
  avInner.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{showInChat:true,workspacePath,mediaKind,mimeType,sizeBytes:123}}});
  avTime.advance(0);
  assert.equal(avTop.created.length,1,`${mediaKind} binds exactly one viewer`);
  const avMarker = JSON.parse(avInner.root.getAttribute('data-researchtube-image-view'));
  assert.equal(avMarker.media.mediaKind,mediaKind);
  const avFrame = avTop.created[0];
  const avPage = surface(avTime);
  avPage.context.location.hash = avFrame.src.slice(avFrame.src.indexOf('#'));
  avPage.window.parent.postMessage = value => avTime.setTimeout(()=>avTop.message(value,avFrame.contentWindow,'chrome-extension://test'),0);
  avPage.context.requestAnimationFrame = () => {throw new Error('No paint while hidden');};
  avPage.context.fetch = () => {throw new Error('Native media never collects the complete file');};
  avPage.context.URL.createObjectURL = () => {throw new Error('Native media never uses a complete Blob');};
  avPage.context.chrome.runtime.sendMessage = async () => ({ok:true,data:{metadata:{sizeBytes: 843925},localAgentImageUrl:'http://127.0.0.1/private'}});
  vm.runInContext(viewerCode,avPage.context); await flush(); avTime.advance(0);
  const target=avPage.ids.get(mediaKind);
  target.duration = mediaKind === 'video' ? 12 : 3661; target.videoWidth = 1280; target.videoHeight = 720;
  const streamUrl=new URL(target.src);
  assert.equal(streamUrl.protocol,'chrome-extension:'); assert.equal(streamUrl.pathname,'/_researchtube/workspace-media');
  assert.equal(streamUrl.searchParams.get('path'),workspacePath);
  assert.equal(avFrame.style.visibility,'visible','pending native media keeps a layout-visible frame');
  assert.equal(avFrame.style.opacity,'0','unverified native media stays transparent');
  assert.equal(avFrame.style.pointerEvents,'none','pending media cannot cover anchor controls');
  assert.equal(target.style.display,'block','native media must be in layout during metadata loading');
  assert.equal(target.getAttribute('loading'),'eager');
  avPage.resizeObservers[0](); avTime.advance(0);
  assert.equal(avFrame.style.opacity,'0','a resize before metadata must not declare media ready');
  target.dispatchEvent({type:'loadedmetadata'}); await flush(); avTime.advance(0);
  assert.equal(avFrame.style.visibility,'visible'); assert.equal(avFrame.style.opacity,'1'); assert.equal(avFrame.style.pointerEvents,'auto'); assert.equal(avInner.ids.get('status').textContent,'');
  assert.deepEqual(avPage.ids.get('metadata').children.map(item=>item.textContent), mediaKind === 'video' ? ['1280 × 720','MP4','824 KB','0:12'] : ['WAV','824 KB','1:01:01']);

  target.currentTime=4; assert.equal(target.src,streamUrl.href,'native seeking keeps the streaming source');
  let avCopies=0;
  avTop.context.chrome.runtime.sendMessage = async value => { avCopies++; assert.equal(value.path,workspacePath); return {ok:true}; };
  avInner.ids.get('copy-frame-name').dispatchEvent({type:'click'}); avTime.advance(0); await flush(); avTime.advance(0); await flush();
  assert.equal(avCopies,1); assert.equal(avInner.ids.get('status').textContent,'Workspace path copied.');
  avPage.ids.get('refresh').dispatchEvent({type:'click'}); await flush();
  assert.notEqual(target.src,streamUrl.href,'Refresh invalidates the native media source');
  target.error={code:4}; target.dispatchEvent({type:'error'}); await flush(); avTime.advance(0);
  assert.equal(avFrame.isConnected,false,'unsupported codec removes only its owned failed overlay');
  assert.match(avInner.ids.get('status').textContent,/codec is unsupported/);
  assert.equal(avTop.frames[0].isConnected,true);
  avInner.ids.get('refresh-frame').dispatchEvent({type:'click'}); avTime.advance(0);
  assert.equal(avTop.created.length,2,'Retry starts a new video/audio attempt');
  avTime.advance(10_000);
  assert.match(avInner.ids.get('status').textContent,/Retry/);
}


// Slow/missed native events are bounded and diagnosed without file buffering.
for (const probeStatus of [206,403]) {
  const stalledTime=clock(), stalledPage=surface(stalledTime);
  stalledPage.context.location.hash=`#${encodeURIComponent(JSON.stringify({...payload,mediaKind:'video',mimeType:'video/mp4',workspacePath:'demo/test.mp4'}))}`;
  stalledPage.context.chrome.runtime.sendMessage=async()=>({ok:true,data:{localAgentImageUrl:'http://127.0.0.1/private'}});
  let probes=0,probeCancelled=false;
  stalledPage.context.fetch=async(url,options)=>{
    probes++; assert.match(url,/^chrome-extension:/); assert.equal(options.headers.Range,'bytes=0-0');
    return {ok:probeStatus===206,status:probeStatus,body:{async cancel(){probeCancelled=true;}}};
  };
  const target=stalledPage.ids.get('video'); target.networkState=2; target.readyState=0;
  vm.runInContext(viewerCode,stalledPage.context);await flush();
  assert.equal(probes,0,'fast playback adds no probe request');
  stalledTime.advance(2000);await flush();
  assert.equal(probes,1);assert.equal(probeCancelled,true,'header probe cancels the body without collecting the file');
  assert.ok(stalledPage.posts.some(item=>item.stage==='native stream probe'&&item.details.status===probeStatus));
  if(probeStatus===403){
    assert.equal(stalledPage.posts.at(-1).state,'error');assert.match(stalledPage.posts.at(-1).error,/HTTP 403/);
  }else{
    // Browser state is authoritative even when its metadata event was missed.
    target.readyState=1;stalledTime.advance(500);await flush();
    assert.equal(stalledPage.posts.at(-1).state,'loaded');
    stalledTime.advance(10000);await flush();assert.equal(probes,1,'success disposes watchdogs');
  }
  assert.ok(!JSON.stringify(stalledPage.posts).includes('127.0.0.1'));
}
const timeoutTime=clock(), timeoutPage=surface(timeoutTime);
timeoutPage.context.location.hash=`#${encodeURIComponent(JSON.stringify({...payload,mediaKind:'audio',mimeType:'audio/mpeg',workspacePath:'demo/test.mp3'}))}`;
timeoutPage.context.chrome.runtime.sendMessage=async()=>({ok:true,data:{localAgentImageUrl:'http://127.0.0.1/private'}});
timeoutPage.context.fetch=async()=>({ok:true,status:206,body:{async cancel(){}}});
Object.assign(timeoutPage.ids.get('audio'),{networkState:2,readyState:0});
vm.runInContext(viewerCode,timeoutPage.context);await flush();timeoutTime.advance(10000);await flush();
assert.equal(timeoutPage.posts.at(-1).state,'error');assert.match(timeoutPage.posts.at(-1).error,/networkState=2, readyState=0/);
const deadlineTrace=timeoutPage.posts.find(item=>item.stage==='native media deadline');
assert.equal(deadlineTrace.details.version,manifest.version);assert.equal(deadlineTrace.details.networkState,2);

// MCP size notifications also measure only the owned card, not its viewport.
const sizeTime = clock(), sized = surface(sizeTime); sized.widget(); start(sized);
const sizeRequest = requests(sized)[0];
sized.document.documentElement.scrollHeight = 620;
let cardHeight = 476; sized.root.getBoundingClientRect = () => ({height: cardHeight});
sized.message({source:'researchtube-image-view',type:'result',viewId:sizeRequest.viewId,requestId:sizeRequest.requestId,state:'loaded',height:476});
assert.equal(sized.root.style.minHeight,'476px');
assert.equal(sized.posts.filter(item=>item.method==='ui/notifications/size-changed').at(-1).params.height,476);
cardHeight = 180;
sized.message({source:'researchtube-image-view',type:'result',viewId:sizeRequest.viewId,requestId:sizeRequest.requestId,state:'loaded',height:180});
assert.equal(sized.root.style.minHeight,'180px');
assert.equal(sized.posts.filter(item=>item.method==='ui/notifications/size-changed').at(-1).params.height,180);
const sizeCount = sized.posts.length; sized.resizeObservers[0]();
assert.equal(sized.posts.length,sizeCount,'same size is not repeatedly sent to the host');
sized.message({jsonrpc:'2.0',id:'researchtube-media-initialize',result:{}});
assert.equal(sized.posts.length,sizeCount+2,'initialization resends size even if the host missed the early notification');
const contextual = surface(clock()); contextual.widget();
contextual.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{...output,requestedTimestampSeconds:6.6,seekMode:'accurate'}}});
assert.equal(requests(contextual)[0].media.presentation.label,'Captured Frame');
assert.deepEqual(Array.from(requests(contextual)[0].media.presentation.tags),['t = 6.600 s','accurate seek'],'capture context crosses the same media binding');

// File tags are literal text except approved YouTube links; partial files do
// not guess a source timestamp. Task labels survive the native viewer overlay.
for (const [workspacePath, mediaKind, label, expectedLinks] of [
  ['frames/<literal> [yt_dod4cpb0z1k] [t_6.6].jpg','image','Workspace Image',2],
  ['frames/source [yt_dod4cpb0z1k] [partial_2_9] [t_6.6].jpg','image','Workspace Image',1],
  ['text-to-speech/Voice [tts_1234567890].mp3','audio','Speech TTS Audio',0],
  ['camera/Record [cam_1234567890].mp4','video','Webcam Video',0]
]) {
  const tagPage = surface(clock());
  tagPage.context.location.hash = `#${encodeURIComponent(JSON.stringify({workspacePath,mediaKind,mimeType:`${mediaKind}/${mediaKind==='image'?'jpeg':mediaKind==='audio'?'mpeg':'mp4'}`}))}`;
  // Inspect the initial header while its worker request is still pending.
  tagPage.context.chrome.runtime.sendMessage = () => new Promise(()=>{});
  vm.runInContext(viewerCode,tagPage.context);
  assert.equal(tagPage.ids.get('kind').textContent,label);
  assert.equal(tagPage.ids.get('path').textContent,workspacePath);
  const links=tagPage.ids.get('path').children.filter(item=>item.href);
  assert.equal(links.length,expectedLinks);
  for (const link of links) { assert.match(link.href,/^https:\/\/www\.youtube\.com\/watch\?v=dod4cpb0z1k/); assert.equal(link.rel,'noreferrer'); }
  if (links.length===2) assert.equal(links[1].href,'https://www.youtube.com/watch?v=dod4cpb0z1k&t=6s');
}
const captionPage = surface(clock());
captionPage.context.location.hash = `#${encodeURIComponent(JSON.stringify({...payload,presentation:{label:'Captured Frame',tags:['t = 6.600 s','accurate seek']}}))}`;
captionPage.context.chrome.runtime.sendMessage = () => new Promise(()=>{});
vm.runInContext(viewerCode,captionPage.context);
assert.equal(captionPage.ids.get('kind').textContent,'Captured Frame');
assert.deepEqual(captionPage.ids.get('metadata').children.map(item=>item.textContent),['t = 6.600 s','accurate seek','JPG']);

// Resource serving inserts the actual configured timeout without requiring a
// new interface version. Older Agents use ten; invalid settings are surfaced.
// Cached 2.2.58 audio/video HTML emits a local event instead of the current
// handshake. Both it and the old bridge may be present in a restored chat.
const legacyCode = await readFile(new URL('../chatgpt-capture-frame-bridge.js', import.meta.url), 'utf8');
for (const mediaKind of ['video', 'audio']) {
  const legacyTime = clock(), legacyTop = surface(legacyTime, true), legacyOuter = surface(legacyTime), legacyInner = surface(legacyTime);
  connect(legacyOuter, legacyTop, legacyTime, legacyTop.window);
  connect(legacyInner, legacyOuter, legacyTime, legacyTop.window);
  legacyTop.bridge(); legacyOuter.bridge(); legacyInner.bridge();
  vm.runInContext(legacyCode, legacyInner.context);
  const media = { workspacePath: `demo/sample.${mediaKind === 'video' ? 'mp4' : 'mp3'}`, mediaKind, mimeType: `${mediaKind}/${mediaKind === 'video' ? 'mp4' : 'mpeg'}` };
  const announce = () => legacyInner.window.dispatchEvent({ type: 'researchtube-local-media-ready', detail: { media } });
  announce(); legacyTime.advance(0);
  assert.equal(legacyInner.created.length, 0, 'cached templates must not mount a legacy viewer inside the sandbox');
  assert.equal(legacyTop.created.length, 1, 'cached audio/video reaches the top viewer through nested opaque frames');
  const frame = legacyTop.created[0];
  const payload = JSON.parse(decodeURIComponent(new URL(frame.src).hash.slice(1)));
  assert.equal(payload.mediaKind, mediaKind);
  assert.equal(payload.workspacePath, media.workspacePath);
  legacyTop.message({source: 'researchtube-image-view', type: 'viewer-state', state: 'loaded', viewId: payload.viewId, requestId: payload.requestId}, frame.contentWindow);
  assert.equal(frame.style.visibility, 'visible');
  legacyTime.advance(300);
  announce(); legacyTime.advance(0);
  assert.equal(frame.isConnected, false, 'cached-widget Refresh removes the previous owned player');
  const refreshed = JSON.parse(decodeURIComponent(new URL(legacyTop.created[1].src).hash.slice(1)));
  assert.equal(refreshed.viewId, payload.viewId);
  assert.notEqual(refreshed.requestId, payload.requestId);
  assert.equal(legacyTop.document.body.children.length, 1, 'Refresh leaves exactly one player');
  legacyInner.window.dispatchEvent({type: 'researchtube-local-media-ready', detail: {media: {...media, mimeType: 'text/plain'}}});
  legacyTime.advance(0);
  assert.equal(legacyTop.created.length, 2, 'invalid cached metadata is rejected');
  legacyInner.window.dispatchEvent({type: 'pagehide', persisted: false});
  announce(); legacyTime.advance(0);
  assert.equal(legacyTop.created.length, 2, 'teardown removes the compatibility event listener');
}

// Some cached runners deliver only the JSON-RPC parent notification. Validate
// its direct-child Window identity, relay through opaque frames, and deduplicate
// a concurrent DOM handshake before creating a viewer.
const packetTime = clock(), packetTop = surface(packetTime, true), packetOuter = surface(packetTime), packetInner = surface(packetTime);
connect(packetOuter, packetTop, packetTime, packetTop.window);
connect(packetInner, packetOuter, packetTime, packetTop.window);
packetTop.bridge(); packetOuter.bridge(); packetInner.bridge();
const cachedMedia = {workspacePath:'demo/researchtube-demo.mp4', mediaKind:'video', mimeType:'video/mp4'};
const packet = {jsonrpc:'2.0', method:'researchtube/extension-bridge', params:{source:'researchtube-capture-frame-widget', type:'local-media-ready', media:cachedMedia}};
packetOuter.message(packet, {}, 'null'); packetTime.advance(0);
assert.equal(packetTop.created.length,0,'unknown senders cannot select an iframe');
packetOuter.message(packet,packetInner.window,'https://unrelated.example'); packetTime.advance(0);
assert.equal(packetTop.created.length,0,'unsupported origins are rejected');
packetOuter.message(packet,packetInner.window); packetTime.advance(0);
assert.equal(packetTop.created.length,1,'parent notification alone reaches the top viewer');
packetInner.window.dispatchEvent({type:'researchtube-local-media-ready',detail:{media:cachedMedia}}); packetTime.advance(0);
assert.equal(packetTop.created.length,1,'parent-first and DOM-second notifications mount one player');
packetTime.advance(300);
packetInner.window.dispatchEvent({type:'researchtube-local-media-ready',detail:{media:cachedMedia}});
packetOuter.message(packet,packetInner.window); packetTime.advance(0);
assert.equal(packetTop.document.body.children.length,1,'DOM-first and parent-second Refresh leave one player');

// Late injection / runner isolation can lose both transient notifications.
// Recover only the known ResearchTube card DOM and ask the Agent to confirm its
// logical file/kind/MIME. No ChatGPT containers or unrelated content are read.
for (const mediaKind of ['video','audio']) {
  const domTime=clock(), domTop=surface(domTime,true), domOuter=surface(domTime), domInner=surface(domTime);
  connect(domOuter,domTop,domTime,domTop.window); connect(domInner,domOuter,domTime,domTop.window);
  domTop.bridge();domOuter.bridge();
  domInner.root.matches=value=>value==='main#capture.capture';
  const ownNodes=['brand-context','path','details','refresh-frame','copy-frame-name'].map(id=>domInner.ids.get(id));
  domInner.root.contains=value=>ownNodes.includes(value);
  domInner.ids.get('brand-context').textContent=mediaKind==='video'?'Workspace Video':'Workspace Audio';
  const path=`demo/sample.${mediaKind==='video'?'mp4':'mp3'}`;
  domInner.ids.get('path').textContent=path;
  domInner.ids.get('copy-frame-name').setAttribute('aria-label','Copy workspace path');
  let lookups=0;
  domInner.context.chrome.runtime.sendMessage=async message=>{
    assert.equal(message.type,'researchtube_media_widget_metadata');assert.equal(message.path,path);lookups++;
    return {ok:true,data:{metadata:{workspacePath:path,mediaKind,mimeType:mediaKind==='video'?'video/mp4':'audio/mpeg'},handshakeTimeoutSeconds:7}};
  };
  domInner.bridge();await flush();domTime.advance(0);
  assert.equal(domTop.created.length,1,'a fully rendered cached card recovers after its events were missed');
  const domPayload=JSON.parse(decodeURIComponent(new URL(domTop.created[0].src).hash.slice(1)));
  assert.equal(domPayload.timeoutSeconds,7,'DOM recovery uses the configured deadline');
  for(let i=0;i<50;i++)domInner.observers[0]();await flush();domTime.advance(0);
  assert.equal(lookups,1,'unchanged DOM does not poll the Agent or reload the player');
  domInner.ids.get('refresh-frame').contains=value=>value===domInner.ids.get('refresh-frame');
  domTime.advance(300);
  domInner.window.dispatchEvent({type:'click',target:domInner.ids.get('refresh-frame')});await flush();domTime.advance(0);
  assert.equal(lookups,2);assert.equal(domTop.document.body.children.length,1);
  domInner.root.setAttribute('data-researchtube-media-widget','current');
  domInner.window.dispatchEvent({type:'click',target:domInner.ids.get('refresh-frame')});await flush();domTime.advance(0);
  assert.equal(lookups,2,'current templates never use cached-DOM recovery');
}

let workerMessage;
const worker = vm.createContext({ URL, console, setTimeout, clearTimeout, crypto: webcrypto,
  chrome: { runtime: { getManifest: () => ({ version: manifest.version }), onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { workerMessage=fn; } }, getURL: path => path }, alarms: { onAlarm: { addListener() {} } } } });
vm.runInContext(bundle, worker);
assert.equal((await worker.handleMcpRequest({ id: 1, method: "initialize" })).result.serverInfo.version, manifest.version,
  "MCP initialization uses the installed manifest version");
assert.equal(worker.agentUnavailableStatus(17843).extensionVersion, manifest.version,
  "offline Agent status uses the installed manifest version");
worker.fetch = async (url, options) => {
  assert.equal(url, `ui/capture-frame-widget-v30.html?version=${manifest.version}`);
  assert.equal(options.cache, 'no-store');
  return { ok: true, text: async () => widgetHtml };
};
worker.agentJsonRequest = async () => ({ mediaWidgetHandshakeTimeoutSeconds: 7 });
assert.match(await worker.readCaptureFrameWidgetHtml(), /const IMAGE_HANDSHAKE_TIMEOUT_SECONDS = 7;/);
worker.agentJsonRequest = async () => ({});
assert.match(await worker.readCaptureFrameWidgetHtml(), /const IMAGE_HANDSHAKE_TIMEOUT_SECONDS = 10;/);
worker.fetch = async () => ({ ok: true, text: async () => widgetHtml.replaceAll("__EXTENSION_VERSION__", "2.2.58") });
await assert.rejects(worker.readCaptureFrameWidgetHtml(), /widget version template is invalid/);
worker.fetch = async () => ({ ok: true, text: async () => widgetHtml });
for(const uri of ['ui://researchtube/capture-frame-v51.html','ui://researchtube/capture-frame-v52.html','ui://researchtube/capture-frame-v53.html','ui://researchtube/capture-frame-v54.html','ui://researchtube/capture-frame-v55.html','ui://researchtube/capture-frame-v56.html']) {
  const resource=await worker.readMcpResource(10,uri);
  assert.equal(resource.result.contents[0].uri,uri,'retained tool descriptors get the current HTML under the exact requested URI');
  assert.match(resource.result.contents[0].text,new RegExp(`WIDGET_VERSION = "${manifest.version.replaceAll('.','\\.')}"`));
}
assert.equal((await worker.readMcpResource(11,'ui://researchtube/unknown.html')).error.code,-32602);
worker.agentJsonRequest = async () => ({ mediaWidgetHandshakeTimeoutSeconds: 0 });
await assert.rejects(worker.readCaptureFrameWidgetHtml(), error => error.code === 'AGENT_INVALID_RESPONSE');
worker.agentJsonRequest = async () => ({ mediaWidgetHandshakeTimeoutSeconds: 4 });
worker.getWorkspaceImageMetadata=async path=>({path,mediaKind:'video',mimeType:'video/mp4',privatePath:'/private/source.mp4',localAgentImageUrl:'http://127.0.0.1/private'});
const privateMetadata=await new Promise(resolve=>{
  assert.equal(workerMessage({type:'researchtube_media_widget_metadata',path:'demo/researchtube-demo.mp4'},{},resolve),true);
});
assert.equal(privateMetadata.ok,true);assert.equal(privateMetadata.data.handshakeTimeoutSeconds,4);
assert.deepEqual(JSON.parse(JSON.stringify(privateMetadata.data.metadata)),{workspacePath:'demo/researchtube-demo.mp4',mediaKind:'video',mimeType:'video/mp4'});
assert.ok(!JSON.stringify(privateMetadata).includes('127.0.0.1'));
worker.showWorkspaceImage = async () => ({ metadata: output, localAgentImageUrl: 'http://127.0.0.1/private' });
worker.recordCommandDiagnostic = () => {};
const displayed = await worker.executeShowWorkspaceImageToolCall(1, 'crops/test-crop.jpg');
assert.equal(displayed.result._meta['researchtube/mediaWidget'].handshakeTimeoutSeconds, 4);
assert.ok(!JSON.stringify(displayed).includes('127.0.0.1'));
console.log('Image viewer: timed retries, late/nested opaque frames, idempotence, load acknowledgment, Retry, private transport and configured timeout passed');
