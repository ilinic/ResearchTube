import { browserError } from "./browser-tools.js";

// Blank/srcdoc and page-owned data/blob frames can contain ordinary site
// content. Extension/browser internals are never candidates for observation.
export function isBrowserFrameUrlAllowed(value) {
  if (!value || /^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(value)) return true;
  if (/^blob:/i.test(value)) return /^blob:https?:\/\//i.test(value);
  return /^(?:https?:\/\/|data:)/i.test(value);
}

export async function withBrowserFrameTimeout(work, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(browserError("BROWSER_FRAME_TIMEOUT", "The frame did not respond within the bounded read window.")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function browserAttachmentError(error) {
  if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(error?.message || ""))
    return browserError("BROWSER_DEBUGGER_RESTRICTED", "Chrome refused debugger access because this tab contains another extension's protected frame. Temporarily disable that extension for this site, reload the page, and retry. No protected frame was accessed or removed.");
  if (error?.code?.startsWith("BROWSER_")) return error;
  return browserError("BROWSER_UNAVAILABLE", "Chrome could not attach the debugger to this tab. Check debugger permissions or another debugger connection and retry.");
}
