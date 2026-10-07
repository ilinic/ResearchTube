import { waitForComposerMedia } from "../composer-media-retry.js";
import { pruneCompletedTasks } from "../task-history.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { pageFixture } from './fixtures/chat-composer-page.mjs';
import { webcrypto } from "node:crypto";
import { resolveChatComposer, chatComposerPageExpression, chatComposerAttachmentNamesMatch, inspectChatComposer, clickChatComposerAttachmentRemoval, resetChatComposerFileInputs, installChatComposerGuard, readChatComposerGuard, disposeChatComposerGuard } from "../chat-composer.js";

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
let staleSelectedFiles = null;
let hoverRequired = false, hoverSeen = false;
let resetInputs = 0;
const telemetry = [];
const commands = [];
const context = vm.createContext({
  waitForComposerMedia,
  pruneCompletedTasks, completedTaskHistoryLimit: 2000, developerNewToolsDefault: true, refreshTaskHistorySettings: async () => {},
  resolveChatComposer, chatComposerPageExpression, chatComposerAttachmentNamesMatch, inspectChatComposer, clickChatComposerAttachmentRemoval, resetChatComposerFileInputs, installChatComposerGuard, readChatComposerGuard, disposeChatComposerGuard,
  URL, console, Promise, crypto: webcrypto, setTimeout, clearTimeout,
  EXTERNAL_URLS: { chatgptNewChat: "https://chatgpt.com/" },
  MEDIA_TO_CHAT_BIND_TIMEOUT_MS: 30_000,
  chrome: {
    runtime: { id:"test-extension" },
    alarms: { create:async()=>{}, clear:async()=>true },
    tabs: {
      query: async (query) => { assert.deepEqual(JSON.parse(JSON.stringify(query)), {}); return [{ id: 42, url: tabUrl }]; },
      get: async (id) => { assert.equal(id, 42); return { id, url: tabUrl }; }
    },
    storage: { local: { set: async () => {}, get: async () => ({}) } }
  },
  cdpError: (message) => new Error(message),
  localAgentError: (code, message) => Object.assign(new Error(message), { code }),
  consoleAction: () => {},
  logBrowserTabState: async () => {},
  cdpLog: () => {}, cdpErrorLog: () => {},
  cdpAbsoluteFilePath: (value) => value,
  configuredComposerMediaRetry: async () => ({ retryCount: 15, retryIntervalSeconds: 2 }),
  cdpPrepareBackgroundChat: async () => {},
  cdpAttach: async () => {}, cdpDetach: async () => { detached++; },
  cdpCommand: async (id, method, params) => {
    commands.push({ id, method, params });
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.x === 40) hoverSeen = true;
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
    if (expression.includes("function clickChatComposerAttachmentRemoval")) return {value:{clicked:false,reason:"noMatchingControl"}};
    if (expression.includes("function installChatComposerGuard")) { guardPresent = true; guardChanged = false; return { value: true }; }
    if (expression.includes("function resetChatComposerFileInputs")) { resetInputs++; staleSelectedFiles = null; return {value:true}; }
    if (expression.includes("function inspectChatComposer")) return { value: {
      found: true, textEmpty: draftEmpty,
      attachments: attachmentNames.map((name) => ({ name, text: name })),
      selectedFiles: (staleSelectedFiles ?? attachmentNames).map((name) => ({ name })),
      removeTargets: attachmentNames.map(() => ({ x: 1, y: 1, enabled: !hoverRequired || hoverSeen })), hoverTargets: attachmentNames.map(()=>({x:40,y:40})), previewCount: attachmentNames.length
    } };
    if (expression.includes("function readChatComposerGuard")) return { value: { present: guardPresent, changed: guardChanged } };
    if (expression.includes("function disposeChatComposerGuard")) { guardPresent = false; return { value: true }; }
    return { value: draftEmpty };
  },
  cdpOpenStableFileChooser: async () => ({ backendNodeId: 7 }),
  cdpWaitForAttachmentAccepted: async () => { afterAcceptance(); },
  cdpSendAttachedFiles: async (id, count, options) => { if (options.beforeClick) await options.beforeClick(); options.onSendCommit?.(); sends++; attachmentNames = []; },
  findOrCreateServiceTab: async () => { serviceTabs++; return { tab: { id: 43 } }; },
  libraryStoreNow: () => "2026-10-05T00:00:00Z",
  configuredToolLimits: async () => ({ mediaToChatMaxFiles: 2 }),
  normalizeWorkspacePath: (value) => { if (typeof value !== "string" || value.startsWith("/")) throw new Error("logical path required"); return value; },
  reportMcpToolToAgent: async (tool, value) => { telemetry.push({ tool, progress: value.progressPercent }); },
  safeErrorMessage: (error) => error.message,
  isExpectedToolError: (code) => code.startsWith("MEDIA_TO_CHAT_"),
  MEDIA_TO_CHAT_TASK_STORAGE_KEY: "tasks", MEDIA_TO_CHAT_QUEUE_STORAGE_KEY: "queue"
});
vm.runInContext(`
let chatFileAutomationTail = Promise.resolve();
let mediaToChatTasks = new Map();
let mediaToChatQueue = [];
let mediaToChatLoaded = true;
let mediaToChatLoading = null;
let mediaToChatDraining = true;
const mediaToChatSendTimers = new Map();
const mediaToChatResuming = new Set();
${section("async function cdpAttachFilesNow(", "\nfunction libraryStoreNow(")}
${section("function createAsyncTaskId(", "\nfunction libraryStoreQueuePosition(")}
${section("function normalizeLibraryStoreFiles(", "\nasync function resolveLibraryStoreFiles(")}
${section("function mediaToChatTaskDocument(", "\nasync function releaseArtifactChat(")}
`, context);
const target = {tabId:42,chatPath:"/c/example"};
const bind = async (taskId) => context.bindMediaToChatTarget(context.mediaToChatWidgetMetadata(taskId), {id:"test-extension",tab:{id:42,url:tabUrl}});
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
await assert.rejects(context.requireCurrentChatTarget(target), /closed or changed/);
tabUrl = "https://chatgpt.com/c/example";

