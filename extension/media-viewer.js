(() => {
  const image = document.getElementById('image'), video = document.getElementById('video'), audio = document.getElementById('audio');
  const kind = document.getElementById('kind'), status = document.getElementById('status'), path = document.getElementById('path');
  const refresh = document.getElementById('refresh'), copy = document.getElementById('copy'), main = document.querySelector('main');
  let media, imageUrl = null, loadController = null;
  const log = (stage, extra = {}) => {
    console.info('[ResearchTube image viewer]', stage,
      { viewId: media?.viewId, requestId: media?.requestId, ...extra });
    // Extension-frame messages may be absent from the inspected ChatGPT
    // console. Relay only bounded diagnostic metadata, never URLs or bytes.
    if (media?.mediaKind === 'image' && media.viewId && media.requestId) {
      const details = {};
      for (const name of ['valid', 'ok', 'timedOut']) if (typeof extra[name] === 'boolean') details[name] = extra[name];
      for (const name of ['status', 'sizeBytes', 'height']) if (Number.isFinite(extra[name])) details[name] = extra[name];
      window.parent.postMessage({ source: 'researchtube-image-view', type: 'viewer-diagnostic',
        viewId: media.viewId, requestId: media.requestId, stage, details }, '*');
    }
  };
  try { media = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch { media = null; }
  const valid = media && typeof media.workspacePath === 'string' && ['image', 'video', 'audio'].includes(media.mediaKind) && typeof media.mimeType === 'string';
  log('viewer script ready', { valid: Boolean(valid), mediaKind: media?.mediaKind });
  const notifyImage = (state, extra = {}) => {
    if (media?.mediaKind === 'image' && media.viewId && media.requestId) window.parent.postMessage({
      source: 'researchtube-image-view', type: 'viewer-state', viewId: media.viewId, requestId: media.requestId, state, ...extra
    }, '*');
  };
  if (media?.mediaKind === 'image') main.style.minHeight = '0';
  const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const send = message => chrome.runtime.sendMessage(message);
  const element = () => media.mediaKind === 'video' ? video : media.mediaKind === 'audio' ? audio : image;
  function releaseImage() {
    image.removeAttribute('src');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
  }
  function hideMedia() {
    releaseImage();
    for (const item of [image, video, audio]) {
      item.style.display = 'none';
      if (item !== image) { item.pause(); item.removeAttribute('src'); item.load(); }
    }
  }
  async function load() {
    if (!valid) { log('invalid media anchor'); setStatus('The media anchor is invalid.', true); return; }
    loadController?.abort();
    const controller = loadController = new AbortController();
    let timedOut = false;
    const timeoutSeconds = media.timeoutSeconds || 20;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSeconds * 1000);
    refresh.disabled = true; copy.disabled = true; hideMedia(); path.textContent = media.workspacePath;
    kind.textContent = media.mediaKind === 'video' ? 'Workspace Video' : media.mediaKind === 'audio' ? 'Speech / Workspace Audio' : 'Workspace Image';
    setStatus('Loading media…');
    try {
      log('requesting workspace media from worker');
      const response = await send({ type: 'researchtube_media_viewer_resolve', path: media.workspacePath });
      log('worker answered', { ok: response?.ok === true });
      if (!response?.ok || typeof response.data?.localAgentImageUrl !== 'string') throw new Error(String(response?.error || 'The Local Agent could not provide this media.'));
      if (controller.signal.aborted) throw new Error('Image loading stopped.');
      const target = element();
      let sourceUrl = `${response.data.localAgentImageUrl}${response.data.localAgentImageUrl.includes('?') ? '&' : '?'}viewer=${Date.now()}`;
      if (media.mediaKind === 'image') {
        // Extension host permissions apply to this fetch. The image element
        // receives an Extension-owned Blob URL, never a mixed-content HTTP URL.
        log('fetching local image');
        const file = await fetch(sourceUrl, { cache: 'no-store', redirect: 'error', signal: controller.signal });
        log('local HTTP response', { status: file.status, ok: file.ok });
        if (!file.ok) throw new Error(`The Local Agent could not load this image (HTTP ${file.status}).`);
        const blob = await file.blob();
        log('image bytes received', { sizeBytes: blob.size, mimeType: blob.type });
        if (controller.signal.aborted) throw new Error('Image loading stopped.');
        if (!blob.size || !blob.type.startsWith('image/')) throw new Error('The Local Agent did not return an image.');
        sourceUrl = imageUrl = URL.createObjectURL(blob);
      }
      await new Promise((resolve, reject) => {
        log('waiting for media decode');
        const loaded = media.mediaKind === 'image' ? 'load' : 'loadedmetadata';
        const clear = () => {
          target.removeEventListener(loaded, onload); target.removeEventListener('error', onerror);
          controller.signal.removeEventListener('abort', onerror);
        };
        const onload = () => { clear(); resolve(); };
        const onerror = () => { clear(); reject(new Error('The local media could not be loaded.')); };
        if (controller.signal.aborted) { onerror(); return; }
        target.addEventListener(loaded, onload, { once: true }); target.addEventListener('error', onerror, { once: true });
        controller.signal.addEventListener('abort', onerror, { once: true });
        target.src = sourceUrl;
        if (media.mediaKind !== 'image') target.load();
      });
      if (controller.signal.aborted) throw new Error('Image loading stopped.');
      target.style.display = 'block'; setStatus('');
      log('media decoded; reporting loaded', { height: main.scrollHeight });
      // Readiness must not depend on a paint callback: the parent deliberately
      // keeps this iframe hidden until it receives this very acknowledgment.
      notifyImage('loaded', { height: main.scrollHeight });
    } catch (error) {
      if (media.mediaKind === 'image') releaseImage();
      const message = timedOut ? 'The local media did not finish loading. Retry.' : error instanceof Error ? error.message : 'The local media could not be loaded.';
      log('media load failed', { error: message, timedOut });
      setStatus(message, true); notifyImage('error', { error: message });
    } finally {
      clearTimeout(timer);
      if (loadController === controller) { loadController = null; refresh.disabled = false; copy.disabled = false; }
    }
  }
  refresh.addEventListener('click', () => void load());
  copy.addEventListener('click', async () => {
    if (!valid) return;
    copy.disabled = true;
    try {
      const response = await send({ type: 'researchtube_capture_frame_local_action', action: 'copyPath', path: media.workspacePath });
      if (!response?.ok) throw new Error(String(response?.error || 'Could not copy the workspace path.'));
      setStatus('Workspace path copied.');
    } catch (error) { log('Copy failed', { error: error instanceof Error ? error.message : 'Could not copy the workspace path.' }); setStatus(error instanceof Error ? error.message : 'Could not copy the workspace path.', true); }
    finally { copy.disabled = false; }
  });
  window.addEventListener('pagehide', () => { loadController?.abort(); releaseImage(); });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
    if (image.style.display === 'block') notifyImage('loaded', { height: main.scrollHeight });
  }).observe(main);
  void load();
})();
