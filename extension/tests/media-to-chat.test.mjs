import { pruneCompletedTasks } from "../task-history.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { inspectChatComposer, installChatComposerGuard, readChatComposerGuard, disposeChatComposerGuard } from "../chat-composer.js";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
for (const name of ["media_show", "media_to_chat", "media_to_chat_status", "media_to_chat_cancel"]) assert.match(source, new RegExp(`name: "${name}"`));
assert.doesNotMatch(source, /name: "media_image_show"/);
const section = (start, end) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
};
let tabUrl = "https://chatgpt.com/c/example";
let draftEmpty = true;
let attachmentNames = [];
let guardChanged = false;
let guardPresent = false;
let clears = 0;
let removals = 0;
let afterAcceptance = () => {};
let sends = 0;
let serviceTabs = 0;
let detached = 0;
const telemetry = [];
const commands = [];
const context = vm.createContext({
  pruneCompletedTasks, completedTaskHistoryLimit: 2000, developerNewToolsDefault: true, refreshTaskHistorySettings: async () => {},
  inspectChatComposer, installChatComposerGuard, readChatComposerGuard, disposeChatComposerGuard,
  URL, console, Promise, crypto: { randomUUID: () => `test-${Math.random()}` },
  chrome: {
    tabs: {
      query: async (query) => { assert.deepEqual(JSON.parse(JSON.stringify(query)), { active: true, lastFocusedWindow: true }); return [{ id: 42, url: tabUrl }]; },
      get: async (id) => { assert.equal(id, 42); return { id, url: tabUrl }; }
    },
    storage: { local: { set: async () => {}, get: async () => ({}) } }
  },
  cdpError: (message) => new Error(message),
  localAgentError: (code, message) => Object.assign(new Error(message), { code }),
  cdpLog: () => {}, cdpErrorLog: () => {},
  cdpAbsoluteFilePath: (value) => value,
  cdpAttach: async () => {}, cdpDetach: async () => { detached++; },
  cdpCommand: async (id, method, params) => {
    commands.push({ id, method, params });
    if (method === "DOM.setFileInputFiles") attachmentNames = params.files.map((path) => path.split("/").pop());
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") { attachmentNames.shift(); removals++; }
    return {};
  },
  cdpWaitForTextComposer: async () => {},
  CDP_COMPOSER_EMPTY_EXPRESSION: "empty",
  cdpClearComposerDraft: async () => { clears++; draftEmpty = true; },
  sleep: async () => {},
  Date,
  cdpEvaluate: async (id, expression) => {
    if (expression.includes("function inspectChatComposer")) return { value: {
      found: true, textEmpty: draftEmpty,
      attachments: attachmentNames.map((name) => ({ text: name })),
      selectedFiles: attachmentNames.map((name) => ({ name })),
      removeTargets: attachmentNames.map(() => ({ x: 1, y: 1, enabled: true })), previewCount: 0
    } };
    if (expression.includes("function installChatComposerGuard")) { guardPresent = true; guardChanged = false; return { value: true }; }
    if (expression.includes("function readChatComposerGuard")) return { value: { present: guardPresent, changed: guardChanged } };
    if (expression.includes("function disposeChatComposerGuard")) { guardPresent = false; return { value: true }; }
    return { value: draftEmpty };
  },
  cdpOpenStableFileChooser: async () => ({ backendNodeId: 7 }),
  cdpWaitForAttachmentAccepted: async () => { afterAcceptance(); },
  cdpSendAttachedFiles: async (id, count, options) => { if (options.beforeClick) await options.beforeClick(); sends++; attachmentNames = []; },
  findOrCreateServiceTab: async () => { serviceTabs++; return { tab: { id: 43 } }; },
  libraryStoreNow: () => "2026-10-05T00:00:00Z",
  configuredToolLimits: async () => ({ mediaToChatMaxFiles: 2 }),
  normalizeWorkspacePath: (value) => { if (typeof value !== "string" || value.startsWith("/")) throw new Error("logical path required"); return value; },
  reportMcpToolToAgent: async (tool, value) => { telemetry.push({ tool, progress: value.progressPercent }); },
  safeErrorMessage: (error) => error.message,
  isExpectedToolError: (code) => code.endsWith("_INVALID"),
  MEDIA_TO_CHAT_TASK_STORAGE_KEY: "tasks", MEDIA_TO_CHAT_QUEUE_STORAGE_KEY: "queue"
});
vm.runInContext(`
let chatFileAutomationTail = Promise.resolve();
let mediaToChatTasks = new Map();
let mediaToChatQueue = [];
let mediaToChatLoaded = true;
let mediaToChatLoading = null;
let mediaToChatDraining = true;
${section("async function cdpAttachFilesNow(", "\nfunction libraryStoreNow(")}
${section("function normalizeLibraryStoreFiles(", "\nasync function resolveLibraryStoreFiles(")}
${section("function mediaToChatTaskDocument(", "\nchrome.runtime.onInstalled")}
`, context);
const target = await context.captureCurrentChatTarget();
assert.deepEqual(JSON.parse(JSON.stringify(target)), { tabId: 42, chatPath: "/c/example" });
await context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target });
assert.equal(serviceTabs, 0, "current-chat transfers must not create a service tab");
assert.equal(sends, 1);
assert.equal(detached, 1);
assert.equal(commands.find((item) => item.method === "DOM.setFileInputFiles").id, 42);