await assert.rejects(context.mediaToChatStart({ files: [{ workspacePath: "one" }, { workspacePath: "two" }, { workspacePath: "three" }] }), (error) => error.code === "MEDIA_TO_CHAT_INVALID" && /2 items/.test(error.message));
for (const composerPolicy of ["replace", "", null, true, 123]) {
  await assert.rejects(context.mediaToChatStart({ files: [{ workspacePath: "report.pdf" }], composerPolicy }), (error) => error.code === "MEDIA_TO_CHAT_INVALID" && /composerPolicy/.test(error.message));
}
const queued = await context.mediaToChatStart({ files: [{ workspacePath: "report.pdf" }] });
assert.match(queued.task.taskId, /^tsk_[A-Za-z0-9_-]{10}$/);
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
await bind(partial.task.taskId);
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
await bind(allSkipped.task.taskId);
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
// A native FileList may stay populated after both React cards have been removed.
draftEmpty=true; attachmentNames=['old.png','old.docx']; staleSelectedFiles=[...attachmentNames];
hoverRequired=true; hoverSeen=false;
await context.cdpAttachFilesNow(['/workspace/report.pdf'],{currentChatTarget:target,composerPolicy:'clear'});
assert.equal(resetInputs,1,'reset the native selection only after confirmed card removal');
assert.equal(hoverSeen,true,'reveal pointer-events-none removal buttons before clicking');
assert.deepEqual(attachmentNames,[]);
hoverRequired=false;hoverSeen=false;
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
await assert.rejects(context.cdpAttachFilesNow(["/workspace/report.pdf"], { currentChatTarget: target }), /did not confirm Composer attachment count/);
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
vm.runInContext(section("const CDP_COMPOSER_EMPTY_EXPRESSION =", "\nfunction canonicalYouTubeVideoUrl("), context);
const emptyExpression = vm.runInContext("CDP_COMPOSER_EMPTY_EXPRESSION", context);
assert.equal(vm.runInNewContext(emptyExpression, { document: { querySelectorAll: () => [] } }), false);
console.log("media to chat: target binding, submission, skipped files, cancellation and serialization passed");

