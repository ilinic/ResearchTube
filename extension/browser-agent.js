import { browserError, validateBrowserInput } from "./browser-tools.js";
import { createBrowserPage, inspectBrowserElement, safePageUrl } from "./browser-page.js";
import { pruneCompletedTasks } from "./task-history.js";
import { createBrowserDiagnostics } from "./browser-diagnostics.js";
import { createBrowserGroups, isChatTab } from "./browser-groups.js";
import { browserAttachmentError, isBrowserFrameUrlAllowed, withBrowserFrameTimeout } from "./browser-frame-policy.js";
import { createTabAutomationQueue } from "./tab-automation.js";
import { normalizeStartupPrompts, renderStartupPrompt } from "./startup-prompts.js";

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] };
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const randomId = prefix => `${prefix}_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(7)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
const bytesOf = base64 => Uint8Array.from(atob(base64), character => character.charCodeAt(0));
export function browserStudyGroupTitle(source) {
  let title = (source.title || "").replace(/\s+/g, " ").trim().replace(/^Marketplace\s*[-–—:]\s*/i, "").split(/\s+\|\s+/)[0].trim();
  if (!title) { try { title = new URL(source.url).hostname.replace(/^www\./, ""); } catch { title = "Site"; } }
  const characters = Array.from(title);
  return `RT · ${characters.length > 20 ? characters.slice(0, 19).join("") + "…" : title}`;
}
function isImage(bytes) {
  const ascii = new TextDecoder().decode(bytes.slice(0, 4096));
  return bytes[0] === 137 && ascii.slice(1, 4) === "PNG" || bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 || /^(GIF87a|GIF89a)/.test(ascii) || ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP" || ascii.slice(4, 8) === "ftyp" && /^(avif|avis)$/.test(ascii.slice(8, 12)) || /^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg(?:\s|>)/.test(ascii);
}

// Wait for the usable document, not all images, ads and background requests.
// Attach/focus emulation must already be enabled before waiting in a background tab.
export async function waitForBrowserDocument(host, tabId, checkCancelled = () => {}, { timeoutMs = 120000, requiredOrigin = null } = {}) {
  const now = host.now || (() => Date.now());
  const sleep = host.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now(); let lastReport = started;
  while (now() - started < timeoutMs) {
    checkCancelled();
    let tab;
    try { tab = await host.getTab(tabId); }
    catch { throw browserError("TAB_CLOSED", "The bound tab closed while its document was loading. No alternate tab was selected."); }
    if (/^https?:\/\//.test(tab.url || "") && (!requiredOrigin || new URL(tab.url).origin === requiredOrigin)) {
      try {
        const result = await host.command(tabId, "Runtime.evaluate", {
          expression: "Boolean(document.body && document.readyState !== 'loading' && /^https?:$/.test(location.protocol))",
          returnByValue: true
        });
        checkCancelled();
        if (!result.exceptionDetails && result.result?.value === true) return;
      } catch (error) { checkCancelled(); /* The execution context can change during navigation. */ }
    }
    if (now() - lastReport >= 10000) { host.onWaiting?.(Math.floor((now() - started) / 1000)); lastReport = now(); }
    await sleep(500);
  }
  checkCancelled();
  throw browserError("BROWSER_UNAVAILABLE", `The bound document was not ready within ${timeoutMs / 1000} seconds. Check the page or connection and retry Study this site.`);
}

// ChatGPT first assigns /c/local-chatgpt%3A<uuid> while saving a new chat.
// Bind only its persisted path; that ordinary URL replacement is not navigation
// to another conversation. Read the same captured tab throughout the wait.
export async function waitForBrowserConversation(host, tabId, checkCancelled = () => {}, { timeoutMs = 120000 } = {}) {
  const now = host.now || (() => Date.now());
  const sleep = host.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now(); let reportedTemporary = false;
  while (now() - started < timeoutMs) {
    checkCancelled();
    let tab;
    try { tab = await host.getTab(tabId); }
    catch { throw browserError("TAB_CLOSED", "The dedicated ChatGPT tab closed while its conversation was being saved. No alternate tab was selected."); }
    checkCancelled();
    const path = host.conversationPath(tab.url);
    if (path) {
      let conversationId;
      try { conversationId = decodeURIComponent(path.split("/c/").pop()); }
      catch { conversationId = null; }
      if (conversationId && !conversationId.startsWith("local-chatgpt:")) {
        host.log?.("conversation confirmed", { tabId, chatPath: path });
        return path;
      }
      if (!reportedTemporary) {
        host.log?.("waiting for saved conversation", { tabId, temporaryChatPath: path });
        reportedTemporary = true;
      }
    }
    await sleep(250);
  }
  checkCancelled();
  throw browserError("BROWSER_CHAT_NOT_FOUND", "ChatGPT did not provide a saved conversation address within the startup timeout. The study prompt may remain in its dedicated tab; no alternate chat was selected.");
}

const SESSION_MESSAGES = {
  duplicating: "Creating a copy of the source tab…",
  creatingChat: "Opening the leading ChatGPT chat…",
  connecting: "Connecting Chrome automation…",
  waitingForPage: "Waiting for the site document…",
  waitingForChat: "Waiting for ChatGPT…",
  waitingForComposer: "Waiting for the ChatGPT Composer…",
  preparingPrompt: "Preparing the study prompt…",
  sendingPrompt: "Sending the study prompt…",
  confirmingChat: "Confirming the new conversation…",
  running: "Group research is active",
  stopped: "Study session stopped",
  failed: "Study session failed"
};

export function createBrowserAgent(host) {
  const tasks = new Map(), targets = new Map(), statuses = new Map();
  const localQueue = createTabAutomationQueue();
  const queue = host.queue || localQueue.run;
  const clock = host.now || (() => Date.now());
  const timestamp = () => new Date(clock()).toISOString();
  const log = (label, value = {}) => host.log?.(label, value);
  let pageEpoch = null;
  const nextPageVersion = () => {
    if (pageEpoch === null) {
      const values = crypto.getRandomValues(new Uint32Array(2));
      pageEpoch = (values[0] & 0xffff) * 0x100000000 + values[1];
    }
    return ++pageEpoch;
  };
  const groups = createBrowserGroups({ ...host,
    studyOptions: host.studyOptions || (async () => ({ detailedLogging: false })),
    removed: async (group, tabId, code) => { cancelForTab(group, tabId); await dropTarget(group, tabId, code); },
    conversationChanged: async (group, tabId) => { cancelForTab(group, tabId); },
    ownerLeft: group => stopGroup(group)
  });
  const command = async (tabId, method, params = {}, childSessionId = null) => {
    try {
      const trace = targets.get(tabId)?.trace;
      return await (trace ? trace.command(method, () => host.command(tabId, method, params, childSessionId)) : host.command(tabId, method, params, childSessionId));
    } catch { throw browserError("BROWSER_UNAVAILABLE", `Chrome could not complete ${method}. The page may be loading, closed or detached.`); }
  };
  const publicTask = task => ({ ...Object.fromEntries(["taskId", "chatTabId", "tabId", "groupId", "kind", "resourceId", "resourceIds", "files", "status", "phase", "progressPercent", "pollIntervalMs", "createdAt", "updatedAt", "workspacePath", "mimeType", "extraction", "submittedFiles", "submittedAt", "error"].map(key => [key, structuredClone(task[key])])), group: groups.project(task.caller.group) });
  function newTask(caller, tabId, kind, resourceIds = [], resourceId = null) {
    let taskId; do { taskId = host.id?.() || randomId("tsk"); } while (tasks.has(taskId));
    const task = { taskId, chatTabId: caller.chatTabId, tabId, groupId: caller.group.groupId, kind,
      resourceId, resourceIds, files: [], status: "queued", phase: "queued", progressPercent: 0, pollIntervalMs: 1000,
      createdAt: timestamp(), updatedAt: timestamp(), workspacePath: null, mimeType: null, extraction: null,
      submittedFiles: [], submittedAt: null, error: null, cancelRequested: false, sendCommitted: false, caller };
    tasks.set(taskId, task); return task;
  }
  function progress(task, phase, percent) {
    if (task.phase !== phase) {
      task.finishPhase?.({ outcome: task.status, bytes: task.sizeBytes });
      task.finishPhase = TERMINAL.has(task.status) ? null : task.trace?.begin(`resource.${phase}`, { taskId: task.taskId });
    }
    task.progressPercent = Math.max(task.progressPercent, percent); task.phase = phase; task.updatedAt = timestamp();
    log("resource", { tool: task.caller.tool, taskId: task.taskId, tabId: task.tabId, chatTabId: task.chatTabId, groupId: task.groupId, status: task.status, phase, progressPercent: task.progressPercent, error: task.error });
  }
  function cancelTask(task) {
    if (TERMINAL.has(task.status) || task.sendCommitted) return false;
    task.cancelRequested = true; task.status = "cancelled"; progress(task, "cancelled", task.progressPercent);
    return true;
  }
  function cancelForTab(group, tabId) {
    for (const task of tasks.values()) if (task.groupId === group.groupId && (task.tabId === tabId || task.chatTabId === tabId)) cancelTask(task);
  }
  function checkTask(task, session) {
    if (task.cancelRequested || ["stopped", "failed"].includes(session.group.state) || session.error || targets.get(session.agentTabId) !== session)
      throw browserError("BROWSER_CANCELLED", "The task was cancelled or its selected participant stopped. Existing files and attachments were preserved.");
  }
  async function waitRunning(task, session) {
    checkTask(task, session);
    await groups.check(session.group, task.chatTabId, task.caller.chatPath);
    await check(session);
    if (session.group.state === "starting") throw browserError("BROWSER_SESSION_NOT_READY", "Wait for study initialization.");
    checkTask(task, session);
  }
  async function check(session, mutation = false) {
    if (session.error) throw browserError(session.error.code, session.error.message);
    if (targets.get(session.agentTabId) !== session) throw browserError("TAB_LEFT_GROUP", "This page no longer belongs to the current group automation.");
    const tab = await groups.check(session.group, session.agentTabId);
    if (isChatTab(tab)) throw browserError("BROWSER_INVALID", "Page tools control site tabs, not ChatGPT chats.");
    if (mutation && session.operation) {
      await groups.check(session.group, session.operation.chatTabId, session.operation.chatPath);
    }
    if (mutation && session.group.state !== "running") throw browserError("BROWSER_SESSION_NOT_READY", "Wait for study initialization.");
    if (session.url !== tab.url) { session.url = tab.url; session.pageVersion = nextPageVersion(); session.revision++; session.page.invalidate(); }
    session.title = tab.title || "";
    return tab;
  }
  async function enableTarget(session, childId = null, checkEnabled = () => {}) {
    for (const domain of ["Page", "Runtime", "DOM", "Accessibility", "Network"]) {
      checkEnabled(); await command(session.agentTabId, `${domain}.enable`, {}, childId); checkEnabled();
    }
    await command(session.agentTabId, "Target.setAutoAttach", AUTO_ATTACH, childId);
    if (!childId) {
      await command(session.agentTabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      await command(session.agentTabId, "Page.setWebLifecycleState", { state: "active" });
    }
  }
  function targetFor(group, tab) {
    let target = group.targets.get(tab.id);
    if (target) return target;
    target = { group, agentTabId: tab.id, observation: group.options.observation, state: "running", url: tab.url, title: tab.title || "",
      pageVersion: nextPageVersion(), revision: 1, childSessions: new Map(), attached: false, error: null, operation: null, lastPageCallEnd: null };
    target.trace = createBrowserDiagnostics({ enabled: group.options.detailedLogging, groupId: group.groupId, log, onError: details => host.diagnostic?.({ ...details, tool: target.operation?.tool, tabId: target.agentTabId, chatTabId: target.operation?.chatTabId }), now: host.monotonicNow || host.now });
    target.page = createBrowserPage(target, { command, check, trace: target.trace, context: () => ({ chatTabId: target.operation?.chatTabId ?? target.agentTabId, group: groups.project(group) }) });
    group.targets.set(tab.id, target); targets.set(tab.id, target); return target;
  }
  async function ensureTarget(target, onDocument = null) {
    await check(target);
    if (!target.attached) {
      try { await host.attach(target.agentTabId); }
      catch (error) { const failure = browserAttachmentError(error); target.trace.event("target.attachFailed", { tabId: target.agentTabId, code: failure.code }); throw failure; }
      target.attached = true;
      try { await enableTarget(target); await onDocument?.(); await host.waitReady(target.agentTabId, () => {
        if (target.error || targets.get(target.agentTabId) !== target) throw browserError("BROWSER_CANCELLED", "The target left during initialization.");
      }, target.trace); }
      catch (error) { await dropTarget(target.group, target.agentTabId, error.code || "BROWSER_UNAVAILABLE"); throw error; }
    }
  }
  async function dropTarget(group, tabId, code = "TAB_LEFT_GROUP") {
    const target = group.targets.get(tabId);
    if (target) {
      target.error = { code, message: "Automation for this participant stopped; other group tabs remain available." };
      target.page.invalidate(); target.childSessions.clear();
      group.targets.delete(tabId); if (targets.get(tabId) === target) targets.delete(tabId);
      if (target.attached) { target.attached = false; await host.detach(tabId).catch(() => {}); }
    }
    await host.updateStatus?.([tabId], { state: "stopped", phase: "stopped", statusMessage: "Participant automation stopped.", error: null });
  }
  async function stopGroup(group) {
    group.state = "stopped"; group.phase = "stopped";
    for (const task of tasks.values()) if (task.groupId === group.groupId) cancelTask(task);
    for (const tabId of [...group.targets.keys()]) await dropTarget(group, tabId, "BROWSER_SESSION_STOPPED");
    await host.updateStatus?.([...group.members.keys()], { state: "stopped", phase: "stopped", statusMessage: "Group automation stopped.", error: null });
    await groups.saveOwner(group);
    return groups.project(group);
  }
  async function start(sourceTabId) {
    if (!Number.isSafeInteger(sourceTabId) || sourceTabId < 0) throw browserError("BROWSER_INVALID", "The popup must supply an exact source tab ID.");
    const source = await host.getTab(sourceTabId);
    if (!/^https?:\/\//.test(source.url || "")) throw browserError("BROWSER_INVALID", "Study this site requires an ordinary HTTP/HTTPS source tab.");
    const [options, templates] = await Promise.all([
      host.studyOptions ? host.studyOptions() : { detailedLogging: false },
      host.promptTemplates ? host.promptTemplates().then(normalizeStartupPrompts) : normalizeStartupPrompts()
    ]);
    const trace = createBrowserDiagnostics({ enabled: options.detailedLogging, log, now: host.monotonicNow || host.now });
    let group = null, agent = null, chat = null, stopped = false, phase = "duplicating";
    const checkStarting = () => {
      if (stopped || group && ["stopped", "failed"].includes(group.state)) throw browserError("BROWSER_SESSION_STOPPED", "Study startup stopped.");
    };
    const notify = async value => {
      phase = value;
      const status = { state: value === "running" ? "running" : "starting", phase: value, statusMessage: SESSION_MESSAGES[value], error: null };
      if (group) { group.phase = value; }
      for (const id of [agent?.id, chat?.id].filter(Number.isInteger)) statuses.set(id, status);
      await host.updateStatus?.([agent?.id, chat?.id].filter(Number.isInteger), status);
      log("startup", { groupId: group?.groupId, phase: value });
    };
    try {
      agent = await host.duplicateTab(sourceTabId);
      if (source.active) await host.restoreSource(sourceTabId);
      await notify("creatingChat");
      chat = await host.createChatTab(source, agent);
      // Group membership is now functional, not an optional visual decoration.
      const groupId = await host.groupTabs([agent.id, chat.id], browserStudyGroupTitle(source));
      if (!Number.isSafeInteger(groupId) || groupId < 0) throw browserError("BROWSER_GROUP_NOT_FOUND", "Chrome could not create the study tab group.");
      group = await groups.get(groupId, options, chat.id); group.state = "starting"; group.startup = { chatTabId: chat.id, check: checkStarting };
      await groups.refresh(group);
      const target = targetFor(group, await host.getTab(agent.id)); target.trace = trace;
      await notify("connecting");
      await queue(agent.id, async () => { checkStarting(); await ensureTarget(target, () => notify("waitingForPage")); checkStarting(); });
      await notify("waitingForChat");
      const prompt = renderStartupPrompt("studyThisSitePrompt", templates, {
        chat_tab_id: chat.id, site_tab_id: agent.id, group_id: groupId,
        site_title: source.title || "", site_link: safePageUrl(source.url)
      });
      const chatPath = await host.startChat(chat.id, prompt, checkStarting, notify, trace);
      if (!chatPath) throw browserError("BROWSER_CHAT_NOT_FOUND", "The leading ChatGPT conversation must be confirmed.");
      checkStarting(); group.state = "running"; await groups.refresh(group); groups.acknowledge(group);
      await notify("running"); group.startup = null;
      log("group started", { groupId, chatTabId: chat.id });
      return { ok: true, chatTabId: chat.id, group: groups.project(group) };
    } catch (error) {
      stopped = true;
      const normalStop = ["TAB_CLOSED", "BROWSER_SESSION_STOPPED", "BROWSER_CANCELLED"].includes(error.code);
      if (group) { await stopGroup(group); group.state = normalStop ? "stopped" : "failed"; group.error = normalStop ? null : { code: error.code || "BROWSER_UNAVAILABLE", message: error.code ? error.message : "Study startup failed." }; }
      const status = { state: normalStop ? "stopped" : "failed", phase, statusMessage: "Study startup stopped.", error: normalStop ? null : group?.error || { code: error.code || "BROWSER_UNAVAILABLE", message: error.message } };
      for (const id of [agent?.id, chat?.id].filter(Number.isInteger)) statuses.set(id, status);
      await host.updateStatus?.([agent?.id, chat?.id].filter(Number.isInteger), status);
      log("startup failed", { groupId: group?.groupId, phase, code: error.code || "BROWSER_UNAVAILABLE" });
      if (normalStop) return { ok: true, chatTabId: chat?.id ?? null, group: group ? groups.project(group) : null };
      throw browserError(error.code || "BROWSER_UNAVAILABLE", error.code ? error.message : "Study startup failed. Check the worker console.");
    }
  }
  async function readStream(stream, task, session, target, maximum) {
    const chunks = []; let size = 0;
    try {
      for (;;) {
        checkTask(task, session);
        const read = await session.page.command("IO.read", { handle: stream, size: 65536 }, target);
        const chunk = read.base64Encoded ? bytesOf(read.data) : new TextEncoder().encode(read.data);
        size += chunk.byteLength;
        if (size > maximum) throw browserError("BROWSER_RESOURCE_TOO_LARGE", `The resource exceeds the configured upload maximum of ${maximum / 1048576} MiB.`);
        chunks.push(chunk);
        if (read.eof) break;
      }
    } finally { await session.page.command("IO.close", { handle: stream }, target).catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async function extract(item, task, session, maximum) {
    const page = session.page, target = item.entry.target;
    await verifyResource(item, session);
    // Prefer Chrome's authenticated resource loader over page fetch/CORS.
    if (item.url && /^https?:\/\//.test(item.url)) {
      try {
        const response = await page.command("Network.loadNetworkResource", { frameId: target.frameId, url: item.url, options: { disableCache: false, includeCredentials: true } }, target);
        if (response.resource?.success && response.resource.stream) {
          const bytes = await readStream(response.resource.stream, task, session, target, maximum);
          const headers = response.resource.headers || {};
          const mimeType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]?.split(";")[0] || "application/octet-stream";
          if (bytes.length && (item.kind !== "image" || isImage(bytes))) return { bytes, mimeType, extraction: "original" };
        }
      } catch (error) { if (["BROWSER_CANCELLED", "BROWSER_RESOURCE_TOO_LARGE"].includes(error.code)) throw error; }
      try {
        // CDP cache bodies are returned in one message. Only use a known,
        // bounded cache entry; otherwise use the streaming loader/fallback.
        const resourceTree = await page.command("Page.getResourceTree", {}, target);
        const find = tree => (tree?.resources || []).find(resource => resource.url === item.url) || (tree?.childFrames || []).map(find).find(Boolean);
        const cachedInfo = find(resourceTree.frameTree);
        if (!Number.isFinite(cachedInfo?.contentSize) || cachedInfo.contentSize > maximum) throw browserError("BROWSER_RESOURCE_UNAVAILABLE", "No bounded browser cache entry is available.");
        const cached = await page.command("Page.getResourceContent", { frameId: target.frameId, url: item.url }, target);
        const bytes = cached.base64Encoded ? bytesOf(cached.content) : new TextEncoder().encode(cached.content);
        if (bytes.length > maximum) throw browserError("BROWSER_RESOURCE_TOO_LARGE", "The original resource exceeds the configured upload size maximum.");
        if (bytes.length && (item.kind !== "image" || isImage(bytes))) return { bytes, mimeType: cachedInfo.mimeType || "application/octet-stream", extraction: "browser-cache" };
      } catch (error) { if (error.code === "BROWSER_RESOURCE_TOO_LARGE") throw error; }
    }
    if (item.url && /^(data:|blob:)/.test(item.url) || ["canvas", "svg"].includes(item.rendering)) {
      try {
        const rendered = await page.withElement(item.entry, async function (url, rendering, maximum) {
          let blob;
          if (rendering === "canvas") blob = await new Promise(resolve => this.toBlob(resolve, "image/png"));
          else if (rendering === "svg") blob = new Blob([new XMLSerializer().serializeToString(this)], { type: "image/svg+xml" });
          else { const response = await fetch(url, { credentials: "include" }); blob = await response.blob(); }
          if (!blob) return null;
          if (blob.size > maximum) return { tooLarge: true };
          return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ url: reader.result, mimeType: blob.type }); reader.onerror = reject; reader.readAsDataURL(blob); });
        }, [item.url, item.rendering, maximum]);
        if (rendered?.tooLarge) throw browserError("BROWSER_RESOURCE_TOO_LARGE", "The rendered resource exceeds the configured upload maximum.");
        if (rendered?.url) return { bytes: bytesOf(rendered.url.split(",")[1]), mimeType: rendered.mimeType || "application/octet-stream", extraction: item.rendering ? "dom-rendering" : "original" };
      } catch (error) { if (error.code === "BROWSER_RESOURCE_TOO_LARGE") throw error; }
    }
    if (item.kind !== "image") throw browserError("BROWSER_RESOURCE_UNAVAILABLE", "The original resource could not be read from this browser session. No screenshot can substitute for an audio, video or document file.");
    await waitRunning(task, session);
    await page.requireNode(item.entry.id);
    let clip = null;
    try {
      await page.command("DOM.scrollIntoViewIfNeeded", { backendNodeId: item.entry.backendNodeId }, target);
      const model = (await page.command("DOM.getBoxModel", { backendNodeId: item.entry.backendNodeId }, target)).model;
      const quad = model.content;
      const bounds = { x: Math.min(quad[0], quad[2], quad[4], quad[6]), y: Math.min(quad[1], quad[3], quad[5], quad[7]), width: Math.max(quad[0], quad[2], quad[4], quad[6]) - Math.min(quad[0], quad[2], quad[4], quad[6]), height: Math.max(quad[1], quad[3], quad[5], quad[7]) - Math.min(quad[1], quad[3], quad[5], quad[7]) };
      const viewport = (await page.command("Page.getLayoutMetrics", {}, target)).cssVisualViewport;
      if (bounds?.width > 0 && bounds?.height > 0) {
        const x = Math.max(0, bounds.x), y = Math.max(0, bounds.y);
        const width = Math.min(bounds.width + Math.min(0, bounds.x), viewport.clientWidth - x), height = Math.min(bounds.height + Math.min(0, bounds.y), viewport.clientHeight - y);
        if (width > 0 && height > 0) clip = { x: x + viewport.pageX, y: y + viewport.pageY, width, height, scale: 1 };
      }
    } catch { /* Last resort is a normal viewport image, never a full page. */ }
    await waitRunning(task, session);
    const screenshot = await page.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip } : {}) }, target);
    const bytes = bytesOf(screenshot.data);
    if (bytes.length > maximum) throw browserError("BROWSER_RESOURCE_TOO_LARGE", "The image fallback exceeds the configured upload maximum.");
    return { bytes, mimeType: "image/png", extraction: clip ? "element-screenshot" : "viewport-screenshot" };
  }
  async function verifyResource(item, session) {
    const entry = await session.page.requireNode(item.entry.id);
    const currentDom = await session.page.withElement(entry, inspectBrowserElement);
    if (!currentDom || item.url && !currentDom.resources?.some(resource => resource.url === item.url && resource.kind === item.kind)) throw browserError("STALE_NODE", "The requested resource changed in the DOM. Inspect its current node before requesting it again.");
    // Also catches frame navigation during DOM inspection without rereading
    // unrelated page content or redirecting the selected resource.
    await session.page.requireNode(item.entry.id);
  }
  async function runResource(task, session, items, addToChat, toolName) {
    try {
      checkTask(task, session); task.status = "working"; progress(task, "extracting", 10);
      await queue(session.agentTabId, async () => {
      session.operation = task.caller;
      try {
      await waitRunning(task, session);
      const maximum = await host.resourceLimit();
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        await waitRunning(task, session);
        if (item.pageVersion !== session.pageVersion) throw browserError("PAGE_CHANGED", "The page navigated before extraction finished. No resource was attached.");
        const result = await session.trace.span("resource.extract", () => extract(item, task, session, maximum), { taskId: task.taskId, resourceNumber: index + 1 });
        if ((toolName === "site_get_images") !== isImage(result.bytes)) throw browserError("BROWSER_RESOURCE_TYPE_MISMATCH", `${toolName} received a different file type. No mismatched file was saved or attached.`);
        task.sizeBytes = (task.sizeBytes || 0) + result.bytes.length;
        session.trace.event("resource.extracted", { taskId: task.taskId, resourceNumber: index + 1, bytes: result.bytes.length, extraction: result.extraction });
        checkTask(task, session); await check(session, false);
        if (item.pageVersion !== session.pageVersion) throw browserError("PAGE_CHANGED", "The page navigated before extraction finished. No resource was attached.");
        await verifyResource(item, session);
        progress(task, "saving", Math.round(10 + 50 * (index + 1) / items.length));
        const saved = await session.trace.span("resource.save", () => host.saveResource(task.taskId, result.bytes, result.mimeType, task.resourceIds[index]), { taskId: task.taskId, resourceNumber: index + 1, bytes: result.bytes.length });
        task.files.push({ resourceId: task.resourceIds[index], workspacePath: saved.workspacePath, mimeType: saved.mimeType, extraction: result.extraction, sizeBytes: saved.sizeBytes });
        if (items.length === 1) { task.workspacePath = saved.workspacePath; task.mimeType = saved.mimeType; task.extraction = result.extraction; }
        checkTask(task, session);
      }
      } finally { session.operation = null; }
      });
      if (addToChat) {
        await waitRunning(task, session);
        if (items.some(item => item.pageVersion !== session.pageVersion)) throw browserError("PAGE_CHANGED", "The page navigated before resource delivery. Saved files were preserved; no resource was attached.");
        for (const item of items) await verifyResource(item, session);
        progress(task, "attaching", 65);
        const files = await session.trace.span("resource.resolveFiles", () => host.resolveFiles(task.files.map(file => file.workspacePath)), { taskId: task.taskId });
        checkTask(task, session);
        const continuation = `Requested browser resource(s) ${task.resourceIds.join(", ")} attached. Continue the current Study Page task using chatTabId: ${task.chatTabId} and source tabId: ${task.tabId}.`;
        await host.attachFiles(files, {
          target: { tabId: task.chatTabId, chatPath: task.caller.chatPath, ...(task.caller.cloudTarget ? {cloudTarget:task.caller.cloudTarget} : {}) }, continuation,
          trace: session.trace, taskId: task.taskId,
          checkCancelled: () => checkTask(task, session),
          beforeSend: async () => {
            await waitRunning(task, session);
            if (items.some(item => item.pageVersion !== session.pageVersion)) throw browserError("PAGE_CHANGED", "The page navigated before Send. Saved files and Composer attachments were preserved.");
            for (const item of items) await verifyResource(item, session);
          },
          onPhase: async phase => { checkTask(task, session); progress(task, phase === "composerAccepted" ? "waitingToSend" : phase, phase === "composerAccepted" ? 80 : 70); },
          onSendCommit: () => { checkTask(task, session); if (session.group.state !== "running") throw browserError("BROWSER_SESSION_NOT_READY", "The session is not ready to send."); task.sendCommitted = true; }
        });
        task.submittedFiles = task.files.map(file => file.workspacePath); task.submittedAt = timestamp();
      }
      task.status = "completed"; progress(task, addToChat ? "submitted" : "saved", 100);
    } catch (error) {
      if (!task.cancelRequested) { task.status = "failed"; task.error = { code: error.code || "BROWSER_RESOURCE_UNAVAILABLE", message: error.code ? error.message : "Browser resource extraction or delivery failed. Saved files and any Composer attachments were preserved." }; progress(task, "failed", task.progressPercent); }
    } finally {
      task.finishPhase?.({ outcome: task.status }); task.finishPhase = null;
      await host.taskCompleted?.({ ...publicTask(task), tabId: task.chatTabId, suppressCompletionNotification: addToChat });
      session.trace.event("resource.total", { taskId: task.taskId, elapsedMs: session.trace.now() - task.startedMonotonic, bytes: task.sizeBytes, extraction: task.extraction, outcome: task.status, code: task.error?.code });
      pruneCompletedTasks(tasks, host.historyLimit?.() || 2000);
    }
  }
  async function execute(name, argumentsValue, cloudTarget = null) {
    const input = validateBrowserInput(name, argumentsValue);
    const { group, member } = await groups.forChat(input.chatTabId);
    const result = await executeInGroup(name, input, group, member, cloudTarget);
    await groups.check(group, input.chatTabId, member.chatPath, { allowStopped: true });
    const fullSnapshot = ["site_list_tabs", "site_session_status"].includes(name) && result.group.revision === group.revision;
    const changes = groups.reportChanges(group, fullSnapshot);
    const response = { ...result, ...(changes.groupChanges ? { groupChanges: changes.groupChanges } : {}) };
    changes.commit();
    return response;
  }
  async function executeInGroup(name, input, group, member, cloudTarget = null) {
    const caller = { group, cloudTarget, chatTabId: input.chatTabId, chatPath: member.chatPath, tool: name, action: input.action };
    if (["site_list_tabs", "site_session_status"].includes(name)) {
      return { chatTabId: input.chatTabId, group: groups.project(group, input.offset, input.limit) };
    }
    if (["site_files_status", "site_files_cancel"].includes(name)) {
      const task = tasks.get(input.taskId);
      if (!task || task.groupId !== group.groupId) throw browserError("BROWSER_TASK_NOT_FOUND", "This task is not in your current group, or its history expired.");
      return name === "site_files_status" ? publicTask(task) : { cancelled: cancelTask(task), task: publicTask(task) };
    }
    if (name === "site_session_stop") return { chatTabId: input.chatTabId, group: await stopGroup(group) };
    await groups.check(group, input.chatTabId, caller.chatPath);
    const tab = await groups.check(group, input.tabId);
    if (isChatTab(tab)) throw browserError("BROWSER_INVALID", "Page tools control site tabs, not ChatGPT chats.");
    const target = targetFor(group, tab);
    const result = await queue(input.tabId, async () => {
      target.operation = caller;
      try {
        await groups.check(group, input.chatTabId, caller.chatPath);
        await ensureTarget(target);
        return await target.trace.span(`tool.${name}`, async () => {
          if (name === "site_read") return target.page.observe(input);
          if (name === "site_get_children") return target.page.observe({ ...input, mode: "subtree", depth: input.depth ?? 1 });
          if (name === "site_get_node") return target.page.getNode(input.nodeId);
          if (name === "site_get_text") return target.page.getText(input.nodeId, input.offset, input.limit);
          if (name === "site_interact") return target.page.act(input);
          if (["site_get_images", "site_get_files"].includes(name)) {
            const resourceIds = input.resourceIds ? [...input.resourceIds] : [input.resourceId];
            const maximumCount = await (host.resourceCountLimit?.() ?? 20);
            if (!Number.isSafeInteger(maximumCount) || maximumCount < 1 || resourceIds.length > maximumCount) throw browserError("BROWSER_INVALID", `The configured resource batch maximum is ${maximumCount}. No task was created.`);
            const items = resourceIds.map(id => target.page.getResource(id));
            if (items.some(item => name === "site_get_images" ? item.kind !== "image" : !["document", "audio", "video"].includes(item.kind))) throw browserError("BROWSER_RESOURCE_TYPE_MISMATCH", "Choose images with site_get_images and documents, audio or video with site_get_files. No task was created.");
            const task = newTask(caller, input.tabId, "files", resourceIds, input.resourceId || null);
            task.trace = target.trace; task.startedMonotonic = task.trace.enabled ? task.trace.now() : 0;
            task.finishPhase = task.trace.begin("resource.queue", { taskId: task.taskId });
            const initial = publicTask(task);
            host.schedule(() => runResource(task, target, items, input.addToChat !== false, name));
            return initial;
          }
          throw browserError("BROWSER_INVALID", "Unknown site tool.");
        });
      } finally { target.operation = null; }
    });
    if (Object.hasOwn(result, "taskId")) return result;
    await groups.check(group, input.chatTabId, caller.chatPath);
    await groups.refresh(group);
    return { ...result, chatTabId: input.chatTabId, tabId: input.tabId, group: groups.project(group),
      ...(result.observation ? { observation: { ...result.observation, chatTabId: input.chatTabId, group: groups.project(group) } } : {}) };
  }
  function discardChildSessions(session, childId) {
    const removed = new Set([childId]);
    for (;;) { const size = removed.size; for (const child of session.childSessions.values()) if (removed.has(child.parentSessionId)) removed.add(child.sessionId); if (size === removed.size) break; }
    for (const id of removed) { session.page.invalidateFrame(null, id); session.childSessions.delete(id); }
  }
  async function onEvent(source, method, params = {}) {
    const session = targets.get(source.tabId);
    if (!session || session.error || !session.attached) return;
    if (source.sessionId && !session.childSessions.has(source.sessionId)) return;
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      if (!isBrowserFrameUrlAllowed(params.targetInfo.url)) {
        session.trace.event("target.frameSkipped", { code: "BROWSER_FRAME_RESTRICTED" }); return;
      }
      const child = { sessionId: params.sessionId, parentSessionId: source.sessionId || null, targetId: params.targetInfo.targetId, url: params.targetInfo.url, ready: false };
      session.childSessions.set(params.sessionId, child);
      try {
        await withBrowserFrameTimeout(() => enableTarget(session, params.sessionId, () => {
          if (session.childSessions.get(params.sessionId) !== child || !session.attached || targets.get(session.agentTabId) !== session)
            throw browserError("BROWSER_FRAME_UNAVAILABLE", "The child frame left during initialization.");
        }), host.frameTimeoutMs);
        if (session.childSessions.get(params.sessionId) === child) child.ready = true;
      } catch (error) {
        if (session.childSessions.get(params.sessionId) === child) {
          discardChildSessions(session, params.sessionId);
        }
        session.trace.event("target.frameSkipped", { code: error.code || "BROWSER_UNAVAILABLE" });
      }
      session.revision += 1;
    } else if (method === "Target.targetInfoChanged") {
      for (const child of session.childSessions.values()) if (child.targetId === params.targetInfo?.targetId && !isBrowserFrameUrlAllowed(params.targetInfo.url)) {
        discardChildSessions(session, child.sessionId); session.revision += 1;
      }
    } else if (method === "Target.detachedFromTarget") {
      discardChildSessions(session, params.sessionId);
      session.revision += 1;
    }
    else if (method === "Page.frameNavigated") {
      if (!source.sessionId && !params.frame?.parentId) { session.mainFrameId = params.frame.id; session.url = params.frame.url; session.pageVersion = nextPageVersion(); session.page.invalidate(); }
      // Keep unrelated main-page and sibling-frame references usable.
      else session.page.invalidateFrame(params.frame?.id, source.sessionId || null);
      if (source.sessionId && !isBrowserFrameUrlAllowed(params.frame?.url)) discardChildSessions(session, source.sessionId);
      session.revision += 1;
    } else if (method === "Page.frameDetached" && params.reason !== "swap") {
      session.page.invalidateFrame(params.frameId, source.sessionId || null); session.revision += 1;
    } else if (method === "Page.navigatedWithinDocument") {
      if (!source.sessionId && params.frameId === session.mainFrameId) session.url = params.url;
      // Hash/history navigation keeps the document alive. Actual target/content
      // changes are detected by AX/DOM validation and the next local difference.
      session.revision += 1;
    } else if (["Accessibility.nodesUpdated", "Accessibility.loadComplete", "DOM.documentUpdated"].includes(method)) session.revision += 1;

  }
  async function onRemoved(tabId) {
    for (const group of groups.values()) if (group.members.has(tabId)) {
      cancelForTab(group, tabId);
      if (tabId === group.ownerTabId) await stopGroup(group);
      await dropTarget(group, tabId, "TAB_CLOSED");
    }
    statuses.delete(tabId);
    await groups.changed();
  }
  async function onDetached(source, reason) {
    const target = targets.get(source.tabId);
    if (!target?.attached) return;
    target.attached = false;
    if (reason === "target_closed") return onRemoved(source.tabId);
    cancelForTab(target.group, source.tabId);
    target.error = { code: "DEBUGGER_DETACHED", message: "Chrome detached this participant's debugger. Other group tabs remain available; move this tab out and back to reconnect." };
    target.trace.event("target.detached", { code: "DEBUGGER_DETACHED", tabId: source.tabId });
    await host.updateStatus?.([source.tabId], { state: "failed", phase: "failed", statusMessage: target.error.message, error: target.error });
  }
  async function onUpdated(tabId, change) {
    if (change.status === "complete" || Object.hasOwn(change, "url")) groups.documentChanged(tabId);
    if (change.status === "complete" || Object.hasOwn(change, "groupId") || Object.hasOwn(change, "url") || Object.hasOwn(change, "title")) await groups.changed();
  }
  function localStatus(tabId) {
    for (const group of groups.values()) if (group.members.has(tabId)) {
      const target = group.targets.get(tabId);
      return { state: target?.error ? "failed" : group.state, phase: target?.error ? "failed" : group.phase,
        statusMessage: target?.error?.message || SESSION_MESSAGES[group.phase] || "Tab group automation is active.", error: target?.error || group.error };
    }
    return statuses.get(tabId) || null;
  }
  async function connectGroup(chatTabId, checkPending = () => {}) {
    const { group } = await groups.forChat(chatTabId, {claim:true,checkPending});
    checkPending();
    if (group.state === "starting") throw browserError("BROWSER_SESSION_NOT_READY", "Wait for the existing study startup to finish.");
    // Only a new explicit widget connection resumes Stop; status never does.
    if (["stopped", "failed"].includes(group.state)) { group.state = "running"; group.phase = "running"; group.error = null; await groups.refresh(group); }
    groups.acknowledge(group);
    return { chatTabId, group: groups.project(group) };
  }
  async function recoverGroups() {
    const tabs = await host.queryChatTabs?.() || [];
    const seen = new Set();
    await Promise.allSettled(tabs.filter(tab => Number.isSafeInteger(tab.groupId) && tab.groupId >= 0 && host.conversationPath(tab.url) && !seen.has(tab.groupId) && seen.add(tab.groupId)).map(async tab => { const group = await groups.get(tab.groupId); await groups.refresh(group); }));
  }
  return { start, execute, connectGroup, recoverGroups, onEvent, onRemoved, onDetached, onUpdated, onCreated: groups.changed, onReplaced: groups.changed,
    localStatus, ownsTab: id => [...groups.values()].some(group => !["stopped", "failed"].includes(group.state) && group.members.has(id)) };
}
