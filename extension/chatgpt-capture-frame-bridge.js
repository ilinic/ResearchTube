// The primary bridge runs in chatgpt.com and overlays the exact sandbox iframe
// that emitted the media anchor. A same-frame CustomEvent route is retained as
// a harmless fallback for sandbox frames into which Chrome permits injection.
if (!globalThis.__researchTubeCaptureFrameWidgetBridgeInstalled) {
  globalThis.__researchTubeCaptureFrameWidgetBridgeInstalled = true;

  const WIDGET_SOURCE = "researchtube-capture-frame-widget";
  const EXTENSION_BRIDGE_METHOD = "researchtube/extension-bridge";
  const ALLOWED_ACTIONS = new Set(["copyPath", "copyImage", "downloadImage"]);
  const OVERLAY_CLASS = "researchtube-local-media-overlay";

  function localMediaPayload(value) {
    const media = value?.media;
    if (!media || typeof media !== "object" || typeof media.workspacePath !== "string" || !media.workspacePath) return null;
    if (!new Set(["image", "video", "audio"]).has(media.mediaKind) || typeof media.mimeType !== "string") return null;
    return { workspacePath: media.workspacePath, mediaKind: media.mediaKind, mimeType: media.mimeType, sizeBytes: Number.isInteger(media.sizeBytes) ? media.sizeBytes : null };
  }

  function createViewer(media) {
    const viewer = document.createElement("iframe");
    viewer.className = OVERLAY_CLASS;
    viewer.title = "ResearchTube local media";
    viewer.allow = "autoplay";
    viewer.src = `${chrome.runtime.getURL("media-viewer.html")}#${encodeURIComponent(JSON.stringify(media))}`;
    return viewer;
  }

  function actionResult(requestId, ok, payload = {}) {
    window.dispatchEvent(new CustomEvent("researchtube-local-action-result", {
      detail: { source: WIDGET_SOURCE, type: "local-action-result", requestId, ok, ...payload }
    }));
  }

  function handleLocalAction(message, reply = actionResult) {
    if (!message || message.source !== WIDGET_SOURCE || message.type !== "local-action-request") return;
    if (typeof message.requestId !== "string" || !message.requestId || !ALLOWED_ACTIONS.has(message.action) || typeof message.path !== "string" || !message.path) return;
    chrome.runtime.sendMessage({ type: "researchtube_capture_frame_local_action", action: message.action, path: message.path }).then(
      (response) => response?.ok
        ? reply(message.requestId, true, { data: response.data ?? null })
        : reply(message.requestId, false, { error: String(response?.error || "The local ResearchTube action did not complete.") }),
      (error) => reply(message.requestId, false, { error: String(error?.message || error || "The local ResearchTube bridge is unavailable.") })
    );
  }

  function isSandboxOrigin(origin) {
    try {
      const hostname = new URL(origin).hostname;
      return hostname === "web-sandbox.oaiusercontent.com" || hostname.endsWith(".web-sandbox.oaiusercontent.com");
    } catch (_error) {
      return false;
    }
  }

  function findWidgetFrame(source) {
    return [...document.querySelectorAll("iframe")].find((frame) => frame.contentWindow === source) || null;
  }

  function widgetBridgeMessage(value) {
    if (value?.jsonrpc !== "2.0" || value.method !== EXTENSION_BRIDGE_METHOD || !value.params || typeof value.params !== "object") return null;
    return value.params;
  }

  function installTopLevelMediaViewer(widgetFrame, media) {
    const existingHost = widgetFrame.closest("[data-researchtube-local-media-host]");
    const host = existingHost || document.createElement("div");
    if (!existingHost) {
      const anchorHeight = Math.max(1, Math.ceil(widgetFrame.getBoundingClientRect().height || widgetFrame.clientHeight || 620));
      host.dataset.researchtubeLocalMediaHost = "";
      host.style.cssText = `position:relative;width:100%;min-width:0;height:${anchorHeight}px;`;
      widgetFrame.replaceWith(host);
      host.append(widgetFrame);
      widgetFrame.style.cssText += ";visibility:hidden;pointer-events:none;";
    }
    host.dataset.researchtubeMediaPath = media.workspacePath;
    host.dataset.researchtubeMediaKind = media.mediaKind;
    host.querySelector(`.${OVERLAY_CLASS}`)?.remove();
    const viewer = createViewer(media);
    viewer.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;z-index:1;";
    host.append(viewer);
  }

  function installSameFrameMediaViewer(media) {
    const root = document.getElementById("capture");
    if (!root || !document.body) return;
    root.style.visibility = "hidden";
    root.style.pointerEvents = "none";
    document.querySelector(`.${OVERLAY_CLASS}`)?.remove();
    const viewer = createViewer(media);
    viewer.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent;z-index:2147483647;visibility:visible;pointer-events:auto;";
    document.body.append(viewer);
  }

  if (location.hostname === "chatgpt.com") {
    window.addEventListener("message", (event) => {
      if (!isSandboxOrigin(event.origin) || event.source === window) return;
      const message = widgetBridgeMessage(event.data);
      if (message?.source === WIDGET_SOURCE && message.type === "local-media-ready") {
        const media = localMediaPayload(message);
        const widgetFrame = findWidgetFrame(event.source);
        if (media && widgetFrame) installTopLevelMediaViewer(widgetFrame, media);
        return;
      }
      if (!message) return;
      handleLocalAction(message, (requestId, ok, payload) => event.source?.postMessage({ source: WIDGET_SOURCE, type: "local-action-result", requestId, ok, ...payload }, event.origin));
    }, { passive: true });
  } else {
    window.addEventListener("researchtube-local-media-ready", (event) => {
      const media = localMediaPayload(event.detail);
      if (media) installSameFrameMediaViewer(media);
    });
    window.addEventListener("researchtube-local-action-request", (event) => handleLocalAction(event.detail));
  }
}
