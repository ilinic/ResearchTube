import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const bundle = await readFile(new URL("../dist/background.js", import.meta.url), "utf8");
const settings = await readFile(new URL("../settings.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function worker(script, initial = {}) {
  const data = { ...initial }, badges = [], timers = new Map(), requests = [];
  let response = async () => ({ status: 204, ok: true });
  const context = {
    DEFAULTS: { tunnelId: "", runtimeApiKey: "", lastTunnelConnection: null, lastConnectionTest: null, agentPort: 17843 },
    EXTENSION_VERSION: "test", REQUIRED_AGENT_INTERFACE_VERSION: 78, CONTROL_PLANE_BASE_URL: "https://api.openai.com",
    POLL_RETRY_DELAY_MS: 10, AbortController, Date, consoleAction() {}, cameraRecordingBadgeKind: null,
    chrome: { storage: { local: {
      get: async defaults => ({ ...defaults, ...structuredClone(data) }),
      set: async changes => Object.assign(data, structuredClone(changes)),
    } } },
    fetch: async (url, options) => { requests.push({ url, options }); return response(url, options); },
    setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    setActionBadge: async state => badges.push(state),
    normalizeAgentPort: port => Number(port) || 17843, getAgentStatus: async () => null,
    handleMcpRequest: async () => { throw Error("Unexpected stale command dispatch"); },
    postResponse: async () => { throw Error("Unexpected stale response"); },
  };
  const state = script.slice(script.indexOf("async function getConfig()"), script.indexOf("function normalizeAgentPort("));
  const transport = script.slice(script.indexOf("function updateConnection("), script.indexOf("async function postResponse("));
  const testing = script.slice(script.indexOf("async function refreshActionBadge()"), script.indexOf("async function configuredImageWidgetTimeout()"));
  vm.runInNewContext(`let polling=false, connectionRevision=0, currentPollRevision=-1, connectionUpdateTail=Promise.resolve(), tunnelPollController=null, currentPollPromise=null, pollLoopTimer=null, pollLoopScheduled=false;\n${state}\n${transport}\n${testing}`, context);
  return { context, data, badges, timers, requests, respond: fn => { response = fn; } };
}

for (const script of [source, bundle]) {
  // Each explicit empty field is persisted, while omitted fields preserve data.
  for (const fields of [{ tunnelId: "", apiKey: "sk-PRIVATE" }, { tunnelId: "tunnel_test", apiKey: "" }, { tunnelId: "", apiKey: "" }]) {
    const w = worker(script, { tunnelId: "tunnel_test", runtimeApiKey: "sk-PRIVATE", onboardingCompleted: true, lastConnectionTest: { success: true } });
    assert.equal((await w.context.saveConnection(fields)).ok, true);
    assert.equal(w.data.tunnelId, fields.tunnelId); assert.equal(w.data.runtimeApiKey, fields.apiKey);
    assert.equal(w.data.onboardingCompleted, false);
    const tested = await w.context.testConnection();
    assert.equal(tested.ok, false);
    assert.equal(w.requests.length, 0, "incomplete settings never call OpenAI");
    assert.equal((await w.context.getPublicConnectionState({ includeAgent: false })).connection.state, "not-configured");
    assert.notEqual(w.badges.at(-1), "ready");
  }
  const ready = worker(script);
  await ready.context.saveConnection({ tunnelId: " tunnel_test ", apiKey: " sk-PRIVATE " });
  assert.equal(ready.data.runtimeApiKey, "sk-PRIVATE");
  assert.equal((await ready.context.getPublicConnectionState({ includeAgent: false })).connection.state, "unchecked");
  assert.equal((await ready.context.testConnection()).ok, true);
  assert.equal(ready.data.onboardingCompleted, true);
  assert.equal(ready.badges.at(-1), "ready");
  assert.equal((await ready.context.getPublicConnectionState({ includeAgent: false })).connection.state, "ready");
  await ready.context.saveConnection({ onboardingCompleted: true });
  assert.equal(ready.data.runtimeApiKey, "sk-PRIVATE");
  assert.equal(ready.data.tunnelId, "tunnel_test");
  assert.equal(ready.data.lastConnectionTest.success, true, "metadata-only saves preserve the result");
  const publicStatus = await ready.context.getPublicConnectionState({ includeAgent: false });
  assert.equal(publicStatus.apiKeyPresent, true);
  assert.doesNotMatch(JSON.stringify(publicStatus), /sk-PRIVATE|runtimeApiKey/);

  ready.respond(async () => ({ status: 401, ok: false }));
  assert.equal((await ready.context.testConnection()).errorCode, "API_KEY_INVALID");
  assert.equal(ready.badges.at(-1), "connection-error");
  assert.equal((await ready.context.getPublicConnectionState({ includeAgent: false })).connection.errorCode, "API_KEY_INVALID");
  ready.respond(async () => ({ status: 204, ok: true }));
  await ready.context.pollOnce();
  assert.equal((await ready.context.getPublicConnectionState({ includeAgent: false })).connection.state, "ready", "a successful background poll recovers a failed manual test");

  // Clearing a credential aborts its old long poll. Late success/failure and
  // already-received commands cannot restore status or execute after the save.
  for (const outcome of ["success", "failure", "commands"]) {
    const w = worker(script, { tunnelId: "tunnel_test", runtimeApiKey: "sk-PRIVATE" });
    let resolveFetch, rejectFetch;
    w.respond(() => new Promise((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject; }));
    const old = w.context.testConnection();
    await new Promise(resolve => setImmediate(resolve));
    await w.context.saveConnection({ apiKey: "" });
    assert.equal(w.requests[0].options.signal.aborted, true);
    assert.equal(w.timers.size, 0);
    if (outcome === "failure") rejectFetch(Error("network"));
    else resolveFetch({ status: outcome === "success" ? 204 : 200, ok: true, json: async () => ({ commands: [{ command_type: "jsonrpc", jsonrpc: {} }] }) });
    assert.equal((await old).errorCode, "CONNECTION_CHANGED");
    assert.equal(w.data.lastConnectionTest, null);
    assert.equal(w.data.lastTunnelConnection, null);
    assert.equal(w.data.runtimeApiKey, "");
    assert.equal((await w.context.getPublicConnectionState({ includeAgent: false })).connection.errorCode, "API_KEY_MISSING");
    assert.notEqual(w.badges.at(-1), "ready");
  }
  const changed = worker(script, { tunnelId: "tunnel_old", runtimeApiKey: "sk-OLD" });
  let releaseOld;
  changed.respond(() => new Promise(resolve => { releaseOld = resolve; }));
  const first = changed.context.pollOnce(); await new Promise(resolve => setImmediate(resolve));
  await changed.context.saveConnection({ tunnelId: "tunnel_new", apiKey: "sk-NEW" });
  changed.respond(async () => ({ status: 204, ok: true }));
  const second = changed.context.testConnection();
  releaseOld({ status: 204, ok: true }); await first;
  assert.equal((await second).ok, true);
  assert.equal(changed.requests.length, 2);
  assert.match(changed.requests[1].url, /tunnel_new/);
  assert.equal(changed.requests[1].options.headers.Authorization, "Bearer sk-NEW");
}

function ui(script, sendMessage, storage = {}) {
  const elements = new Map(); let storageListener;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", hidden: false, className: "", disabled: false, listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; }, replaceChildren() {}, append() {}, innerHTML: "" });
    return elements.get(id);
  };
  const context = { document: { getElementById: element, querySelectorAll: () => [], createElement: () => element(Symbol()) },
    console, URL, window: { close() {} }, setTimeout, navigator: { clipboard: { writeText: async () => {} } },
    chrome: { tabs: { query: async () => [] }, runtime: { sendMessage, openOptionsPage() {} },
      storage: { local: { get: async () => storage }, onChanged: { addListener: listener => { storageListener = listener; } } } } };
  vm.runInNewContext(script, context);
  return { context, element, notify: changes => storageListener(changes, "local") };
}
let calls = [], failSave = false, throwTest = false;
const s = ui(settings, async message => {
  calls.push(plain(message));
  if (message.type === "status") return { tunnelId: "tunnel_test", agentPort: 17843 };
  if (message.type === "save-connection") return { ok: !failSave };
  if (message.type === "test-connection") { if (throwTest) throw Error("offline"); return { ok: true }; }
  return { ok: false };
}, { runtimeApiKey: "sk-PRIVATE" });
await new Promise(resolve => setImmediate(resolve));
assert.equal(s.element("api-key").value, "sk-PRIVATE");
for (const fields of [{ tunnelId: "", apiKey: "sk-PRIVATE" }, { tunnelId: "tunnel_test", apiKey: "" }, { tunnelId: "", apiKey: "" }]) {
  s.element("tunnel-id").value = fields.tunnelId; s.element("api-key").value = fields.apiKey; calls = [];
  await s.element("test-connection").listeners.click();
  assert.deepEqual(calls.map(message => message.type), ["save-connection", "test-connection"]);
  assert.deepEqual(calls[0].payload, fields);
  assert.equal(s.element("api-key").value, fields.apiKey, "success does not empty or replace the actual key field");
  assert.equal(s.element("test-connection").disabled, false);
}
failSave = true; calls = []; await s.element("test-connection").listeners.click();
assert.deepEqual(calls.map(message => message.type), ["save-connection"]);
failSave = false; throwTest = true; await s.element("test-connection").listeners.click();
assert.equal(s.element("test-connection").disabled, false);