// A navigation after attachment must never send to another conversation.
afterAcceptance = () => { tabUrl = "https://chatgpt.com/c/other"; };
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target }), /closed or changed/);
assert.equal(sends, 1);
assert.equal(detached, 2);
// A draft appearing during upload must also stop before Send.
tabUrl = "https://chatgpt.com/c/example"; attachmentNames = [];
afterAcceptance = () => { draftEmpty = false; };
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target }), /contains a draft/);
assert.equal(sends, 1);
assert.equal(detached, 3);
assert.deepEqual(attachmentNames, ["report.pdf"], "failed Send must retain uploaded files");
assert.equal(clears, 0);
assert.equal(guardPresent, false, "a failed task must remove its edit listener");
draftEmpty = true; attachmentNames = []; afterAcceptance = () => {};
tabUrl = "https://example.com/c/example";
await assert.rejects(context.captureCurrentChatTarget(), /Keep the current ChatGPT conversation active/);
tabUrl = "https://chatgpt.com/c/example";

await assert.rejects(context.mediaToChatStart({ files: [{ workspacePath: "one" }, { workspacePath: "two" }, { workspacePath: "three" }] }), (error) => error.code === "MEDIA_TO_CHAT_INVALID" && /2 items/.test(error.message));
for (const composerPolicy of ["replace", "", null, true, 123]) {
  await assert.rejects(context.mediaToChatStart({ files: [{ workspacePath: "report.pdf" }], composerPolicy }), (error) => error.code === "MEDIA_TO_CHAT_INVALID" && /composerPolicy/.test(error.message));
}
const queued = await context.mediaToChatStart({ files: [{ workspacePath: "report.pdf" }] });
assert.equal(queued.task.status, "queued");
assert.equal(queued.task.progressPercent, 0);
assert.equal(queued.task.composerPolicy, "requireEmpty");
assert.ok(!("target" in queued.task) && !("tabId" in queued.task), "private target identity must not reach MCP");
assert.equal((await context.mediaToChatCancel(queued.task.taskId)).cancelled, true);

context.resolveLibraryStoreFiles = async (files, endpoint) => {
  assert.equal(endpoint, "/internal/media-to-chat-files");
  return { localPaths: ["/workspace/report.pdf"], submittedFiles: [{ workspacePath: "report.pdf" }], skippedFiles: [{ workspacePath: "large.bin", sizeBytes: 1048577, maxFileSizeBytes: 1048576, reason: "FILE_TOO_LARGE" }] };
};
const partial = await context.mediaToChatStart({ files: [{ workspacePath: "report.pdf" }, { workspacePath: "large.bin" }] });
vm.runInContext("mediaToChatDraining = false", context);
await context.drainMediaToChatQueue();
const completed = await context.mediaToChatStatus(partial.task.taskId);
assert.equal(completed.status, "completed");
assert.equal(completed.progressPercent, 100);
assert.deepEqual(telemetry.filter((entry) => entry.tool === "media_to_chat").slice(-5).map((entry) => entry.progress), [10, 25, 65, 80, 100]);
assert.equal(completed.submittedFiles[0].workspacePath, "report.pdf");
assert.equal(completed.skippedFiles[0].workspacePath, "large.bin");
assert.ok(!JSON.stringify(completed).includes("/workspace/"));
assert.equal((await context.mediaToChatCancel(partial.task.taskId)).cancelled, false);

// If all files are oversized, no browser upload or Send is attempted.
context.resolveLibraryStoreFiles = async () => ({ localPaths: [], submittedFiles: [], skippedFiles: [{ workspacePath: "large.bin", sizeBytes: 1048577, maxFileSizeBytes: 1048576, reason: "FILE_TOO_LARGE" }] });
vm.runInContext("mediaToChatDraining = true", context);
const allSkipped = await context.mediaToChatStart({ files: [{ workspacePath: "large.bin" }] });
const previousSends = sends;
vm.runInContext("mediaToChatDraining = false", context);
await context.drainMediaToChatQueue();
assert.equal((await context.mediaToChatStatus(allSkipped.task.taskId)).status, "failed");
assert.equal(sends, previousSends);

// Policy refuses both text and existing attachments, before passing any new files.
vm.runInContext("mediaToChatDraining = true", context);
const injectedBefore = () => commands.filter((item) => item.method === "DOM.setFileInputFiles").length;
let initialUploads = injectedBefore();
draftEmpty = false;
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target }), /contains a draft/);
assert.equal(injectedBefore(), initialUploads);
assert.equal(clears, 0);
draftEmpty = true; attachmentNames = ["user.pdf"];
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target }), /already contains attachments/);
assert.deepEqual(attachmentNames, ["user.pdf"]);
assert.equal(injectedBefore(), initialUploads);
assert.equal(removals, 0);

