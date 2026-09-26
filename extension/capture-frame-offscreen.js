function copyTextWithExecCommand(text) {
  const textEl = document.createElement("textarea");
  textEl.value = text;
  textEl.setAttribute("readonly", "");
  textEl.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0;";
  document.body.append(textEl);
  try {
    textEl.select();
    if (!document.execCommand("copy")) throw new Error("Chrome rejected the clipboard copy command.");
  } finally {
    textEl.remove();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "researchtube_copy_capture_frame") {
    try {
      if (message.kind !== "path" || typeof message.text !== "string" || !message.text) {
        throw new Error("A workspace path is required.");
      }
      // Offscreen documents cannot receive focus, so navigator.clipboard is not
      // reliable here. This Chrome extension route copies text using DOM selection.
      copyTextWithExecCommand(message.text);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, message: String(error?.message || error || "Clipboard request failed.") });
    }
    return true;
  }
  return undefined;
});