// User changes must abort while waiting for a disabled Send, not only once it enables.
const waiting = vm.createContext({
  Date, Number,
  sleep: async () => {}, cdpLog: () => {}, cdpError: (message) => new Error(message),
  waitForComposerMedia, configuredComposerMediaRetry: async () => ({ retryCount: 15, retryIntervalSeconds: 2 }),
  cdpReadMediaSubmissionState: async () => ({ found: true, textEmpty: false, attachments: 1, sendPresent: true, generating: false }),
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

// Standard short task IDs are URL-safe, cryptographically random, and unique.
const ids=new Set(Array.from({length:1000},()=>context.createAsyncTaskId()));
assert.equal(ids.size,1000);
for(const id of ids) assert.match(id,/^tsk_[A-Za-z0-9_-]{10}$/);
console.log('media to chat: standard IDs, mixed attachment removal, hover and stale FileList passed');

// Unrecognized removal markup must fail before replacing the native selection or uploading new files.
const evaluateBefore=context.cdpEvaluate;
const uploadsBeforeUnknown=injectedBefore();
attachmentNames=['unknown.bin'];draftEmpty=true;
context.cdpEvaluate=async (id,expression)=>{
 const result=await evaluateBefore(id,expression);
 if(expression.includes('function inspectChatComposer') && !expression.includes('function installChatComposerGuard')) {
  result.value.removeTargets=[];result.value.hoverTargets=[];
 }
 return result;
};
await assert.rejects(context.cdpAttachFilesNow(['/workspace/report.pdf'],{currentChatTarget:target,composerPolicy:'clear'}), /removal control/);
assert.equal(injectedBefore(),uploadsBeforeUnknown);
assert.deepEqual(attachmentNames,['unknown.bin']);
assert.equal(resetInputs,1,'unconfirmed removal must not reset the native input');
context.cdpEvaluate=evaluateBefore;

// Run the real page expressions through the complete attachment flow. The old
// #prompt-textarea is hidden and empty while the live rich Composer is occupied.
const live = pageFixture();
const hiddenLegacy = {...live.composer, tagName:'TEXTAREA', value:'', getAttribute:()=>'',
  getBoundingClientRect:()=>({left:0,top:0,width:0,height:0})};
live.document.querySelector = () => hiddenLegacy;
live.document.querySelectorAll = selector => selector === 'input[type="file"]' ? [live.input] : [hiddenLegacy,live.composer];
context.cdpEvaluate = async (_id, expression) => ({value: vm.runInContext(expression,live.context)});
vm.runInContext(section('const CDP_SELECT_COMPOSER_CONTENTS_EXPRESSION =', '\nasync function cdpClearSentComposerDraft('), context);
vm.runInContext(section('async function cdpClearComposerDraft(', '\nconst CDP_COMPOSER_EMPTY_EXPRESSION'), context);
vm.runInContext(section('function cdpAttachmentStateExpression(', '\nasync function cdpWaitForAttachmentAccepted('), context);
let actualUploads=0, actualSends=0, actualRemovals=0, actualScriptRemovals=0;
let onActualAcceptance = () => {};
context.cdpCommand = async (_id, method, params) => {
  if (method==='Input.dispatchKeyEvent' && params.type==='keyDown') {
    assert.equal(live.document.activeElement,live.composer);
    assert.equal(live.composer.selected,true);
    assert.equal(params.windowsVirtualKeyCode,8);
    live.composer.innerText='';
  }
  if (method==='Input.dispatchMouseEvent' && params.type==='mouseMoved') {
    // Keep the initial non-hovered CSS state to verify hover-independent removal.
    for (const button of live.root.controls) assert.equal(button.pointerBlocked,true);
  }
  if (method==='Input.dispatchMouseEvent' && params.type==='mouseReleased') {
    const button=live.root.controls.find(button=>{const b=button.getBoundingClientRect();return b.left+b.width/2===params.x && b.top+b.height/2===params.y;});
    assert.ok(button,'only a current removal button is clicked');
    live.root.cards=live.root.cards.filter(card=>card!==button.parentElement);
    live.root.images=live.root.images.filter(image=>!button.parentElement.contains(image));
    live.root.controls=live.root.controls.filter(item=>item!==button);
    actualRemovals++;
  }
  if (method==='DOM.setFileInputFiles') {
    actualUploads++;
    const names=params.files.map(path=>path.split('/').pop());
    live.input.files=names.map(name=>({name,size:100,lastModified:1}));
    for(const name of names) live.button(`Remove ${name}`,name,{markedCard:true,pointerBlocked:true});
    live.event('change',live.input);
    // React clears the native input, but the actual filename cards remain.
    live.input.files=[];
  }
  return {};
};
context.cdpWaitForAttachmentAccepted = async (_id,names)=>{
  const state=vm.runInContext(context.cdpAttachmentStateExpression(names),live.context);
  assert.equal(state.accepted,true);
  onActualAcceptance();
};
context.cdpSendAttachedFiles = async (_id,_count,options)=>{await options.beforeClick();actualSends++;};
live.composer.innerText='actual draft';
const manualClose=live.button('Remove manual.jpg','manual.jpg',{markedCard:true,pointerBlocked:true});
manualClose.click=()=>{
  live.root.cards=live.root.cards.filter(card=>card!==manualClose.parentElement);
  live.root.controls=live.root.controls.filter(button=>button!==manualClose);
  actualScriptRemovals++;
};
await assert.rejects(context.cdpAttachFilesNow(['/workspace/task.jpg'],{currentChatTarget:target}),/contains a draft/);
assert.equal(actualUploads,0,'requireEmpty must refuse before supplying any files');
assert.equal(live.composer.innerText,'actual draft');
assert.equal(live.run(inspectChatComposer).attachments[0].name,'manual.jpg');
await context.cdpAttachFilesNow(['/workspace/task.jpg','/workspace/task.mp3'],{currentChatTarget:target,composerPolicy:'clear'});
assert.equal(actualUploads,1);
assert.equal(actualRemovals,0);
assert.equal(actualScriptRemovals,1,'labelled hidden removal invokes React without depending on pointer hover');
assert.equal(actualSends,1);
assert.equal(live.composer.innerText,'');
assert.deepEqual([...live.run(inspectChatComposer).attachments].map(card=>card.name),['task.jpg','task.mp3']);
// Empty Composer works after FileList reset; an extra card or text blocks Send.
const resetPage=()=>{live.root.cards=[];live.root.controls=[];live.root.images=[];live.input.files=[];live.composer.innerText='';};
resetPage();
await context.cdpAttachFilesNow(['/workspace/task.jpg'],{currentChatTarget:target});
assert.equal(actualSends,2);
resetPage();onActualAcceptance=()=>{live.composer.innerText='user typed';live.event('input',live.composer);};
await assert.rejects(context.cdpAttachFilesNow(['/workspace/task.jpg'],{currentChatTarget:target}),/edited during upload/);
assert.equal(actualSends,2);
assert.equal(live.composer.innerText,'user typed');
assert.equal(live.run(inspectChatComposer).attachments[0].name,'task.jpg');
resetPage();onActualAcceptance=()=>live.button('Remove extra.pdf','extra.pdf',{markedCard:true});
await assert.rejects(context.cdpAttachFilesNow(['/workspace/task.jpg'],{currentChatTarget:target}),/did not confirm Composer attachment count/);
assert.equal(actualSends,2);
console.log('media to chat: real page expressions reject occupied live editor, clear initial state, accept reset FileList and preserve user changes');

// The enabled submit button must come from the same visible draft area.
vm.runInContext(section('const CDP_ENABLED_SEND_BUTTON_EXPRESSION =', '\nfunction cdpComposerTextExpression('), context);
const submit=live.button('Send','');
submit.getBoundingClientRect=()=>({left:300,top:200,width:30,height:30});
live.root.querySelector=selector=>selector==='button[type="submit"]'?submit:null;
live.composer.closest=selector=>selector==='[data-composer-body]'?live.root:null;
const enabledExpression=vm.runInContext('CDP_ENABLED_SEND_BUTTON_EXPRESSION',context);
const centerExpression=vm.runInContext('CDP_SEND_BUTTON_CENTER_EXPRESSION',context);
assert.equal(vm.runInContext(enabledExpression,live.context),true);
assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(centerExpression,live.context))),{x:315,y:215});
submit.disabled=true;
assert.equal(vm.runInContext(enabledExpression,live.context),false);
assert.equal(vm.runInContext(centerExpression,live.context),null);
console.log('media to chat: Send lookup follows visible Composer body and respects disabled state');

