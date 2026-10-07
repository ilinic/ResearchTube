import assert from "node:assert/strict";
import { createBrowserDiagnostics } from "../browser-diagnostics.js";

let clock = 0;
const logs = [];
const trace = createBrowserDiagnostics({ enabled: true, sessionId: "bas_abcdefghij", now: () => clock, log: (label, value) => logs.push({ label, ...value }) });
const finish = trace.begin("page.read");
clock = 15;
const payload = { url: "https://private.test/?signed=SECRET", text: "PRIVATE PAGE", bytes: new Uint8Array([1, 2]) };
assert.equal(await trace.command("IO.read", async () => { clock += 100; return payload; }), payload);
await trace.command("IO.read", async () => { clock += 150; });
clock += 20;
finish({ outcome: "ok", url: payload.url, prompt: "PRIVATE PROMPT", rawResponse: payload, returnedNodes: 3 });
finish({ outcome: "duplicate" });
assert.equal(logs.filter(row => row.stage === "page.read" && row.event === "end").length, 1);
assert.equal(logs.find(row => row.event === "end").elapsedMs, 285);
assert.equal(logs.find(row => row.event === "cdp").count, 2);
assert.equal(logs.find(row => row.event === "cdp").elapsedMs, 250);
assert.equal(logs.find(row => row.event === "end").returnedNodes, 3);
assert.doesNotMatch(JSON.stringify(logs), /SECRET|PRIVATE|signed|rawResponse|prompt|https/);
await trace.command("Accessibility.getFullAXTree", async () => { clock += 300; });
assert.ok(logs.some(row => row.stage === "cdp.slow" && row.elapsedMs === 300));
const failure = Object.assign(Error("SECRET error message"), { code: "STALE_NODE" });
await assert.rejects(trace.span("page.failed", async () => { clock += 20; throw failure; }), error => error === failure);
assert.ok(logs.some(row => row.stage === "page.failed" && row.event === "end" && row.outcome === "failed" && row.code === "STALE_NODE"));
assert.doesNotMatch(JSON.stringify(logs), /SECRET/);

// Disabling diagnostics does not even call the diagnostic clock/logger.
const off = createBrowserDiagnostics({ enabled: false, now: () => { throw Error("clock called"); }, log: () => { throw Error("logger called"); } });
assert.equal(await off.span("off", () => 123), 123);
assert.equal(await off.command("IO.read", () => payload), payload);
off.event("off", payload); off.begin("off")();
await assert.rejects(off.span("off", () => { throw failure; }), error => error === failure);
const brokenConsole = createBrowserDiagnostics({ enabled: true, now: () => clock, log: () => { throw Error("console failure"); } });
assert.equal(await brokenConsole.span("console", () => 456), 456);
console.log("Browser diagnostics: durations, repeated CDP aggregation, private-data exclusion, disable switch and error transparency: ok");

trace.event("tab.state", { point: "resource.beforeSend", tabId: 42, windowId: 7, active: false, windowFocused: true, visibilityState: "hidden", hidden: true, hasFocus: true, readyState: "complete", url: "PRIVATE URL" });
const tabState = logs.find(row => row.stage === "tab.state");
assert.equal(tabState.point, "resource.beforeSend");
assert.equal(tabState.tabId, 42);
assert.equal(tabState.active, false);
assert.equal(tabState.visibilityState, "hidden");
assert.equal(tabState.readyState, "complete");
assert.doesNotMatch(JSON.stringify(tabState), /PRIVATE|url/);
