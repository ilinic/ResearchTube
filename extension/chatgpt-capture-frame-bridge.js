// Direct, local bridge for the buttons inside the ResearchTube capture-frame
// MCP App. It avoids routing a user click through ChatGPT's conversation API:
// the widget lives in an oaiusercontent iframe and this content script runs in
// its chatgpt.com parent page.
if (!globalThis.__researchTubeCaptureFrameWidgetBridgeInstalled) {
  globalThis.__researchTubeCaptureFrameWidgetBridgeInstalled = true;

  const WIDGET_SOURCE = "researchtube-capture-frame-widget";
  const ALLOWED_ACTIONS = new Set(["copyPath", "copyImage", "downloadImage"]);

  function isResearchTubeWidgetOrigin(origin) {
    try {
      const hostname = new URL(origin).hostname;
      return hostname === "web-sandbox.oaiusercontent.com" || hostname.endsWith(".web-sandbox.oaiusercontent.com");
    } catch (_error) {
      return false;
    }
  }

  function resultMessage(requestId, ok, payload = {}) {
    return { source: WIDGET_SOURCE, type: "local-action-result", requestId, ok, ...payload };
  }

  window.addEventListener("message", (event) => {
    if (!isResearchTubeWidgetOrigin(event.origin) || event.source === window) return;
    const message = event.data;
    if (!message || message.source !== WIDGET_SOURCE || message.type !== "local-action-request") return;
    if (typeof message.requestId !== "string" || !message.requestId || !ALLOWED_ACTIONS.has(message.action) || typeof message.path !== "string" || !message.path) return;

    chrome.runtime.sendMessage({
      type: "researchtube_capture_frame_local_action",
      action: message.action,
      path: message.path
    }).then(
      (response) => {
        const reply = response?.ok
          ? resultMessage(message.requestId, true, { data: response.data ?? null })
          : resultMessage(message.requestId, false, { error: String(response?.error || "The local ResearchTube action did not complete.") });
        event.source?.postMessage(reply, event.origin);
      },
      (error) => event.source?.postMessage(resultMessage(message.requestId, false, { error: String(error?.message || error || "The local ResearchTube bridge is unavailable.") }), event.origin)
    );
  }, { passive: true });
}