let state = { configured: false, connection: { state: "not-configured", errorCode: "NOT_CONFIGURED" } };
const p = ui(popup, async message => message.type === "status" ? state : { available: false });
await new Promise(resolve => setImmediate(resolve));
assert.equal(p.element("tunnel-status").textContent, "Not configured");
for (const [connection, text, style] of [
  [{ state: "not-configured", errorCode: "API_KEY_MISSING" }, "API key missing", "bad"],
  [{ state: "not-configured", errorCode: "TUNNEL_ID_MISSING" }, "Tunnel ID missing", "bad"],
  [{ state: "unchecked", errorCode: null }, "Not tested", "warn"],
  [{ state: "error", errorCode: "API_KEY_INVALID" }, "API key rejected", "bad"],
  [{ state: "error", errorCode: "NETWORK_ERROR" }, "Network error", "bad"],
  [{ state: "ready", errorCode: null }, "tunnel_test", "good"],
]) {
  state = { configured: true, tunnelId: "tunnel_test", connection };
  p.notify({ lastTunnelConnection: {} }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.element("tunnel-status").textContent, text); assert.equal(p.element("tunnel-status").className, style);
}
const pendingReads = [];
const stalePopup = ui(popup, message => message.type === "status" ? new Promise(resolve => pendingReads.push(resolve)) : Promise.resolve({ available: false }));
await new Promise(resolve => setImmediate(resolve));
stalePopup.notify({ runtimeApiKey: {} });
pendingReads[1]({ configured: false, connection: { state: "not-configured", errorCode: "API_KEY_MISSING" } });
await new Promise(resolve => setImmediate(resolve));
pendingReads[0]({ configured: true, tunnelId: "tunnel_old", connection: { state: "ready" } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(stalePopup.element("tunnel-status").textContent, "API key missing", "initial popup read cannot overwrite newer saved state");
stalePopup.notify({ lastTunnelConnection: {} });
stalePopup.notify({ lastTunnelConnection: {} });
pendingReads[3]({ configured: false, connection: { state: "not-configured", errorCode: "NOT_CONFIGURED" } });
await new Promise(resolve => setImmediate(resolve));
pendingReads[2]({ configured: true, tunnelId: "tunnel_old", connection: { state: "ready" } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(stalePopup.element("tunnel-status").textContent, "Not configured", "older notification read cannot overwrite a newer reset");
console.log("Connection state: explicit clears, masked key editing, save before test, status/badge recovery, stale polls, credential replacement, source/shipped worker and live popup updates: ok");
