(() => {
  const image = document.getElementById('image'), video = document.getElementById('video'), audio = document.getElementById('audio');
  const kind = document.getElementById('kind'), status = document.getElementById('status'), path = document.getElementById('path');
  const refresh = document.getElementById('refresh'), copy = document.getElementById('copy'), main = document.querySelector('main');
  const metadata = document.getElementById('metadata');
  const validKind = value => ['image', 'video', 'audio'].includes(value);
  const viewerVersion = chrome.runtime.getManifest().version;
  let media, imageUrl = null, loadController = null, loadSequence = 0, lastReportedHeight = null, mediaReady = false;
  const log = (stage, extra = {}) => {
    console.info('[ResearchTube media viewer]', stage,
      { version: viewerVersion, viewId: media?.viewId, requestId: media?.requestId, ...extra });
    // Extension-frame messages may be absent from the inspected ChatGPT
    // console. Relay only bounded diagnostic metadata, never URLs or bytes.
    if (validKind(media?.mediaKind) && media.viewId && media.requestId) {
      const details = { version: viewerVersion };
      for (const name of ['valid', 'ok', 'timedOut']) if (typeof extra[name] === 'boolean') details[name] = extra[name];
      for (const name of ['status', 'sizeBytes', 'height', 'readyState', 'networkState', 'mediaErrorCode']) if (Number.isFinite(extra[name])) details[name] = extra[name];
      if (typeof extra.event === 'string') details.event = extra.event;
      window.parent.postMessage({ source: 'researchtube-image-view', type: 'viewer-diagnostic',
        viewId: media.viewId, requestId: media.requestId, stage, details }, '*');
    }
  };
  try { media = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch { media = null; }
  const valid = media && typeof media.workspacePath === 'string' && validKind(media.mediaKind) && typeof media.mimeType === 'string';
  log('viewer script ready', { valid: Boolean(valid), mediaKind: media?.mediaKind });
  const notifyMedia = (state, extra = {}) => {
    if (validKind(media?.mediaKind) && media.viewId && media.requestId) window.parent.postMessage({
      source: 'researchtube-image-view', type: 'viewer-state', viewId: media.viewId, requestId: media.requestId, state, ...extra
    }, '*');
  };
  main.style.minHeight = '0';
  const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const send = message => chrome.runtime.sendMessage(message);
  const element = () => media.mediaKind === 'video' ? video : media.mediaKind === 'audio' ? audio : image;
  // This fixed Extension iframe is outside the conversation's scroll tree.
  // Route ordinary wheel input back to the original slot's ancestors. Leave
  // browser zoom gestures alone, and keep media controls clickable.
  window.addEventListener('wheel', event => {
    if (!valid || !media.viewId || !media.requestId || event.ctrlKey || event.metaKey
      || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)
      || ![0, 1, 2].includes(event.deltaMode) || (!event.deltaX && !event.deltaY)) return;
    event.preventDefault();
    const horizontal = event.shiftKey && !event.deltaX;
    window.parent.postMessage({ source: 'researchtube-image-view', type: 'viewer-wheel',
      viewId: media.viewId, requestId: media.requestId, deltaMode: event.deltaMode,
      deltaX: horizontal ? event.deltaY : event.deltaX, deltaY: horizontal ? 0 : event.deltaY }, '*');
  }, { passive: false, capture: true });
  // Never measure the iframe viewport: its previous height must not become a
  // minimum for the card. Readiness still reports synchronously after decode.
  function reportLoaded() {
    const height = Math.ceil(main.getBoundingClientRect().height);
    if (height === lastReportedHeight) return;
    lastReportedHeight = height;
    notifyMedia('loaded', { height });
  }
  function renderPath(value) {
    const fragment = document.createDocumentFragment();
    const videoId = value.match(/(?:^| )\[yt_([A-Za-z0-9_-]{11})\](?= |$)/)?.[1];
    const partial = /\[partial_\d+(?:\.\d+)?_\d+(?:\.\d+)?\]/.test(value);
    let cursor = 0;
    for (const match of value.matchAll(/\[yt_([A-Za-z0-9_-]{11})\]|\[t_(\d+(?:\.\d+)?)\]/g)) {
      fragment.append(document.createTextNode(value.slice(cursor, match.index)));
      const link = document.createElement('a');
      if (match[1] && match[1] === videoId) {
        link.className = 'youtube-video-link';
        link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        link.title = 'Open source video on YouTube';
      } else if (videoId && !partial) {
        const seconds = Number(match[2]);
        link.className = 'youtube-timestamp-link';
        link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.max(0, Math.floor(seconds))}s`;
        link.title = `Open source video at ${seconds.toFixed(3)} seconds`;
      } else {
        fragment.append(document.createTextNode(match[0])); cursor = match.index + match[0].length; continue;
      }
      link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = match[0]; fragment.append(link);
      cursor = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(value.slice(cursor))); path.replaceChildren(fragment);
  }
  function renderDetails(info = {}, decoded = false) {
    const taskLabel = /(?:^| )\[tts_[A-Za-z0-9_-]{10}\](?= |\.|$)/.test(media.workspacePath) ? 'Speech TTS Audio'
      : /(?:^| )\[cam_[A-Za-z0-9_-]{10}\](?= |\.|$)/.test(media.workspacePath) ? `Webcam ${media.mediaKind === 'image' ? 'Frame' : media.mediaKind === 'video' ? 'Video' : 'Audio'}`
      : `Workspace ${media.mediaKind === 'video' ? 'Video' : media.mediaKind === 'audio' ? 'Audio' : 'Image'}`;
    const presentation = media.presentation;
    kind.textContent = typeof presentation?.label === 'string' && presentation.label.length <= 40 ? presentation.label : taskLabel;
    renderPath(media.workspacePath); metadata.replaceChildren();
    const chip = text => { const item = document.createElement('span'); item.className = 'chip'; item.textContent = text; metadata.append(item); };
    const tags = Array.isArray(presentation?.tags) ? presentation.tags.slice(0, 4) : [];
    for (const tag of tags) if (typeof tag === 'string' && tag.length <= 100) chip(tag);
    const target = element();
    const width = media.mediaKind === 'image' ? target.naturalWidth : media.mediaKind === 'video' ? target.videoWidth : null;
    const height = media.mediaKind === 'image' ? target.naturalHeight : media.mediaKind === 'video' ? target.videoHeight : null;
    if (decoded && Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) chip(`${width} × ${height}`);
    chip((media.workspacePath.match(/\.([A-Za-z0-9]+)$/)?.[1] || media.mimeType.split('/')[1]).toUpperCase());
    if (Number.isSafeInteger(info.sizeBytes) && info.sizeBytes >= 0) chip(`${Math.round(info.sizeBytes / 1024)} KB`);
    if (decoded && media.mediaKind !== 'image' && Number.isFinite(target.duration) && target.duration >= 0) {
      const total = Math.floor(target.duration), minutes = Math.floor(total / 60), seconds = String(total % 60).padStart(2, '0');
      chip(minutes < 60 ? `${minutes}:${seconds}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`);
    }
  }
  function releaseImage() {
    image.removeAttribute('src');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
  }
  function hideMedia() {
    mediaReady = false;
    releaseImage();
    for (const item of [image, video, audio]) {
      item.style.display = 'none';
      if (item !== image) { item.pause(); item.removeAttribute('src'); item.load(); }
    }
  }
  const nativeState = target => ({ readyState: target.readyState, networkState: target.networkState, mediaErrorCode: target.error?.code || 0 });
  async function load() {
    if (!valid) { log('invalid media anchor'); setStatus('The media anchor is invalid.', true); return; }
    loadController?.abort();
    const controller = loadController = new AbortController();
    let probeController = null, nativeFailure = null, loadingState = null;
    let timedOut = false;
    const timeoutSeconds = media.timeoutSeconds || 20;
    const timer = setTimeout(() => {
      timedOut = true;
      if (media.mediaKind !== 'image') { loadingState = nativeState(element()); log('native media deadline', loadingState); }
      controller.abort();
    }, timeoutSeconds * 1000);
    refresh.disabled = true; refresh.classList.add('refreshing'); copy.disabled = true;
    lastReportedHeight = null; hideMedia(); renderDetails();
    setStatus('Loading media…');
    try {
      log('requesting workspace media from worker');
      const response = await send({ type: 'researchtube_media_viewer_resolve', path: media.workspacePath });
      log('worker answered', { ok: response?.ok === true });
      if (!response?.ok || typeof response.data?.localAgentImageUrl !== 'string') throw new Error(String(response?.error || 'The Local Agent could not provide this media.'));
      if (controller.signal.aborted) throw new Error('Media loading stopped.');
      const target = element();
      let sourceUrl;
      if (media.mediaKind !== 'image') {
        const stream = new URL(chrome.runtime.getURL('_researchtube/workspace-media'));
        stream.searchParams.set('path', media.workspacePath);
        stream.searchParams.set('reload', `${media.requestId || 'viewer'}-${++loadSequence}`);
        sourceUrl = stream.href;
        log('streaming media from Extension route');
      }
      if (media.mediaKind === 'image') {
        // Extension host permissions apply to this fetch. The image element
        // receives an Extension-owned Blob URL, never a mixed-content HTTP URL.
        log('fetching local image');
        const localImage = `${response.data.localAgentImageUrl}${response.data.localAgentImageUrl.includes('?') ? '&' : '?'}viewer=${Date.now()}`;
        const file = await fetch(localImage, { cache: 'no-store', redirect: 'error', signal: controller.signal });
        log('local HTTP response', { status: file.status, ok: file.ok });
        if (!file.ok) throw new Error(`The Local Agent could not load this image (HTTP ${file.status}).`);
        const blob = await file.blob();
        log('image bytes received', { sizeBytes: blob.size, mimeType: blob.type });
        if (controller.signal.aborted) throw new Error('Media loading stopped.');
        if (!blob.size || !blob.type.startsWith('image/')) throw new Error('The Local Agent did not return an image.');
        sourceUrl = imageUrl = URL.createObjectURL(blob);
      }
      await new Promise((resolve, reject) => {
        log('waiting for media decode');
        const loaded = media.mediaKind === 'image' ? 'load' : 'loadedmetadata';
        const nativeEvents = ['loadstart', 'progress', 'stalled', 'suspend', 'abort', 'emptied'];
        let stateTimer, probeTimer, eventCount = 0;
        const trace = event => { if (eventCount++ < 12) log('native media event', { event: event.type, ...nativeState(target) }); };
        const clear = () => {
          clearInterval(stateTimer); clearTimeout(probeTimer); probeController?.abort();
          for (const name of nativeEvents) target.removeEventListener(name, trace);
          target.removeEventListener(loaded, onload); target.removeEventListener('error', onerror);
          controller.signal.removeEventListener('abort', onerror);
        };
        const onload = () => { clear(); resolve(); };
        const onerror = () => { clear(); reject(new Error(nativeFailure || (media.mediaKind === 'image' ? 'The local image could not be loaded.' : `The local ${media.mediaKind} could not be loaded or its codec is unsupported (media error ${target.error?.code || 0}).`))); };
        if (controller.signal.aborted) { onerror(); return; }
        target.addEventListener(loaded, onload, { once: true }); target.addEventListener('error', onerror, { once: true });
        controller.signal.addEventListener('abort', onerror, { once: true });
        if (media.mediaKind !== 'image') {
          // Keep the native element in layout while it loads. The outer viewer
          // is transparent and noninteractive until successful metadata load.
          target.style.display = 'block'; target.setAttribute('loading', 'eager');
          for (const name of nativeEvents) target.addEventListener(name, trace);
          stateTimer = setInterval(() => {
            if (target.error) onerror(); else if (target.readyState >= 1) onload();
          }, 500);
          probeTimer = setTimeout(async () => {
            log('native media state', nativeState(target));
            probeController = new AbortController();
            try {
              // A stalled native load gets one Range header probe, not a file
              // collector. Cancel its body immediately; normal loads skip it.
              const probe = await fetch(sourceUrl, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', redirect: 'error', signal: probeController.signal });
              void probe.body?.cancel().catch(() => {});
              if (probeController.signal.aborted || controller.signal.aborted) return;
              log('native stream probe', { status: probe.status, ok: probe.ok });
              if (!probe.ok && !controller.signal.aborted) {
                nativeFailure = `The Extension media route returned HTTP ${probe.status}. Retry.`;
                controller.abort();
              }
            } catch {
              if (!probeController.signal.aborted && !controller.signal.aborted) log('native stream probe failed', nativeState(target));
            }
          }, Math.min(2000, timeoutSeconds * 1000 / 3));
        }
        target.src = sourceUrl;
        if (media.mediaKind !== 'image') target.load();
      });
      if (controller.signal.aborted) throw new Error('Media loading stopped.');
      target.style.display = 'block'; mediaReady = true; renderDetails(response.data.metadata, true); setStatus('');
      log('media decoded; reporting loaded', { height: Math.ceil(main.getBoundingClientRect().height) });
      // Readiness must not depend on a paint callback: the parent deliberately
      // keeps this iframe hidden until it receives this very acknowledgment.
      reportLoaded();
    } catch (error) {
      hideMedia();
      const message = timedOut ? `The local media did not finish loading${loadingState ? ` (networkState=${loadingState.networkState}, readyState=${loadingState.readyState}, mediaError=${loadingState.mediaErrorCode})` : ''}. Retry.` : error instanceof Error ? error.message : 'The local media could not be loaded.';
      log('media load failed', { error: message, timedOut });
      setStatus(message, true); notifyMedia('error', { error: message });
    } finally {
      clearTimeout(timer);
      if (loadController === controller) { loadController = null; refresh.disabled = false; refresh.classList.remove('refreshing'); copy.disabled = false; }
    }
  }
  refresh.addEventListener('click', () => void load());
  copy.addEventListener('click', async () => {
    if (!valid) return;
    copy.disabled = true;
    copy.title = 'Copying workspace path';
    try {
      const response = await send({ type: 'researchtube_capture_frame_local_action', action: 'copyPath', path: media.workspacePath });
      if (!response?.ok) throw new Error(String(response?.error || 'Could not copy the workspace path.'));
      copy.title = 'Copied workspace path';
      setStatus('Workspace path copied.');
    } catch (error) { log('Copy failed', { error: error instanceof Error ? error.message : 'Could not copy the workspace path.' }); setStatus(error instanceof Error ? error.message : 'Could not copy the workspace path.', true); }
    finally { copy.disabled = false; setTimeout(() => { copy.title = 'Copy workspace path'; }, 1400); }
  });
  window.addEventListener('pagehide', () => { loadController?.abort(); hideMedia(); });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
    if (valid && mediaReady && element().style.display === 'block') reportLoaded();
  }).observe(main);
  void load();
})();
