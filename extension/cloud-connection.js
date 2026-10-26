// Public transport only. All actual tools still run through handleMcpRequest.

export const CLOUD_ORIGIN = "https://rtube.win";
const KEY = "researchtubeCloudCredential";
const SESSION_KEY = "researchtubeCloudEnrollment";
const DISABLED_KEY = "researchtubeCloudDisabled";
const SIGN_IN_KEY = "researchtubeCloudSignInRequired";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SECRET = /^[a-f0-9-]{72}$/;
const SOURCE_TABS = new Set(["site_read", "site_get_children", "site_get_node", "site_get_text", "site_interact", "site_get_images", "site_get_files", "system_get_diagnostics"]);
const fail = (code, message) => Object.assign(new Error(message), { code });
export function cloudConversation(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com") return null;
    return /\/c\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}
// Executed only in Chrome's isolated top document; Chrome supplies documentId.
export function cloudDocumentSnapshot() { return { url: location.href }; }

export function createCloudConnection(host) {
  const base = host.origin || CLOUD_ORIGIN;
  let socket = null, opening = null, retryTimer = null, heartbeat = null, generation = 0, attempts = 0, nextRetryAt = 0;
  let openedAt = 0, lastPong = 0, state = "not-configured", errorCode = null;
  const bindings = new Map(), requests = new Map(), pending = new Set(), seen = new Set();
  let automatic = null, accountOpening = null, accountRetryAt = 0;
  const now = () => host.now?.() ?? Date.now();
  // Defer browser API access until an operation runs (also permits catalog
  // export to instantiate the module without browser/storage authority).
  const local = Object.fromEntries(["get", "set", "remove"].map(name => [name, (...args) => host.chrome.storage.local[name](...args)]));
  const session = Object.fromEntries(["get", "set", "remove"].map(name => [name, (...args) => host.chrome.storage.session[name](...args)]));
  const config = async () => (await local.get({ [KEY]: null }))[KEY];
  async function publish(next, code = null) {
    state = next; errorCode = code;
    await local.set({ cloudConnectionStatus: { state, errorCode } });
    await host.changed?.();
  }
  async function status() { return { state, errorCode, configured: Boolean((await config())?.installationToken), serverUrl: base }; }
  async function api(path, body, credential) {
    const response = await host.fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential.installationToken },
      body: JSON.stringify(body), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw fail(response.status === 401 || response.status === 403 ? "EXTENSION_AUTHENTICATION_REQUIRED" : "CLOUD_UNAVAILABLE", "The ResearchTube server could not complete this connection request.");
    const reader = response.body?.getReader();
    if (!reader) throw fail("CLOUD_INVALID_RESPONSE", "The connection response is empty.");
    let text = "", size = 0; const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); throw fail("CLOUD_INVALID_RESPONSE", "The connection response is too large."); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } catch (error) { throw error.code ? error : fail("CLOUD_INVALID_RESPONSE", "The connection response is invalid."); }
    finally { reader.releaseLock(); }
  }
  async function readTarget(tabId) {
    const tab = await host.chrome.tabs.get(tabId);
    const results = await host.chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: cloudDocumentSnapshot });
    const top = results?.find(result => result.frameId === 0);
    const conversationId = cloudConversation(top?.result?.url);
    if (!conversationId || cloudConversation(tab.url) !== conversationId || typeof top.documentId !== "string" || !top.documentId)
      throw fail("BROWSER_CONTEXT_REQUIRED", "Open a saved ChatGPT conversation in desktop Chrome.");
    const copies = (await host.chrome.tabs.query({})).filter(other => cloudConversation(other.url) === conversationId);
    if (copies.length !== 1 || copies[0].id !== tabId) throw fail("BROWSER_CONTEXT_AMBIGUOUS", "Close duplicate copies of this conversation before connecting.");
    return { tabId, documentId: top.documentId, conversationId };
  }
  function live(target) {
    const bound = bindings.get(target?.bindingId);
    if (!bound || bound.expiresAt <= now() || !socket || socket.readyState !== 1 ||
        bound.tabId !== target.tabId || bound.documentId !== target.documentId || bound.conversationId !== target.conversationId)
      throw fail("BROWSER_TARGET_CHANGED", "The original browser context ended. No alternate destination was selected.");
  }
  async function verifyTarget(target) {
    live(target);
    const current = await readTarget(target.tabId);
    live(target);
    if (current.documentId !== target.documentId || current.conversationId !== target.conversationId) {
      invalidate(target.bindingId);
      throw fail("BROWSER_TARGET_MISMATCH", "The original ChatGPT document changed. Check the extension connection.");
    }
    live(target);
    return current;
  }
  function invalidate(id) {
    const target = bindings.get(id);
    bindings.delete(id);
    if (target) void host.invalidated?.(target);
  }
  function invalidateAll() { for (const id of [...bindings.keys()]) invalidate(id); }
  function stopSocket() {
    const old = socket; socket = null;
    if (heartbeat !== null) host.clearInterval(heartbeat); heartbeat = null;
    invalidateAll(); seen.clear();
    old?.close();
  }
  function retry() {
    if (retryTimer !== null) return;
    const delay = Math.min(60000, 5000 * 2 ** Math.min(attempts++, 4)) + Math.floor((host.random?.() ?? Math.random()) * 1000);
    nextRetryAt = now() + delay;
    retryTimer = host.setTimeout(() => { retryTimer = null; void ensureAccount(); }, delay);
  }
  async function start() {
    if (opening || socket) return opening;
    opening = (async () => {
      const revision = generation;
      if (now() < nextRetryAt) return;
      const credential = await config();
      if (revision !== generation) return;
      if (!credential || credential.revoked) { await publish(credential ? "error" : "not-configured", credential ? credential.revokedCode || "EXTENSION_AUTHENTICATION_REQUIRED" : null); return; }
      await publish("connecting");
      try {
        const ticket = await api("/api/relay-ticket", {}, credential);
        if (revision !== generation) return;
        if (!SECRET.test(ticket.ticket) || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= now()) throw fail("CLOUD_INVALID_RESPONSE", "The relay ticket is invalid.");
        if (ticket.capabilities?.directTools !== 1) throw fail("EXTENSION_UPDATE_REQUIRED", "Update the ResearchTube server to support direct tools.");
        const ws = host.webSocket(base.replace(/^https:/, "wss:") + "/relay?ticket=" + encodeURIComponent(ticket.ticket));
        socket = ws;
        let announced = false;
        const announceReady = () => {
          if (announced || socket !== ws || revision !== generation) return;
          announced = true; host.clearTimeout(openingTimeout);
          void publish("ready");
        };
        const openingTimeout = host.setTimeout(() => { if (socket === ws && !announced) ws.close(); }, 15000);
        ws.onopen = () => {
          if (socket !== ws || revision !== generation) { ws.close(); return; }
          openedAt = lastPong = now(); attempts = 0; nextRetryAt = 0;
          ws.send("direct-tools-v1");
          heartbeat = host.setInterval(() => {
            if (socket !== ws) return;
            if (now() - lastPong > 60000 || now() - openedAt > 55 * 60000 && !pending.size) { ws.close(); return; }
            try { ws.send("ping"); } catch { ws.close(); }
          }, 20000);
        };
        ws.onmessage = event => {
          if (socket !== ws || revision !== generation) return;
          if (event.data === "pong") { lastPong = now(); return; }
          if (event.data === "direct-tools-ready") { announceReady(); return; }
          void receive(event.data, ws, credential).catch(() => ws.close());
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          host.clearTimeout(openingTimeout);
          if (socket !== ws) return;
          stopSocket(); void publish("offline", "CLOUD_DISCONNECTED"); retry();
        };
      } catch (error) {
        if (revision !== generation) return;
        if (error.code === "EXTENSION_AUTHENTICATION_REQUIRED") {
          await local.set({ [KEY]: { ...credential, revoked: true } });
          await publish("error", error.code);
        } else if (error.code === "EXTENSION_UPDATE_REQUIRED") { await publish("error", error.code); }
        else { await publish("offline", "CLOUD_UNAVAILABLE"); retry(); }
      }
    })().finally(() => { opening = null; });
    return opening;
  }
  async function receive(data, ws, credential) {
    if (typeof data !== "string" || new TextEncoder().encode(data).length > 1048576) throw fail("CLOUD_PROTOCOL_ERROR", "Invalid relay message.");
    const message = JSON.parse(data), requestGeneration = generation;
    if (message.type === "disconnect" && message.code === "EXTENSION_REPLACED" && Object.keys(message).length === 2) {
      generation++; stopSocket();
      if (retryTimer !== null) host.clearTimeout(retryTimer); retryTimer = null;
      await local.set({ [KEY]: { ...credential, revoked: true, revokedCode: "EXTENSION_REPLACED" } });
      await publish("error", "EXTENSION_REPLACED"); return;
    }
    if (message.type !== "request" || Object.keys(message).some(key => !["type", "requestId", "installationId", "request"].includes(key)) ||
        !UUID.test(message.requestId) || message.installationId !== credential.installationId ||
        !message.request || Object.keys(message.request).some(key => !["jsonrpc", "method", "params"].includes(key)) ||
        message.request.jsonrpc !== "2.0" || message.request.method !== "tools/call" ||
        !message.request.params || Object.keys(message.request.params).some(key => !["name", "arguments"].includes(key)) ||
        typeof message.request.params.name !== "string" || !message.request.params.arguments || typeof message.request.params.arguments !== "object" || Array.isArray(message.request.params.arguments))
      throw fail("CLOUD_PROTOCOL_ERROR", "Invalid relay request.");
    if (seen.has(message.requestId)) return;
    seen.add(message.requestId);
    if (seen.size > 4096 || pending.size >= 100) { ws.close(); return; }
    pending.add(message.requestId);
    let response;
    try {
      const { name, arguments: args } = message.request.params;
      if (!await host.accepts(name, args)) throw fail("INVALID_ARGUMENT", "Arguments do not match an available tool.");
      if (socket !== ws || requestGeneration !== generation || ws.readyState !== 1) throw fail("EXTENSION_OFFLINE", "The extension connection ended.");
      const tabId = args.chatTabId ?? (!SOURCE_TABS.has(name) ? args.tabId : undefined);
      if ((args.addToChat === true || name === "media_view" || name === "system_get_chat_context") && tabId === undefined)
        throw fail("BROWSER_CONTEXT_REQUIRED", "Provide the exact ChatGPT tabId from the startup prompt. No other tab was selected.");
      let target = null;
      if (tabId !== undefined) {
        if (!Number.isSafeInteger(tabId) || tabId < 0) throw fail("INVALID_ARGUMENT", "The ChatGPT tabId must be a nonnegative integer.");
        const revision = generation;
        const snapshot = await readTarget(tabId);
        if (socket !== ws || revision !== generation) throw fail("EXTENSION_OFFLINE", "The extension connection ended.");
        target = [...bindings.values()].find(value => value.tabId === tabId && value.documentId === snapshot.documentId && value.conversationId === snapshot.conversationId && value.expiresAt > now());
        if (!target) {
          for (const [id, value] of bindings) if (value.tabId === tabId || value.expiresAt <= now()) invalidate(id);
          if (bindings.size >= 200) throw fail("BROWSER_BUSY", "Too many chat targets are in use.");
          target = { ...snapshot, bindingId: host.uuid(), expiresAt: now() + 3600000 };
          bindings.set(target.bindingId, target);
        }
        requests.set(message.requestId, target);
      }
      const result = await host.dispatch({ jsonrpc: "2.0", id: message.requestId, method: "tools/call", params: message.request.params });
      if (target) await verifyTarget(target);
      response = result?.error ? { error: { code: -32603, message: "The extension could not complete this request." } } : { result: result.result };
    } catch (error) {
      response = error?.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? { result: { isError: true, content: [{ type: "text", text: "The requested operation could not run." }], structuredContent: { error: { code: error.code, message: error.code === "BROWSER_CONTEXT_REQUIRED" ? "Provide the exact ChatGPT tabId from the startup prompt. No other tab was selected." : "The requested tool or exact browser target is unavailable. No alternate tab was selected." } } } }
        : { error: { code: -32000, message: "The extension could not complete this request." } };
    }
    finally { requests.delete(message.requestId); pending.delete(message.requestId); }
    if (socket !== ws || ws.readyState !== 1) return;
    const payload = { type: "response", requestId: message.requestId, ...response };
    const text = JSON.stringify(payload);
    ws.send(new TextEncoder().encode(text).length <= 1048576 ? text : JSON.stringify({ type: "response", requestId: message.requestId,
      error: { code: -32000, message: "The response exceeded the relay limit. Request a smaller result." } }));
  }
  async function finishAutomatic(error = null) {
    const current = automatic; if (!current) return;
    automatic = null; host.clearTimeout(current.timer);
    const stored = (await session.get({ [SESSION_KEY]: null }))[SESSION_KEY];
    if (stored?.nonce === current.nonce) await session.remove(SESSION_KEY);
    // Let the private external-message acknowledgement reach the setup page
    // before closing it; otherwise its failed-receipt cleanup could revoke a
    // credential we have just accepted.
    if (Number.isInteger(current.tabId)) host.setTimeout(() => { void host.chrome.tabs.remove(current.tabId).catch(() => {}); }, 100);
    if (error) current.reject(error); else current.resolve();
    if (error) await publish("error", error.code || "CLOUD_UNAVAILABLE");
  }
  async function autoEnroll() {
    if (automatic) return automatic.promise;
    const nonce = host.uuid();
    const transaction = { nonce, tabId: null };
    transaction.promise = new Promise((resolve, reject) => { transaction.resolve = resolve; transaction.reject = reject; });
    void transaction.promise.catch(() => {});
    automatic = transaction;
    transaction.timer = host.setTimeout(() => { void finishAutomatic(fail("CLOUD_UNAVAILABLE", "Automatic connection timed out. Check the extension popup.")); }, 25000);
    try { await beginEnrollment({ automatic: true, transaction }); }
    catch (error) { await finishAutomatic(error); }
    return transaction.promise;
  }
  async function ensureAccount() {
    if ((await local.get({ [DISABLED_KEY]: false }))[DISABLED_KEY]) return;
    // A revoked profile stays stopped. In particular it must never take the
    // account back from the extension that replaced it.
    const credential = await config();
    if (credential?.revoked) return start();
    if (host.profileStatus && (await host.profileStatus()).state === "signed-out") {
      generation++; stopSocket(); await publish("error", "BROWSER_SIGN_IN_REQUIRED"); return;
    }
    if (credential) return start();
    if ((await local.get({ [SIGN_IN_KEY]: false }))[SIGN_IN_KEY]) { await publish("error", "BROWSER_SIGN_IN_REQUIRED"); return; }
    if (accountOpening || now() < accountRetryAt) return accountOpening;
    accountRetryAt = now() + 60000;
    await publish("connecting");
    accountOpening = autoEnroll().catch(() => {}).finally(() => { accountOpening = null; });
    return accountOpening;
  }
  async function beginEnrollment(options = {}) {
    if (!options.automatic) await finishAutomatic(fail("ENROLLMENT_INVALID", "Automatic pairing was replaced."));
    const nonce = options.transaction?.nonce || host.uuid();
    const url = base + "/setup?" + new URLSearchParams({ extensionId: host.chrome.runtime.id, nonce });
    const tab = await host.chrome.tabs.create({ url: "about:blank", active: !options.automatic });
    if (options.transaction) options.transaction.tabId = tab.id;
    await session.set({ [SESSION_KEY]: { nonce, tabId: tab.id, expiresAt: now() + (options.automatic ? 25000 : 10 * 60000),
      ...(options.automatic ? { automatic: true } : {}) } });
    // Persist the challenge before navigation so even a cached setup page can
    // authenticate its first message without racing storage initialization.
    await host.chrome.tabs.update(tab.id, { url });
    return { ok: true };
  }
  let enrollmentTail = Promise.resolve();
  function external(message, sender) {
    if (message?.type === "researchtube_account_ready") {
      let url; try { url = new URL(sender?.url); } catch { /* refused below */ }
      if (Object.keys(message).length !== 1 || sender?.id || sender?.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
          url?.origin !== base || !["/consent", "/account"].includes(url.pathname))
        return Promise.reject(fail("ENROLLMENT_INVALID", "Invalid account notification."));
      accountRetryAt = 0;
      void local.set({ [SIGN_IN_KEY]: false }).then(() => ensureAccount());
      return Promise.resolve({ ok: true });
    }
    const work = enrollmentTail.catch(() => {}).then(async () => {
      const fields = message?.type === "researchtube_setup_ready" ? ["type", "nonce"] : message?.type === "researchtube_setup_failed" ? ["type", "nonce", "errorCode"] : ["type", "nonce", "installationId", "installationToken"];
      if (!message || Object.keys(message).some(key => !fields.includes(key))) throw fail("ENROLLMENT_INVALID", "Invalid setup message.");
      const pending = (await session.get({ [SESSION_KEY]: null }))[SESSION_KEY];
      let url; try { url = new URL(sender?.url); } catch { /* refused below */ }
      if (!pending || pending.expiresAt <= now() || pending.nonce !== message.nonce || sender?.id || sender?.frameId !== 0 ||
          sender.tab?.id !== pending.tabId || url?.origin !== base || url.pathname !== "/setup" || url.searchParams.get("nonce") !== pending.nonce || url.searchParams.get("extensionId") !== host.chrome.runtime.id)
        throw fail("ENROLLMENT_INVALID", "Check the extension connection in ChatGPT.");
      if (message.type === "researchtube_setup_ready") return { ok: true, extensionOrigin: "chrome-extension://" + host.chrome.runtime.id,
        ...(pending.automatic ? { automatic: true } : {}) };
      if (message.type === "researchtube_setup_failed" && pending.automatic) {
        const code = ["BROWSER_SIGN_IN_REQUIRED", "BROWSER_ACCOUNT_MISMATCH"].includes(message.errorCode) ? message.errorCode : "CLOUD_UNAVAILABLE";
        if (code === "BROWSER_SIGN_IN_REQUIRED") await local.set({ [SIGN_IN_KEY]: true });
        await finishAutomatic(fail(code, "Automatic extension pairing needs this browser's matching ResearchTube sign-in."));
        return { ok: true };
      }
      if (message.type !== "researchtube_setup_complete" || !UUID.test(message.installationId) || !SECRET.test(message.installationToken))
        throw fail("ENROLLMENT_INVALID", "The installation credential is invalid.");
      // Validate the server-issued credential before replacing this profile.
      const credential = { installationId: message.installationId, installationToken: message.installationToken };
      const revision = generation;
      const checked = await api("/api/installation/check", {}, credential);
      if (checked.installationId !== credential.installationId) throw fail("ENROLLMENT_INVALID", "The installation does not match its credential.");
      const current = (await session.get({ [SESSION_KEY]: null }))[SESSION_KEY];
      if (revision !== generation || current?.nonce !== pending.nonce || current.expiresAt <= now()) throw fail("ENROLLMENT_INVALID", "The pairing was cancelled or replaced.");
      const previous = await config();
      if (previous) await api("/api/installation/revoke", {}, previous).catch(() => {});
      if (revision !== generation) throw fail("ENROLLMENT_INVALID", "The pairing was cancelled.");
      generation++; stopSocket(); nextRetryAt = 0;
      await local.set({ [KEY]: credential, [DISABLED_KEY]: false, [SIGN_IN_KEY]: false });
      await session.remove(SESSION_KEY);
      await opening?.catch(() => {});
      await start();
      if (pending.automatic) await finishAutomatic();
      return { ok: true };
    });
    enrollmentTail = work.catch(() => {}); return work;
  }
  async function disconnect() {
    await finishAutomatic(fail("ENROLLMENT_INVALID", "The extension was disconnected."));
    const credential = await config();
    generation++; stopSocket();
    if (retryTimer !== null) host.clearTimeout(retryTimer); retryTimer = null;
    await local.set({ [DISABLED_KEY]: true });
    await local.remove(KEY); await session.remove(SESSION_KEY); await publish("not-configured");
    if (credential) {
      try { await api("/api/installation/revoke", {}, credential); }
      catch { return { ok: true, remoteRevocationPending: true }; }
    }
    return { ok: true };
  }
  async function tabChanged(tabId) {
    for (const [id, target] of [...bindings]) if (target.tabId === tabId) {
      invalidate(id);
    }
  }
  async function suspend() { generation++; stopSocket(); if (retryTimer !== null) host.clearTimeout(retryTimer); retryTimer = null; nextRetryAt = 0; }
  return { start, ensureAccount, status, external, beginEnrollment, disconnect, suspend, tabChanged, verifyTarget,
    targetForRequest: id => requests.get(id) || null, assertLive: live };
}