// Clear the whole initial mixed batch before uploading anything, even when
// its labelled removal buttons start in the non-hovered CSS state.
resetPage();onActualAcceptance=()=>{};
live.composer.innerText='old mixed draft';
const uploadsBeforeMixed=actualUploads, sendsBeforeMixed=actualSends;
let mixedScriptRemovals=0;
for(const name of ['manual-photo.png','Report.docx','voice.mp3','archive.zip']) {
 const button=live.button(`Remove ${name}`,name,{markedCard:true,pointerBlocked:true});
 button.click=()=>{
  assert.equal(actualUploads,uploadsBeforeMixed,'all initial cards must disappear before any new upload');
  live.root.cards=live.root.cards.filter(card=>card!==button.parentElement);
  live.root.controls=live.root.controls.filter(control=>control!==button);
  mixedScriptRemovals++;
 };
}
await context.cdpAttachFilesNow(['/workspace/result.pdf'],{currentChatTarget:target,composerPolicy:'clear'});
assert.equal(mixedScriptRemovals,4);
assert.equal(actualUploads,uploadsBeforeMixed+1);
assert.equal(actualSends,sendsBeforeMixed+1);
assert.equal(live.composer.innerText,'');
assert.deepEqual([...live.run(inspectChatComposer).attachments].map(card=>card.name),['result.pdf']);
console.log('media to chat: clear removes every mixed initial attachment before uploading and Send');

resetPage(); tabUrl = 'https://chatgpt.com/';
live.composer.innerText = 'restored new-chat draft';
const restored = live.button('Remove restored.png', 'restored.png', { markedCard: true });
restored.click = () => { live.root.cards = []; live.root.controls = []; };
const uploadBeforeStartup = actualUploads;
await context.prepareCurrentChatComposer({ tabId: 42, chatPath: '/', newChat: true }, 'clear');
assert.equal(live.composer.innerText, '');
assert.equal(live.run(inspectChatComposer).attachments.length, 0);
assert.equal(actualUploads, uploadBeforeStartup);
await assert.rejects(context.requireCurrentChatTarget({ tabId: 42, chatPath: '/' }), /closed or changed/);
live.composer.innerText = 'KEEP USER DRAFT'; tabUrl = 'https://chatgpt.com/c/example';
await assert.rejects(context.prepareCurrentChatComposer({ tabId: 42, chatPath: '/', newChat: true }, 'clear'), /closed or changed/);
assert.equal(live.composer.innerText, 'KEEP USER DRAFT');
console.log('Startup clear: text and attachment removal only for an explicitly captured new-chat tab, navigation stops before clearing: ok');
