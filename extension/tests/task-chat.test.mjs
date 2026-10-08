import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTaskCompletionDelivery, normalizeTaskTabId, installComposerWatchdog } from "../task-chat.js";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const bundle = await readFile(new URL("../dist/background.js", import.meta.url), "utf8");
const pageBundle = await readFile(new URL("../dist/task-chat-page.js", import.meta.url), "utf8");
const extract = (text, name) => {
  const match = new RegExp("(?:async )?function " + name + "\\(").exec(text);
  assert.ok(match, name);
  return text.slice(match.index, text.indexOf("\n}\n", match.index) + 3);
};
assert.equal(normalizeTaskTabId(undefined), null);
assert.equal(normalizeTaskTabId(42), 42);
for (const value of [-1, 1.2, "42", true, Infinity]) assert.throws(() => normalizeTaskTabId(value), { code: "INVALID_ARGUMENT" });
assert.doesNotMatch(extract(source, "startComposerWatchdog"), /new Function|eval\(/, "MV3 injection must use packaged code");
assert.match(pageBundle, /__researchtubeInstallComposerWatchdog/);
assert.match(pageBundle, /function installComposerWatchdog\(/, "packaged watchdog entry is present");
assert.match(pageBundle, /function resolveChatComposer\(/, "packaged Composer resolver is present");
assert.match(pageBundle, /function inspectChatComposer\(/, "packaged attachment inspection is present");
new Function(pageBundle);
assert.match(source, /Use tabId: \$\{chatTab\.id\} for async tasks/);

// Fast completion, duplicate status reads, busy tabs and autonomous Agent polls.
let now = 0, records = [], pollResult, pollGate = null;
const sends = [], scheduled = [];
const host = {
  now: () => now, historyLimit: () => 2, load: async () => structuredClone(records),
  save: async value => { records = structuredClone(value); },
  send: async (tabId, options) => { sends.push({ tabId, ...options }); return { sent: false, reason: "busy" }; },
  schedule: ms => scheduled.push(ms),
  status: async () => { if (pollGate) await pollGate; return pollResult; }
};
const delivery = createTaskCompletionDelivery(host);
const task = (id, status = "working") => ({ taskId: id, status, pollIntervalMs: 250 });
await delivery.register(task("tsk_0000000000", "completed"), "timer", null);
assert.equal(sends.length, 0);
await delivery.register(task("tsk_0000000001", "completed"), "timer", 42);
assert.equal(sends.length, 1);
assert.equal(sends[0].completionText, "ResearchTube task tsk_0000000001 completed.");
await delivery.observe(task("tsk_0000000001", "completed"));
await delivery.tick();
assert.equal(sends.length, 1, "a busy tab is consumed without a queued wake-up or repeated status notification");
await delivery.register(task("tsk_0000000002"), "custom", 81);
pollResult = task("tsk_0000000002", "completed");
await delivery.tick();
assert.equal(sends.length, 2);
assert.equal(sends[1].tabId, 81);
await delivery.tick(); assert.equal(sends.length, 2);
await delivery.register(task("tsk_0000000003"), "timer", 42);
let release; pollGate = new Promise(resolve => { release = resolve; });
pollResult = task("tsk_0000000003", "completed");
const ticking = delivery.tick();
await Promise.resolve(); await Promise.resolve();
await delivery.observe(task("tsk_0000000003", "cancelled"));
release(); await ticking; pollGate = null;
assert.equal(sends.length, 2, "cancellation observed during a poll must win");
assert.ok(records.filter(t => ["completed", "failed", "cancelled"].includes(t.status)).length <= 2);
const restored = createTaskCompletionDelivery(host);
await restored.tick(); assert.equal(sends.length, 2, "handled completions survive worker restoration");
await delivery.completed({ taskId: "child", status: "completed", tabId: 42, suppressCompletionNotification: true });
assert.equal(sends.length, 2, "reserved delivery children do not notify separately");

// Watchdog stability, busy generation, attachment changes and cancellation.
let time = 0, interval, messages = 0, busy = false, count = 0;
const handlers = {}, editor = { value: "", contains: target => target === editor };
const send = { disabled: false, getAttribute: () => "false" };
const root = { querySelector: () => send };
const document = {
  querySelector: () => busy ? {} : null,
  addEventListener: (name, fn) => { handlers[name] = fn; },
  removeEventListener: name => { delete handlers[name]; }
};
const pageWindow = {};
const install = new Function("window", "document", "performance", "chrome", "setInterval", "clearInterval", "resolveChatComposer",
  "return (" + installComposerWatchdog.toString() + ");")(
    pageWindow, document, { now: () => time },
    { runtime: { sendMessage: async () => { messages++; return { sent: false }; } } },
    fn => { interval = fn; return 1; }, () => {},
    () => ({ composer: editor, root })
  );
const inspect = () => ({ attachments: new Array(count).fill({}), previewCount: count });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
install(20, inspect);
editor.value = "continuation"; interval(); time = 19999; interval(); await flush();
assert.equal(messages, 0);
time = 20000; interval(); await flush(); assert.equal(messages, 1);
editor.value += "!"; handlers.input({ target: editor, isTrusted: true });
time += 19999; interval(); await flush(); assert.equal(messages, 1);
busy = true; time += 1; interval(); await flush(); assert.equal(messages, 1);
busy = false; interval(); await flush(); assert.equal(messages, 2, "stable draft waits for idle");
pageWindow.__researchtubeComposerWatchdog.hold();
time += 20000; interval(); await flush(); assert.equal(messages, 2);
pageWindow.__researchtubeComposerWatchdog.release(true);
count = 1; time += 1000; interval(); time += 20000; interval(); await flush();
assert.equal(messages, 2, "late upload changes do not auto-send a cancelled draft");
editor.value = "user edit"; handlers.input({ target: editor, isTrusted: true });
time += 20000; interval(); await flush(); assert.equal(messages, 3);
editor.value = ""; count = 0; interval();
count = 1; interval(); time += 19999; interval(); await flush(); assert.equal(messages, 3);
time += 1; interval(); await flush(); assert.equal(messages, 4, "attachment-only Composer is monitored");
install(5, inspect);
count = 2; interval(); time += 5000; interval(); await flush(); assert.equal(messages, 5, "configured timeout is used");
pageWindow.__researchtubeComposerWatchdog.dispose(); assert.equal(pageWindow.__researchtubeComposerWatchdog, undefined);

// Shared sender: append without replacement, idle only, UI acknowledgement,
// exact tab selection, active upload ownership and uncertain-click suppression.
let state, submitted, committed, suppressed, inserted;
const senderSource = extract(source, "sendComposerWhenReady");
const reset = () => {
  state = { found: true, idle: true, blocked: false, text: "", attachments: 0, stableMs: 21000, revision: 1 };
  submitted = false; committed = false; suppressed = 0; inserted = "";
};
const mediaTasks = new Map();
const ui = () => ({ userCount: submitted ? 1 : 0, lastUserId: submitted ? "message" : null, generating: submitted,
  sendPresent: true, sendDisabled: submitted, textEmpty: !state.text, attachments: state.attachments });
let ack = true, url = "https://chatgpt.com/c/test";
const sendComposer = new Function("deps", "with(deps) { return (" + senderSource + "); }")({
  withChatFileAutomation: work => work(),
  chrome: { tabs: { get: async id => { assert.equal(id, 42); return { id, url }; } } },
  startComposerWatchdog: async () => {}, readWatchedComposer: async () => ({ ...state }),
  ensureMediaToChatLoaded: async () => {},
  mediaToChatTasks: mediaTasks, composerAutoSendTimeout: async () => 20,
  cdpAttach: async () => {}, cdpPrepareBackgroundChat: async () => {}, cdpDetach: async () => {},
  cdpCommand: async (_id, method, params) => { if (method === "Input.insertText") { inserted = params.text; state.text += params.text; } },
  chatComposerPageExpression: () => "", cdpEvaluate: async () => ({ value: true }),
  cdpReadMediaSubmissionState: async () => ui(),
  cdpClickEnabledSendButton: async (_id, _timeout, check, commit) => { await check(); commit(); committed = true; if (ack) { state.text = ""; state.attachments = 0; submitted = true; } },
  updateComposerWatchdog: async () => { suppressed++; },
  localAgentError: (code, message) => Object.assign(new Error(message), { code }), consoleAction: () => {}
});
reset();
assert.equal((await sendComposer(42, { completionText: "done" })).sent, true);
assert.equal(inserted, "done"); assert.equal(suppressed, 1);
reset(); state.text = "existing draft"; state.attachments = 2;
assert.equal((await sendComposer(42, { completionText: "done" })).sent, true);
assert.equal(inserted, "\n\ndone");
reset(); state.idle = false;
assert.equal((await sendComposer(42, { completionText: "done" })).sent, false); assert.equal(inserted, "");
reset(); state.text = "editing"; state.stableMs = 19000;
assert.equal((await sendComposer(42, { completionText: "done" })).sent, false); assert.equal(inserted, "");
reset(); mediaTasks.set("upload", { target: { tabId: 42 }, status: "working" });
assert.equal((await sendComposer(42, { completionText: "done" })).sent, false);
mediaTasks.clear();
reset(); url = "https://example.test/";
assert.equal((await sendComposer(42, { completionText: "done" })).sent, false); assert.equal(committed, false);
url = "https://chatgpt.com/c/test";
reset(); ack = false;
assert.equal((await sendComposer(42, { completionText: "done" })).sent, false);
assert.equal(committed, true); assert.equal(suppressed, 1, "an uncertain committed click must not be replayed");
ack = true;

// Check the shipped worker's public schemas and every asynchronous producer.
const event = { addListener() {} };
const chrome = { runtime: { id: "fixture", getURL: p => p, onInstalled: event, onStartup: event, onMessage: event },
  tabs: { onRemoved: event, onUpdated: event, onActivated: event }, alarms: { onAlarm: event }, action: {},
  storage: { local: { get: async defaults => defaults, set: async () => {} } } };
const worker = new Function("chrome", "setTimeout", "clearTimeout", "console", bundle + "\nreturn { publicMcpTools, customToolDefinition, startArtifactTask, mediaToChatTaskSchema };")(
  chrome, () => 0, () => {}, { info() {}, warn() {}, error() {} }
);
const tools = worker.publicMcpTools();
const launchNames = ["youtube_download", "youtube_storyboard_download", "media_capture_frame", "visual_map_create", "media_clip",
 "camera_record_video", "camera_record_audio", "system_speech_speak", "media_capture_screen", "media_image_crop", "camera_capture_frame",
 "clipboard_get", "media_to_chat", "library_store_start", "timer_start", "site_get_images", "site_get_files"];
for (const name of launchNames) {
 const tool = tools.find(t => t.name === name);
 assert.ok(tool, name); assert.equal(tool.inputSchema.properties.tabId.type, "integer", name);
 assert.ok(!(tool.inputSchema.required || []).includes("tabId"), name + " optional context");
 assert.ok(tool.description.length <= 600, name);
}
assert.ok(worker.mediaToChatTaskSchema.properties.tabId, "nested artifact chat schema permits context");
const custom = worker.customToolDefinition({ name: "custom_test", title: "Test", description: "Test",
 inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
 _meta: { "researchtube/customTool": { packageId: "test", groupTitle: "Test", execution: "task" } } });
assert.ok(custom.inputSchema.properties.tabId); assert.ok(custom.outputSchema.properties.tabId);
console.log("task chat: completion, cancellation, watchdog, shared Send and shipped schemas ok");
