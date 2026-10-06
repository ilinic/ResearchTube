// Own markers and direct-child Window identities bind an image to its slot.
// Nested sandbox frames relay metadata only; the viewer lives in the top page.
(() => {
  if (globalThis.__researchTubeImageViewerBridgeInstalled) return;
  globalThis.__researchTubeImageViewerBridgeInstalled = true;
  const SOURCE = 'researchtube-image-view';
  const DISCONNECTED = 'ResearchTube was updated or disconnected. Reload this ChatGPT tab and retry.';
  const routes = new Map();
  const viewers = new Map();
  const actions = new Map();
  const viewerStages = new Set(['viewer script ready', 'invalid media anchor',
    'requesting workspace media from worker', 'worker answered', 'fetching local image',
    'local HTTP response', 'image bytes received', 'waiting for media decode',
    'media decoded; reporting loaded', 'media load failed', 'Copy failed']);
  const log = (...args) => console.info('[ResearchTube image]', ...args);
  let stopped = false, observer, lastScannedView, lastScannedAction;
  function dispose(error) {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    window.removeEventListener('researchtube-image-view-ready', onReady);
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('researchtube-image-view-action', onAction);
    for (const entry of viewers.values()) {
      if (error) finish(entry, 'error', { error });
      remove(entry);
    }
    viewers.clear(); routes.clear();
    for (const entry of actions.values()) {
      if (!entry.response) actionResult(entry, false, DISCONNECTED);
      clearTimeout(entry.timer);
    }
    actions.clear();
    globalThis.__researchTubeImageViewerBridgeInstalled = false;
  }
  function runtimeValue(read) {
    try { return read(chrome.runtime); }
    catch (error) {
      log('bridge stopped: Extension runtime unavailable', String(error?.message || error));
      dispose(DISCONNECTED);
      return null;
    }
  }
  const version = runtimeValue(runtime => runtime.getManifest().version);
  if (version === null) return;
  log(`extension=${version} bridge ready top=${window === window.top} origin=${location.origin}`);

  function valid(value) {
    return value?.source === SOURCE && /^[a-f0-9-]{36}$/.test(value.viewId)
      && /^[a-f0-9-]{36}$/.test(value.requestId) && value.media?.mediaKind === 'image'
      && typeof value.media.workspacePath === 'string' && value.media.workspacePath.length > 0
      && typeof value.media.mimeType === 'string' && value.media.mimeType.startsWith('image/')
      && Number.isInteger(value.timeoutSeconds) && value.timeoutSeconds >= 1 && value.timeoutSeconds <= 300 && Number.isSafeInteger(value.expiresAt);
  }
  const key = value => `${value.viewId}/${value.requestId}`;
  function allowedOrigin(origin) {
    if (origin === 'null') return true;
    try { const host = new URL(origin).hostname; return host === 'chatgpt.com' || host === 'web-sandbox.oaiusercontent.com' || host.endsWith('.web-sandbox.oaiusercontent.com'); }
    catch { return false; }
  }
  function sendWindow(target, origin, value) {
    try { target?.postMessage(value, origin === 'null' ? '*' : origin); }
    catch (error) { log('reply failed: destination frame unavailable', String(error?.message || error)); }
  }
  function reply(route, value) {
    if (route.local) window.dispatchEvent(new CustomEvent('researchtube-image-view-result', { detail: value }));
    else sendWindow(route.source, route.origin, value);
  }
  function result(value, state, extra = {}) {
    return { source: SOURCE, type: 'result', viewId: value.viewId, requestId: value.requestId, state, ...extra };
  }
  function actionResult(entry, ok, error) {
    const value = entry.value;
    entry.response = { source: SOURCE, type: 'action-result', viewId: value.viewId, requestId: value.requestId,
      actionId: value.actionId, ok, ...(error ? { error } : {}) };
    if (entry.route.local) window.dispatchEvent(new CustomEvent('researchtube-image-view-action-result', { detail: entry.response }));
    else sendWindow(entry.route.source, entry.route.origin, entry.response);
    log(`view=${value.viewId} action=${value.actionId} Copy ${ok ? 'completed' : 'failed'}`, error || '');
  }
  function actionRequest(route, value) {
    if (stopped || !valid(value) || !/^[a-f0-9-]{36}$/.test(value.actionId) || value.action !== 'copyPath') return;
    const prior = actions.get(value.actionId);
    if (prior) {
      if (prior.route.source !== route.source || key(prior.value) !== key(value)) return;
      if (prior.response) {
        if (route.local) window.dispatchEvent(new CustomEvent('researchtube-image-view-action-result', { detail: prior.response }));
        else sendWindow(route.source, route.origin, prior.response);
      }
      return;
    }
    if (Date.now() >= value.expiresAt) return;
    const bound = routes.get(key(value));
    const entry = { value, route };
    if (!bound || bound.source !== route.source || actions.size >= 128) {
      actionResult(entry, false, 'The image widget is not connected to the Extension. Click Refresh and retry Copy.'); return;
    }
    actions.set(value.actionId, entry);
    entry.timer = setTimeout(() => {
      if (!entry.response) actionResult(entry, false, 'The Extension did not finish copying the workspace path. Retry Copy.');
      actions.delete(value.actionId);
    }, Math.max(0, Math.min(value.timeoutSeconds * 1000, value.expiresAt - Date.now())));
    log(`view=${value.viewId} action=${value.actionId} Copy received via=${route.local ? 'DOM' : 'child-frame'} top=${window === window.top}`);
    if (window !== window.top) {
      window.parent.postMessage(value, '*');
      log(`view=${value.viewId} action=${value.actionId} Copy forwarded to parent`); return;
    }
    const viewer = viewers.get(value.viewId);
    if (!viewer || viewer.value.requestId !== value.requestId || viewer.value.media.workspacePath !== value.media.workspacePath) {
      actionResult(entry, false, 'The image widget has changed. Click Refresh and retry Copy.'); return;
    }
    Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'researchtube_capture_frame_local_action',
      action: 'copyPath', path: viewer.value.media.workspacePath })).then(
      response => {
        if (!stopped && actions.get(value.actionId) === entry && !entry.response) actionResult(entry, response?.ok === true,
          response?.ok ? null : String(response?.error || 'The workspace path could not be copied.'));
      },
      error => {
        if (!stopped && actions.get(value.actionId) === entry && !entry.response) actionResult(entry, false, String(error?.message || 'The Extension is unavailable.'));
      }
    );
  }
  function finish(entry, state, extra = {}) {
    if (entry.state === 'error') return;
    if (state === 'loaded' && entry.state === state && entry.lastResult.height === extra.height) return;
    entry.state = state; entry.lastResult = result(entry.value, state, extra);
    if (state !== 'accepted') clearTimeout(entry.timer);
    reply(entry.route, entry.lastResult);
    log(`view=${entry.value.viewId} ${state}`, extra.error || '');
  }
  function remove(entry) {
    clearTimeout(entry.timer); entry.resize?.disconnect(); entry.viewer.remove();
    window.removeEventListener('resize', entry.position);
    window.removeEventListener('scroll', entry.position, true);
  }
  function install(route, value) {
    const viewerUrl = runtimeValue(runtime => runtime.getURL('media-viewer.html'));
    if (viewerUrl === null) { reply(route, result(value, 'error', { error: DISCONNECTED })); return; }
    const existing = viewers.get(value.viewId);
    if (existing?.value.requestId === value.requestId) {
      if (existing.route.source !== route.source) return;
      reply(route, existing.lastResult); return;
    }
    if (existing && existing.route.source !== route.source) return;
    if (existing) remove(existing);
    const frame = route.frame;
    if (!frame?.isConnected || !frame.parentElement) { log(`view=${value.viewId} no connected widget slot`); return; }
    // Do not move or replace React-owned nodes, or change host ancestor styles.
    const viewer = document.createElement('iframe');
    viewer.dataset.researchtubeImageViewer = value.viewId;
    viewer.title = 'ResearchTube local image';
    viewer.style.cssText = 'position:fixed;border:0;visibility:hidden;background:transparent;z-index:2;';
    viewer.src = `${viewerUrl}#${encodeURIComponent(JSON.stringify({ ...value.media, viewId: value.viewId, requestId: value.requestId, timeoutSeconds: value.timeoutSeconds }))}`;
    document.body.append(viewer);
    const entry = { value, route, viewer, state: 'accepted', lastResult: result(value, 'accepted'),
      diagnosticCount: 0, lastStage: 'viewer attached; waiting for script' };
    viewer.addEventListener('load', () => {
      if (viewers.get(value.viewId) === entry && entry.state !== 'error') log(`view=${value.viewId} viewer document loaded`);
    }, { once: true });
    entry.position = () => {
      if (!frame.isConnected) { remove(entry); viewers.delete(value.viewId); return; }
      const rect = frame.getBoundingClientRect();
      // The direct slot may be an outer sandbox wrapper. Clip to its viewport
      // and overflow ancestors so a scrolled-off image cannot cover the chat.
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
      for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent); const box = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      Object.assign(viewer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        clipPath: `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)` });
      viewer.style.visibility = entry.state === 'loaded' && right > left && bottom > top ? 'visible' : 'hidden';
    };
    entry.timer = setTimeout(() => {
      if (entry.state !== 'accepted') return;
      log(`view=${value.viewId} loading timeout; last stage=${entry.lastStage}`);
      finish(entry, 'error', { error: 'The local image viewer did not finish loading. Retry.' }); remove(entry);
    }, Math.max(0, Math.min(value.timeoutSeconds * 1000, value.expiresAt - Date.now())));
    if (typeof ResizeObserver === 'function') { entry.resize = new ResizeObserver(entry.position); entry.resize.observe(frame); }
    window.addEventListener('resize', entry.position);
    window.addEventListener('scroll', entry.position, true);
    viewers.set(value.viewId, entry); entry.position();
    reply(route, entry.lastResult); log(`view=${value.viewId} viewer attached`);
  }
  function request(route, value) {
    if (stopped) return;
    if (!valid(value)) { log('request rejected: invalid image metadata'); return; }
    if (Date.now() >= value.expiresAt) { log(`view=${value.viewId} request expired`); return; }
    if (runtimeValue(runtime => runtime.getManifest().version) === null) { reply(route, result(value, 'error', { error: DISCONNECTED })); return; }
    const existing = routes.get(key(value));
    if (existing && existing.source !== route.source) { log(`view=${value.viewId} request rejected: slot identity changed`); return; }
    log(`view=${value.viewId} request=${value.requestId} received via=${route.local ? 'DOM' : 'child-frame'} top=${window === window.top}`);
    for (const id of routes.keys()) if (id.startsWith(`${value.viewId}/`) && id !== key(value)) routes.delete(id);
    routes.set(key(value), route);
    // A restored conversation may contain many prior widgets. Retain only live
    // routes; no completed tasks or media bytes are held by this bridge.
    for (const [id, item] of routes) if (!item.local && !item.frame?.isConnected) routes.delete(id);
    if (window === window.top) install(route, value);
    else {
      window.parent.postMessage({ ...value, type: 'request' }, '*');
      log(`view=${value.viewId} request=${value.requestId} forwarded to parent`);
    }
  }
  function local(value) { request({ local: true, source: window }, value); }
  function onReady(event) { if (!stopped) local(event.detail); }
  function onAction(event) { actionRequest({ local: true, source: window }, event.detail); }
  function onPageHide(event) { if (!event.persisted) dispose(); }
  window.addEventListener('researchtube-image-view-ready', onReady);
  window.addEventListener('researchtube-image-view-action', onAction);
  window.addEventListener('pagehide', onPageHide);
  function scan() {
    if (stopped) return;
    const marker = document.querySelector('[data-researchtube-image-view]');
    if (!marker) return;
    const view = marker.getAttribute('data-researchtube-image-view');
    if (view !== lastScannedView) {
      try { lastScannedView = view; local(JSON.parse(view)); } catch { /* incomplete marker */ }
    }
    const action = marker.getAttribute('data-researchtube-image-action');
    if (action !== lastScannedAction) {
      lastScannedAction = action;
      if (action) { try { onAction({ detail: JSON.parse(action) }); } catch { /* incomplete marker */ } }
    }
  }
  if (window !== window.top) {
    observer = new MutationObserver(scan);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-researchtube-image-view', 'data-researchtube-image-action'] });
    scan();
  }
  function handleMessage(event) {
    if (stopped) return;
    const value = event.data;
    if (value?.source !== SOURCE || event.source === window) return;
    if (['viewer-state', 'viewer-diagnostic'].includes(value.type) && window === window.top) {
      const entry = viewers.get(value.viewId);
      if (!entry || entry.viewer.contentWindow !== event.source || entry.value.requestId !== value.requestId || entry.state === 'error') return;
      if (value.type === 'viewer-diagnostic') {
        if (!viewerStages.has(value.stage) || entry.diagnosticCount >= 30) return;
        entry.diagnosticCount++;
        entry.lastStage = value.stage;
        const details = {};
        for (const name of ['valid', 'ok', 'timedOut']) if (typeof value.details?.[name] === 'boolean') details[name] = value.details[name];
        for (const name of ['status', 'sizeBytes', 'height']) if (Number.isFinite(value.details?.[name])) details[name] = value.details[name];
        log(`view=${value.viewId} viewer stage=${value.stage}`, details);
        return;
      }
      if (value.state === 'loaded') {
        const height = Number.isFinite(value.height) ? Math.max(100, Math.min(800, Math.ceil(value.height))) : 320;
        finish(entry, 'loaded', { height }); entry.position();
      } else if (value.state === 'error') { finish(entry, 'error', { error: String(value.error || 'The local image could not be loaded.') }); remove(entry); }
      return;
    }
    if (value.type === 'result' && event.source === window.parent && window !== window.top) {
      const route = routes.get(key(value));
      if (route && ['accepted', 'loaded', 'error'].includes(value.state)) reply(route, value);
      return;
    }
    if (value.type === 'action-result' && event.source === window.parent && window !== window.top) {
      const entry = actions.get(value.actionId);
      if (entry && key(entry.value) === key(value) && !entry.response) actionResult(entry, value.ok === true, value.error);
      return;
    }
    if (!['request', 'action-request'].includes(value.type)) return;
    if (!allowedOrigin(event.origin)) { log('request rejected: unsupported child origin', event.origin); return; }
    const frame = [...document.querySelectorAll('iframe')].find(item => item.contentWindow === event.source);
    if (!frame) { log(`view=${value.viewId} request rejected: sending iframe not found`); return; }
    const route = { local: false, source: event.source, origin: event.origin, frame };
    if (value.type === 'action-request') actionRequest(route, value);
    else request(route, value);
  }
  function onMessage(event) {
    try { handleMessage(event); }
    catch (error) { log('message handling failed', String(error?.message || error)); }
  }
  if (!stopped) window.addEventListener('message', onMessage);
})();
