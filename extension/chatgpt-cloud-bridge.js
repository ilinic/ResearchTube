// Dedicated public-connection handshake; local task capabilities stay separate.
if (!globalThis.__researchtubeCloudBridge) {
  globalThis.__researchtubeCloudBridge = true;
  const SOURCE = "researchtube-cloud-binding", pending = new Set(), settled = new Map();
  window.addEventListener("message", event => {
    const value = event.data;
    if (value?.source !== SOURCE || value.type || !/^[a-f0-9-]{72}$/.test(value.nonce) || event.source === window) return;
    const frame = [...document.querySelectorAll("iframe")].find(candidate => candidate.contentWindow === event.source);
    if (!frame) return;
    let allowed = event.origin === "null";
    try { const url = new URL(event.origin); allowed ||= url.protocol === "https:" && (url.hostname === "web-sandbox.oaiusercontent.com" || url.hostname.endsWith(".web-sandbox.oaiusercontent.com")); } catch { /* opaque sandbox */ }
    if (!allowed || pending.has(value.nonce)) return;
    const reply = result => event.source.postMessage({ source: SOURCE, type: "result", nonce: value.nonce, ...result }, event.origin === "null" ? "*" : event.origin);
    if (settled.has(value.nonce)) { reply(settled.get(value.nonce)); return; }
    pending.add(value.nonce);
    Promise.resolve().then(() => chrome.runtime.sendMessage({ type: "researchtube_cloud_bind", nonce: value.nonce })).then(result => {
      const projected = { ok: result?.ok === true, ...(/^[A-Z][A-Z0-9_]{0,63}$/.test(result?.errorCode || "") ? { errorCode: result.errorCode } : {}) };
      settled.set(value.nonce, projected); if (settled.size > 128) settled.delete(settled.keys().next().value);
      reply(projected);
    }, () => reply({ ok: false })).finally(() => pending.delete(value.nonce));
  });
}
