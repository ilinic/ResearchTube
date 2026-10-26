import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createChatContext } from "../chat-context.js";
import { createSystemDiagnostics } from "../system-diagnostics.js";
import { systemToolDefinitions, validateSystemInput } from "../system-tools.js";
import { createBrowserDiagnostics } from "../browser-diagnostics.js";
import { fixture } from "./fixtures/browser-agent-fixture.mjs";
import { assertSchema } from "./fixtures/schema-check.mjs";

const definitions = systemToolDefinitions("ui://widget");
const check = (name, value) => assertSchema(definitions.find(tool => tool.name === name).outputSchema, value);
function setup() {
  let clock = 0, sequence = 0;
  const f = fixture(), errors = [];
  // A user-created group: no popup, duplication, prompt or debugger attach.
  f.tabs.set(41, { id: 41, groupId: 80, url: "https://chatgpt.com/c/manual", title: "Chat" });
  f.tabs.set(42, { id: 42, groupId: 80, url: "https://forum.test/discussion", title: "Site" });
  const context = createChatContext({
    extensionId: "extension", now: () => clock, id: () => `tsk_${String(++sequence).padStart(10, "0")}`, token: () => webcrypto.randomUUID(),
    getTab: f.host.getTab, queryTabs: async () => [...f.tabs.values()], conversationPath: f.host.conversationPath,
    connect: (id, checkPending) => f.agent.connectGroup(id, checkPending), inspect: id => f.agent.execute("site_list_tabs", { chatTabId: id }), error: item => errors.push(item)
  });
  const sender = () => ({ id: "extension", tab: { ...f.tabs.get(41) } });
  return { ...f, context, sender, errors, advance: value => clock += value };
}
const f = setup(), ready = await f.context.direct(41);
check("system_get_chat_context", ready);
assert.equal(ready.status,"completed");assert.equal(ready.chatTabId,41);
assert.deepEqual(ready.group.tabs.map(tab=>tab.tabId),[41,42]);
assert.ok(!f.events.some(event=>["attach","duplicate","prompt","createChat"].includes(event[0])));
await f.agent.execute("site_session_stop",{chatTabId:41});
assert.equal((await f.context.direct(41)).group.state,"running","explicit resume only");
for(const kind of ["ungrouped","duplicate","closed","not-chat"]){
 const test=setup();
 if(kind==="ungrouped")test.tabs.get(41).groupId=-1;
 if(kind==="duplicate")test.tabs.set(44,{id:44,groupId:80,url:"https://chatgpt.com/c/manual"});
 if(kind==="closed")test.tabs.delete(41);
 if(kind==="not-chat")test.tabs.get(41).url="https://example.test/";
 await assert.rejects(test.context.direct(41),undefined,kind);
}
await assert.rejects(f.context.direct(undefined));
assert.equal(definitions[0]._meta,undefined);

let stored = [], writes = 0;
const options = { version: "fixture", capacity: 25, read: async () => stored, write: async value => { stored = structuredClone(value); writes++; } };
const diagnostics = createSystemDiagnostics(options);
await Promise.all(Array.from({ length: 40 }, (_, index) => diagnostics.append({
  timestamp: new Date(index * 1000).toISOString(), source: "tool", tool: index % 2 ? "site_read" : "media_probe", stage: "tools.call", code: "BROWSER_UNAVAILABLE",
  message: "Failed https://site.test/?signed=SECRET sk-secret123 token=SECRET C:\\Users\\private\\data.txt /Users/private/data.txt", tabId: index, taskId: "tsk_0000000001", rawPayload: "SECRET", bindingToken: "SECRET"
})));
const latest = await diagnostics.get(); check("system_get_diagnostics", latest);
assert.equal(latest.retained, 25); assert.equal(latest.returned, 20); assert.equal(latest.truncated, true);
assert.equal(latest.events[0].tabId, 39); assert.equal(writes, 40);
assert.doesNotMatch(JSON.stringify(latest), /SECRET|private|sk-secret|rawPayload|bindingToken/);
await diagnostics.append({ message: 'Failure: "bindingToken":"SECRET", "C:\\Users\\My Folder\\private.txt"' });
assert.doesNotMatch(JSON.stringify(await diagnostics.get()), /SECRET|My Folder|private/);
assert.equal((await diagnostics.get({ tool: "site_read", tabId: 39, taskId: "tsk_0000000001" })).returned, 1);
const restarted = createSystemDiagnostics(options);
assert.equal((await restarted.get()).events[1].tabId, 39);
await restarted.clear(); assert.equal((await restarted.get()).returned, 0);

// Detailed timings can be disabled without losing technical failure events.
const failures = [];
const trace = createBrowserDiagnostics({ enabled: false, now: () => { throw Error("timing disabled"); }, log: () => { throw Error("timing logger disabled"); }, onError: item => failures.push(item) });
await assert.rejects(trace.command("DOM.enable", () => { throw Error("SECRET PAGE"); }));
trace.event("target.attachFailed", { code: "BROWSER_DEBUGGER_RESTRICTED", tabId: 42, url: "SECRET" });
assert.equal(failures.length, 2); assert.doesNotMatch(JSON.stringify(failures), /SECRET/);

for (const value of [{ limit: 0 }, { limit: 101 }, { limit: true }, { tabId: -1 }, { taskId: "bad" }, { url: "https://test" }]) assert.throws(() => validateSystemInput("system_get_diagnostics", value));
assert.throws(() => validateSystemInput("system_get_chat_context", { cancel: true }));
assert.deepEqual(validateSystemInput("system_get_chat_context", { chatTabId: 41 }), { chatTabId: 41 });
assert.throws(() => validateSystemInput("system_get_chat_context", {}));

console.log("System tools: direct exact targets, manual groups, explicit resume and bounded sanitized diagnostics passed");