// clear explicitly discards the initial draft + files, only once before upload.
draftEmpty = false; attachmentNames = ["old.png", "old.txt"];
await context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target, composerPolicy: "clear" });
assert.equal(clears, 1);
assert.equal(removals, 2);
assert.equal(draftEmpty, true);
assert.equal(guardPresent, false);
const clearsBeforeUploadEdit = clears;
const removalsBeforeUploadEdit = removals;
afterAcceptance = () => { draftEmpty = false; };
const sendsBeforeEdit = sends;
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target, composerPolicy: "clear" }), /contains a draft/);
assert.equal(clears, clearsBeforeUploadEdit, "clear must never repeat after upload starts");
assert.equal(removals, removalsBeforeUploadEdit);
assert.equal(sends, sendsBeforeEdit);
assert.deepEqual(attachmentNames, ["report.pdf"]);
assert.equal(draftEmpty, false);

// An added attachment or editing and then deleting text also stops Send.
draftEmpty = true; attachmentNames = [];
afterAcceptance = () => { attachmentNames.push("user.txt"); };
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target }), /attachments changed/);
assert.deepEqual(attachmentNames, ["report.pdf", "user.txt"]);
assert.equal(sends, sendsBeforeEdit);
attachmentNames = [];
afterAcceptance = () => { guardChanged = true; };
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target }), /edited during upload/);
assert.deepEqual(attachmentNames, ["report.pdf"]);
assert.equal(sends, sendsBeforeEdit);
attachmentNames = []; afterAcceptance = () => {};
const clearTask = await context.mediaToChatStart({ files: [{ workspacePath: "report.pdf" }], composerPolicy: "clear" });
assert.equal(clearTask.task.composerPolicy, "clear");
assert.equal((await context.mediaToChatCancel(clearTask.task.taskId)).cancelled, true);

// Library and current-chat work share one lock, including recovery after errors.
let active = 0;
const order = [];
await Promise.all([1, 2, 3].map((id) => context.withChatFileAutomation(async () => {
  assert.equal(active, 0); active++;
  order.push(id); await Promise.resolve(); active--;
  if (id === 2) throw new Error("expected failure");
}).catch(() => {})));
assert.deepEqual(order, [1, 2, 3]);
// Unknown tasks are ordinary state errors, and interrupted submissions are not replayed.
await assert.rejects(context.mediaToChatStatus("missing"), (error) => error.code === "MEDIA_TO_CHAT_TASK_NOT_FOUND");
await assert.rejects(context.mediaToChatCancel("missing"), (error) => error.code === "MEDIA_TO_CHAT_TASK_NOT_FOUND");
context.chrome.storage.local.get = async () => ({ tasks: [{ ...completed, status: "working", phase: "submitting", progressPercent: 80, target }], queue: [] });
vm.runInContext("mediaToChatLoaded = false", context);
await context.ensureMediaToChatLoaded();
const interrupted = await context.mediaToChatStatus(completed.taskId);
assert.equal(interrupted.status, "failed");
assert.equal(interrupted.progressPercent, 80);
assert.match(interrupted.error, /restarted.*avoid sending files twice/);
assert.equal(sends, sendsBeforeEdit);

// A missing Composer is not an empty Composer. Telemetry retains camel-case phases.
vm.runInContext(section("function mcpLogStatus(", "\nasync function reportMcpToolToAgent("), context);
assert.equal(context.mcpLogStatus({ phase: "composerAccepted", status: "working" }), "composeraccepted");
const emptyExpression = source.match(/const CDP_COMPOSER_EMPTY_EXPRESSION = `([\s\S]*?)`;/)[1];
assert.equal(vm.runInNewContext(emptyExpression, { document: { querySelector: () => null } }), false);
console.log("media to chat: target binding, submission, skipped files, cancellation and serialization passed");

// User changes must abort while waiting for a disabled Send, not only once it enables.
const waiting = vm.createContext({
  Date, Number,
  sleep: async () => {}, cdpLog: () => {}, cdpError: (message) => new Error(message),
  CDP_ENABLED_SEND_BUTTON_EXPRESSION: 'ready', CDP_SEND_BUTTON_CENTER_EXPRESSION: 'center',
  cdpEvaluate: async (_id, expression) => ({ value: expression === 'center' ? { x: 1, y: 1 } : false }),
  cdpCommand: async () => { throw new Error('No mouse events are allowed after user editing'); }
});
vm.runInContext(section('async function cdpWaitFor(', '\nasync function cdpWaitForStableComposer('), waiting);
vm.runInContext(section('async function cdpClickEnabledSendButton(', '\nasync function cdpSendComposerText('), waiting);
let polls = 0;
await assert.rejects(waiting.cdpClickEnabledSendButton(42, 45_000, async () => {
  polls++;
  if (polls === 2) throw new Error('user changed the Composer');
}), /user changed the Composer/);
assert.equal(polls, 2);
console.log('media to chat: user changes abort the Send readiness wait');
