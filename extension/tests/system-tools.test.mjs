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
const f = setup(), pending = await f.context.call({});
check("system_get_chat_context", pending);
assert.equal(pending.status, "working"); assert.equal(pending.group, null);
const metadata = f.context.metadata(pending.taskId);
assert.ok(metadata.bindingToken); assert.doesNotMatch(JSON.stringify(pending), /bindingToken/);
await assert.rejects(f.context.bind({ ...metadata, bindingToken: "wrong" }, f.sender()), error => error.code === "BROWSER_CONTEXT_INVALID");
await assert.rejects(f.context.bind(metadata, { ...f.sender(), id: "other" }), error => error.code === "BROWSER_CONTEXT_INVALID");
const ack = await f.context.bind(metadata, f.sender());
assert.equal(ack.ok, true);
const ready = await f.context.call({ taskId: pending.taskId });
check("system_get_chat_context", ready);
assert.equal(ready.chatTabId, 41); assert.equal(ready.group.groupId, 80);
assert.deepEqual(ready.group.tabs.map(tab => tab.tabId), [41, 42]);
assert.equal(ready.progressPercent, 100); assert.equal(f.context.metadata(pending.taskId), null);
assert.ok(!f.events.some(event => ["attach", "duplicate", "prompt", "createChat"].includes(event[0])));
assert.deepEqual(await f.context.bind(metadata, f.sender()), ack, "duplicate handshake only acknowledges");
f.tabs.set(43, { id: 43, groupId: 80, url: "https://forum.test/second", title: "Second" });
assert.equal((await f.context.call({ taskId: pending.taskId })).group.totalTabs, 3);
await f.agent.execute("site_session_stop", { chatTabId: 41 });
assert.equal((await f.context.call({ taskId: pending.taskId })).error.code, "BROWSER_SESSION_STOPPED", "polling cannot undo Stop");
const reconnect = await f.context.call({});
await f.context.bind(f.context.metadata(reconnect.taskId), f.sender());
assert.equal((await f.context.call({ taskId: reconnect.taskId })).group.state, "running");
f.tabs.get(41).groupId = 81;
assert.equal((await f.context.call({ taskId: reconnect.taskId })).error.code, "TAB_LEFT_GROUP");

for (const kind of ["ungrouped", "duplicate", "closed", "changed", "cancelled", "timeout"]) {
  const test = setup(), task = await test.context.call({}), meta = test.context.metadata(task.taskId);
  if (kind === "ungrouped") test.tabs.get(41).groupId = -1;
  if (kind === "duplicate") test.tabs.set(44, { id: 44, groupId: 80, url: "https://chatgpt.com/c/manual" });
  if (kind === "closed") test.tabs.delete(41);
  if (kind === "changed") test.tabs.get(41).url = "https://chatgpt.com/c/changed";
  if (kind === "cancelled") await test.context.call({ taskId: task.taskId, cancel: true });
  if (kind === "timeout") test.advance(30001);
  const originalSender = { id: "extension", tab: { id: 41, url: "https://chatgpt.com/c/manual" } };
  await assert.rejects(test.context.bind(meta, originalSender));
  const terminal = await test.context.call({ taskId: task.taskId });
  assert.ok(["failed", "cancelled"].includes(terminal.status), kind);
  check("system_get_chat_context", terminal);
}
const moved = setup(), moving = await moved.context.call({});
await moved.context.bind(moved.context.metadata(moving.taskId), moved.sender());
moved.tabs.get(41).url = "https://chatgpt.com/c/new";
assert.equal((await moved.context.call({ taskId: moving.taskId })).error.code, "BROWSER_CHAT_CHANGED");

const unsaved = setup(), unsavedTask = await unsaved.context.call({});
unsaved.tabs.get(41).url = "https://chatgpt.com/c/local-chatgpt%3Atemporary";
await assert.rejects(unsaved.context.bind(unsaved.context.metadata(unsavedTask.taskId), unsaved.sender()), error => error.code === "BROWSER_SESSION_NOT_READY");
assert.equal((await unsaved.context.call({ taskId: unsavedTask.taskId })).status, "failed");
// Cancellation/expiry during asynchronous group lookup must win before resume.
for (const mode of ["cancel", "expire"]) {
  let release, clock = 0, resumed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const context = createChatContext({ extensionId: "extension", now: () => clock, id: () => "tsk_0000000001", token: () => webcrypto.randomUUID(),
    getTab: async () => ({ id: 1, groupId: 80, url: "https://chatgpt.com/c/chat" }), queryTabs: async () => [{ id: 1, url: "https://chatgpt.com/c/chat" }],
    conversationPath: value => new URL(value).pathname,
    connect: async (_, checkPending) => { await gate; checkPending(); resumed = true; return {}; }
  });
  const task = await context.call({});
  const binding = context.bind(context.metadata(task.taskId), { id: "extension", tab: { id: 1, url: "https://chatgpt.com/c/chat" } });
  await new Promise(resolve => setImmediate(resolve));
  if (mode === "cancel") await context.call({ taskId: task.taskId, cancel: true });
  else clock = 30001;
  release(); await assert.rejects(binding);
  assert.equal(resumed, false);
  assert.equal((await context.call({ taskId: task.taskId })).status, mode === "cancel" ? "cancelled" : "failed");
}

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
assert.throws(() => validateSystemInput("system_get_chat_context", { chatTabId: 41 }));
assert.deepEqual(validateSystemInput("system_get_chat_context", {}), {});
console.log("System tools: exact widget identity, manual groups, explicit resume, lifecycle and bounded sanitized diagnostics passed");
