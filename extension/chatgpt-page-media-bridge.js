// This runs in ChatGPT's MAIN world.  ChatGPT's own MCP adapter consumes the
// widget notification before an isolated-world listener can reliably observe
// it, so this bridge turns the notification into a DOM marker.  DOM mutations
// are visible to the extension's isolated content script without moving media
// bytes or localhost URLs through the ChatGPT widget.
(() => {
  if (globalThis.__researchTubeChatGptPageMediaBridgeInstalled) return;
  globalThis.__researchTubeChatGptPageMediaBridgeInstalled = true;

  const WIDGET_SOURCE = "researchtube-capture-frame-widget";
  const EXTENSION_BRIDGE_METHOD = "researchtube/extension-bridge";
  const MEDIA_ATTRIBUTE = "data-researchtube-local-media";
  const SEQUENCE_ATTRIBUTE = "data-researchtube-local-media-sequence";
  console.info(`[ResearchTube media] MAIN bridge active origin=${location.origin} top=${window === window.top}`);

  function isSandboxOrigin(origin) {
    try {
      const hostname = new URL(origin).hostname;
      return hostname === "web-sandbox.oaiusercontent.com" || hostname.endsWith(".web-sandbox.oaiusercontent.com");
    } catch (_error) {
      return false;
    }
  }

  function isSandboxFrame(frame, origin) {
    if (!frame) return false;
    if (isSandboxOrigin(origin)) return true;
    // ChatGPT may sandbox the widget without allow-same-origin. In that case
    // postMessage deliberately reports an opaque "null" origin. We accept
    // that only after matching event.source to an iframe whose declared URL
    // is the ChatGPT MCP sandbox host.
    if (origin !== "null") return false;
    try {
      const frameUrl = new URL(frame.getAttribute("src") || "", location.href);
      return frameUrl.hostname === "web-sandbox.oaiusercontent.com" || frameUrl.hostname.endsWith(".web-sandbox.oaiusercontent.com");
    } catch (_error) {
      return false;
    }
  }

  function localMediaPayload(value) {
    const media = value?.media;
    if (!media || typeof media !== "object" || typeof media.workspacePath !== "string" || !media.workspacePath) return null;
    if (!new Set(["image", "video", "audio"]).has(media.mediaKind) || typeof media.mimeType !== "string") return null;
    return {
      workspacePath: media.workspacePath,
      mediaKind: media.mediaKind,
      mimeType: media.mimeType,
      sizeBytes: Number.isInteger(media.sizeBytes) ? media.sizeBytes : null
    };
  }

  function parseBridgeMessage(value) {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch (_error) { return null; }
    }
    return value && typeof value === "object" ? value : null;
  }

  function findWidgetFrame(source) {
    return [...document.querySelectorAll("iframe")].find((frame) => frame.contentWindow === source) || null;
  }

  window.addEventListener("message", (event) => {
    if (event.source === window) return;
    const value = parseBridgeMessage(event.data);
    if (value?.method !== EXTENSION_BRIDGE_METHOD) return;
    console.info(`[ResearchTube media] RPC received origin=${event.origin} jsonrpc=${value.jsonrpc || "missing"} source=${value.params?.source || "missing"} type=${value.params?.type || "missing"}`);
    if (value.jsonrpc !== "2.0" || value.params?.source !== WIDGET_SOURCE || value.params?.type !== "local-media-ready") return;
    const media = localMediaPayload(value.params);
    const frame = media && findWidgetFrame(event.source);
    if (!isSandboxFrame(frame, event.origin)) {
      let frameHost = "none";
      try { frameHost = frame ? new URL(frame.getAttribute("src") || "", location.href).hostname : "unmatched"; } catch (_error) {}
      console.warn(`[ResearchTube media] message rejected origin=${event.origin} frame=${frameHost}`);
      return;
    }

    // The second attribute changes on every refresh, including when the path
    // remains the same.  The isolated bridge observes it and installs exactly
    // one extension-owned viewer over this particular MCP iframe.
    frame.setAttribute(MEDIA_ATTRIBUTE, JSON.stringify(media));
    frame.setAttribute(SEQUENCE_ATTRIBUTE, `${Date.now()}_${Math.random().toString(36).slice(2)}`);
    console.info(`[ResearchTube media] iframe marked kind=${media.mediaKind}`);
  }, { capture: true, passive: true });

  // The MCP widget and this MAIN-world script run in the same sandbox frame.
  // Relay its in-frame CustomEvent through shared DOM attributes so the
  // isolated extension script can install the viewer without relying on a
  // message reaching ChatGPT's top-level document.
  window.addEventListener("researchtube-local-media-ready", (event) => {
    const media = localMediaPayload(event.detail);
    const root = document.getElementById("capture");
    if (!media || !root) {
      console.warn(`[ResearchTube media] widget event seen root=${Boolean(root)} payload=${Boolean(media)}`);
      return;
    }
    root.setAttribute(MEDIA_ATTRIBUTE, JSON.stringify(media));
    root.setAttribute(SEQUENCE_ATTRIBUTE, `${Date.now()}_${Math.random().toString(36).slice(2)}`);
    console.info(`[ResearchTube media] widget DOM marker written kind=${media.mediaKind}`);
  }, { capture: true });
})();
