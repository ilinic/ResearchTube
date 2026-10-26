import assert from "node:assert/strict";
import { createBrowserTimingSessions } from "../browser-timing-sessions.js";
import { browserToolDefinitions, validateBrowserInput } from "../browser-tools.js";
import { assertSchema } from "./fixtures/schema-check.mjs";

let clock = Date.parse("2026-10-27T00:00:00Z");
let saved = {};
const storage = {
  get: async () => structuredClone(saved),
  set: async value => { saved = structuredClone(value); }
};
const recorder = createBrowserTimingSessions({ storage, now: () => clock });
const definitions = browserToolDefinitions();
const schema = name => definitions.find(definition => definition.name === name).outputSchema;
const capture = await recorder.start({ chatTabId: 42, groupId: 75 });
assertSchema(schema("site_diagnostics_start"), capture);
assert.deepEqual(validateBrowserInput("site_diagnostics_start", { chatTabId: 42 }), { chatTabId: 42 });
assert.throws(() => validateBrowserInput("site_diagnostics_start", { chatTabId: 42, maxEvents: 10000 }));
clock += 100;
const requestId = "d6a6f818-0b71-4e47-878e-1105f44d3f6b";
recorder.timing({chatTabId:42,requestId,stage:"worker.received",event:"stamp",atMs:clock-80,url:"https://private.test/SECRET"});
recorder.timing({chatTabId:42,requestId,stage:"room.forwarded",event:"stamp",atMs:clock-40});
recorder.timing({chatTabId:42,requestId,stage:"extension.received",event:"stamp",atMs:clock});
recorder.timing({groupId:75,stage:"page.actionStep",event:"end",stepIndex:0,action:"type",elapsedMs:42,text:"SECRET SEARCH"});

let handle = await recorder.beginTool({ chatTabId: 42, tabId: 55, tool: "site_interact", action: "type", text: "SECRET SEARCH" });
clock += 75;
recorder.timing({ groupId: 75, stage: "tool.site_interact", event: "end", elapsedMs: 75, tabId: 55,
  url: "https://aliexpress.com/?token=SECRET", prompt: "SECRET", method: "Runtime.evaluate" });
recorder.timing({ groupId: 999, stage: "unrelated", event: "end", elapsedMs: 20 });
await recorder.endTool(handle);
clock += 8_000;
handle = await recorder.beginTool({ chatTabId: 42, tabId: 55, tool: "site_interact", action: "key", key: "Enter" });
clock += 36;
await recorder.endTool(handle);
let report = await recorder.report({ chatTabId: 42, stop: false });
assertSchema(schema("site_diagnostics_report"), report);
assert.equal(report.completedCalls, 2);
assert.equal(report.interCallGaps, 1);
assert.match(report.reportMarkdown, /GAP 8000 ms.*site_interact:type → site_interact:key/);
assert.match(report.reportMarkdown, /75 ms · tool.site_interact/);
assert.match(report.reportMarkdown, /page\.actionStep #1 type.*42 ms/);
assert.match(report.reportMarkdown, /Cloudflare ↔ extension UTC timeline/);
assert.match(report.reportMarkdown, /room\.forwarded.*Δ 40 ms/);
assert.doesNotMatch(report.reportMarkdown, /SECRET|token|aliexpress|unrelated|Runtime\.evaluate.*SECRET/);
assert.equal(report.recording, true);

// A new MV3 worker can resume the already persisted diagnostic session.
const restarted = createBrowserTimingSessions({ storage, now: () => clock });
restarted.timing({chatTabId:42,requestId,stage:"room.responded",event:"stamp",atMs:clock});
await new Promise(resolve=>setImmediate(resolve));
const persistedStamp = await createBrowserTimingSessions({ storage, now: () => clock }).report({ chatTabId: 42, stop: false });
assert.match(persistedStamp.reportMarkdown, /room\.responded/, 'the last Cloudflare stamp persists independently of report');
report = await restarted.report({ chatTabId: 42, stop: true });
assert.equal(report.completedCalls, 2);
assert.equal(report.recording, false);
assert.match(report.reportMarkdown, /room\.responded/);
assert.equal((await restarted.beginTool({ chatTabId: 42, tool: "site_read" })), null);
await assert.rejects(restarted.report({ chatTabId: 999 }), { code: "BROWSER_DIAGNOSTICS_NOT_FOUND" });

// A tiny ring limit is disallowed, and the bounded default excludes old events.
await assert.rejects(recorder.start({ chatTabId: 42, groupId: 75, maxEvents: 2 }));
await recorder.start({ chatTabId: 42, groupId: 75, maxEvents: 100 });
for (let index = 0; index < 80; index++) {
  handle = await recorder.beginTool({ chatTabId: 42, tabId: 55, tool: "site_read" });
  clock += 1; await recorder.endTool(handle);
}
report = await recorder.report({ chatTabId: 42 });
assert.ok(report.droppedEvents > 0);
assert.ok(report.reportMarkdown.length < 30_000);
console.log("Browser timing capture: explicit start/report, inter-call gaps, privacy, persistence, limits: ok");
