import { browserError, validateBrowserInput } from "./browser-tools.js";
import { createBrowserPage, inspectBrowserElement, safePageUrl } from "./browser-page.js";
import { pruneCompletedTasks } from "./task-history.js";
import { createBrowserDiagnostics } from "./browser-diagnostics.js";
import { createBrowserGroups, tabScopeKey } from "./browser-groups.js";
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
  creatingChat: "Opening the initial ChatGPT chat…",
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
  const tasks = new Map(), targets = new Map(), localTargets = new Map(), statuses = new Map();
  const targetMap = target => target.local ? localTargets : targets;
  const localQueue = createTabAutomationQueue();
  const queue = host.queue || localQueue.run;
  const codexQueue = createTabAutomationQueue();
  // One creation lock for all research groups, including Codex. Count the
  // actual Chrome membership (including chats and non-web tabs).
  const groupCreationQueue = createTabAutomationQueue();
  async function checkTabCapacity(groupId, additional = 1) {
    const limit = await (host.maxTabsPerGroup?.() ?? 20);
    if (!Number.isSafeInteger(limit) || limit < 1) throw browserError("BROWSER_INVALID","Invalid maxTabsPerGroup.");
    const count = groupId == null ? 0 : (await host.queryTabs(groupId)).length;
    if (count + additional > limit) {
      log("group tab limit",{groupId,limit,count});
      throw browserError("GROUP_TAB_LIMIT_REACHED",`Group has ${count} tabs; maximum ${limit}. Pass tabId of an existing site tab to navigate it, or remove a tab manually.`);
    }
  }
  function protectedChat(tab) {
    return [tab.url,tab.pendingUrl].some(value=>{try{return new URL(value).hostname==="chatgpt.com" || new URL(value).hostname==="chat.openai.com";}catch{return false;}});
  }
  async function navigateExisting(input,url,verify) {
    return queue(input.tabId,async()=>{
      await verify();
      const tab = await host.getTab(input.tabId).catch(()=>{throw browserError("TAB_CLOSED","The selected tab closed.");});
      if (protectedChat(tab)) throw browserError("BROWSER_READ_ONLY","site_open cannot navigate an existing ChatGPT tab.");
      await verify(tab);
      if (!/^https?:\/\//.test(tab.url || "") && tab.url!=="about:blank") throw browserError("BROWSER_READ_ONLY","Choose an ordinary site tab.");
      if (new URL(tab.pendingUrl || tab.url).href === url) return "reused";
      if (tab.pendingUrl) throw browserError("BROWSER_BUSY","The selected tab is already navigating.");
      for (const task of tasks.values()) if (task.tabId===tab.id && !TERMINAL.has(task.status))
        throw browserError("BROWSER_BUSY","The selected tab has an active resource task.");
      // Revalidate exact live membership and caller just before navigation.
      const live = await host.getTab(input.tabId);
      if (live.url !== tab.url || live.pendingUrl || protectedChat(live)) throw browserError("PAGE_CHANGED","The selected tab changed.");
      await verify(live);
      for (const session of [targets.get(tab.id),localTargets.get(tab.id)].filter(Boolean)) {
        session.pageVersion=nextPageVersion();session.revision++;session.page.invalidate();
      }
      await host.navigateSiteTab(tab.id,url);
      return "opening";
    });
  }
  // Chrome group IDs are browser-session scoped; never infer ownership from title.
  let codexGroupId = null;
  async function codexGroup() {
    const id = host.readCodexGroup ? await host.readCodexGroup() : codexGroupId;
    if (!Number.isSafeInteger(id) || id < 0) return null;
    const tabs = (await host.queryTabs(id)).filter(tab => tab.groupId === id);
    return tabs.length ? {id,tabs} : null;
  }
  async function rememberCodexGroup(id) {
    await host.writeCodexGroup?.(id);
    codexGroupId = id;
  }
  async function assertCodexControl(tab) {
    const own = await codexGroup();
    if (!own || tab.groupId !== own.id || !own.tabs.some(item => item.id === tab.id))
      throw browserError("BROWSER_READ_ONLY","Codex may control only tabs in its own RT · Codex group. Use site_open to open a controllable tab.");
  }
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
    removed: async (group, tabId, code) => { forgetCaller(group, tabId); cancelForTab(group, tabId); await dropTarget(group, tabId, code); },
    conversationChanged: async (group, tabId) => { forgetCaller(group, tabId); cancelForTab(group, tabId); },
    startupLeft: group => stopGroup(group, group.startup.chatTabId)
  });
  const command = async (tabId, method, params = {}, childSessionId = null) => {
    try {
      const trace = localTargets.get(tabId)?.operation ? localTargets.get(tabId).trace : (targets.get(tabId) || localTargets.get(tabId))?.trace;
      return await (trace ? trace.command(method, () => host.command(tabId, method, params, childSessionId)) : host.command(tabId, method, params, childSessionId));
    } catch { throw browserError("BROWSER_UNAVAILABLE", `Chrome could not complete ${method}. The page may be loading, closed or detached.`); }
  };
  const publicTask = task => ({ ...Object.fromEntries(["taskId", "chatTabId", "tabId", "groupId", "kind", "resourceId", "resourceIds", "files", "status", "phase", "progressPercent", "pollIntervalMs", "createdAt", "updatedAt", "workspacePath", "mimeType", "extraction", "submittedFiles", "submittedAt", "error"].map(key => [key, structuredClone(task[key])])), ...(task.caller.local ? {} : {group: groups.project(task.caller.group, task.chatTabId)}) });
  function newTask(caller, tabId, kind, resourceIds = [], resourceId = null) {
    let taskId; do { taskId = host.id?.() || randomId("tsk"); } while (tasks.has(taskId));
    const task = { taskId, chatTabId: caller.chatTabId, tabId, groupId: caller.group?.groupId ?? null, kind,
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
  function forgetCaller(group, tabId) {
    for (const target of targets.values()) target.page.forgetCaller(tabId);
  }
  function cancelForTab(group, tabId) {
    for (const task of tasks.values()) if ((task.caller.group === group || task.caller.targetGroup === group) && (task.tabId === tabId || task.chatTabId === tabId)) cancelTask(task);
  }
  function checkTask(task, session) {
    task.caller.cloudGuard?.assertLive?.();
    if (task.cancelRequested || (!task.caller.local && (["stopped", "failed"].includes(session.group.state) || ["stopped", "failed"].includes(task.caller.group.state))) || session.error || targetMap(session).get(session.agentTabId) !== session)
      throw browserError("BROWSER_CANCELLED", "The task was cancelled or its selected participant stopped. Existing files and attachments were preserved.");
  }
  async function waitRunning(task, session) {
    checkTask(task, session);
    await task.caller.cloudGuard?.();
    if (!task.caller.local) await groups.check(task.caller.group, task.chatTabId, task.caller.chatPath);
    await check(session);
    if (!task.caller.local && session.group.state === "starting") throw browserError("BROWSER_SESSION_NOT_READY", "Wait for study initialization.");
    checkTask(task, session);
  }
  async function readTab(tabId) {
    const tab = await host.getTab(tabId).catch(() => { throw browserError("TAB_CLOSED","The selected tab closed."); });
    if (!/^https?:\/\//.test(tab.url || "")) throw browserError("BROWSER_UNAVAILABLE","Only ordinary HTTP/HTTPS pages can be read.");
    return tab;
  }
  async function check(session, mutation = false) {
    await session.operation?.cloudGuard?.();
    if (session.error) throw browserError(session.error.code, session.error.message);
    if (targetMap(session).get(session.agentTabId) !== session) throw browserError(session.local ? "PAGE_CHANGED" : "TAB_LEFT_GROUP", "The selected observation is no longer available.");
    const tab = session.local ? await readTab(session.agentTabId) : await groups.check(session.group, session.agentTabId);
    if (session.local && mutation) {
      if (session.operation?.tool !== "site_interact" || session.operation.readOnly) throw browserError("BROWSER_READ_ONLY","Local browser reads cannot mutate a page.");
      await assertCodexControl(tab);
    }
    if (!session.local && session.operation) {
      if (!session.operation.local) await groups.check(session.operation.group, session.operation.chatTabId, session.operation.chatPath);
      if (mutation && (session.operation.group !== session.group || session.group.groupId < 0 || session.operation.readOnly))
        throw browserError("BROWSER_READ_ONLY", "Only tabs in the initiating chat's actual Chrome group may be controlled.");
    }
    if (mutation && !session.local && session.group.state !== "running") throw browserError("BROWSER_SESSION_NOT_READY", "Wait for study initialization.");
    if (session.url !== tab.url) { session.url = tab.url; session.pageVersion = nextPageVersion(); session.revision++; session.page.invalidate(); }
    session.title = tab.title || "";
    return tab;
  }
  async function enableTarget(session, childId = null, checkEnabled = () => {}) {
    for (const domain of ["Page", "Runtime", "DOM", "Accessibility", "Network"]) {
      checkEnabled(); await command(session.agentTabId, `${domain}.enable`, {}, childId); checkEnabled();
    }
    await command(session.agentTabId, "Target.setAutoAttach", AUTO_ATTACH, childId);
    if (!childId && !session.local && !session.operation?.readOnly) {
      await command(session.agentTabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      await command(session.agentTabId, "Page.setWebLifecycleState", { state: "active" });
      session.controlReady = true;
    }
  }
  function targetFor(group, tab, localOptions = null) {
    const local = localOptions !== null;
    let target = local ? localTargets.get(tab.id) : group.targets.get(tab.id);
    if (target) return target;
    const options = local ? localOptions : group.options;
    target = { group, local, agentTabId: tab.id, observation: options.observation, state: "running", url: tab.url, title: tab.title || "",
      pageVersion: nextPageVersion(), revision: 1, childSessions: new Map(), attached: false, error: null, operation: null, lastPageCallEnd: null };
    target.trace = createBrowserDiagnostics({ enabled: options.detailedLogging, groupId: group?.groupId ?? null, log, onError: details => host.diagnostic?.({ ...details, tool: target.operation?.tool, tabId: target.agentTabId, chatTabId: target.operation?.chatTabId }), now: host.monotonicNow || host.now });
    target.page = createBrowserPage(target, { command, check, trace: target.trace,
      onStep: timing => { if (!local) host.onStep?.({ ...timing, groupId: group.groupId, tabId: target.agentTabId }); },
      context: () => local ? {} : ({ chatTabId: target.operation?.chatTabId ?? target.agentTabId, group: groups.project(target.operation?.group ?? group, target.operation?.chatTabId ?? target.agentTabId) }) });
    if (!local) group.targets.set(tab.id, target);
    targetMap(target).set(tab.id, target); return target;
  }
  async function ensureTarget(target, onDocument = null) {
    await check(target);
    if (!target.attached) {
      try { await host.attach(target.agentTabId); }
      catch (error) { const failure = browserAttachmentError(error); target.trace.event("target.attachFailed", { tabId: target.agentTabId, code: failure.code }); throw failure; }
      target.attached = true;
      try {
        const peer = (target.local ? targets : localTargets).get(target.agentTabId);
        if (peer?.attached && peer.domainsReady && !peer.error) {
          target.childSessions = new Map([...peer.childSessions].map(([id,child]) => [id,{...child}]));
          target.domainsReady = true;
        } else { await enableTarget(target); target.domainsReady = true; }
        await onDocument?.(); await host.waitReady(target.agentTabId, () => {
        if (target.error || targetMap(target).get(target.agentTabId) !== target) throw browserError("BROWSER_CANCELLED", "The target left during initialization.");
      }, target.trace); }
      catch (error) { if (target.local) await dropLocalTarget(target.agentTabId); else await dropTarget(target.group, target.agentTabId, error.code || "BROWSER_UNAVAILABLE"); throw error; }
    }
    // A previous read-only attachment never grants permission to mutate.
    // Enable normal in-group focus only for a subsequently validated local operation.
    if (!target.local && !target.operation?.readOnly && !target.controlReady) {
      await check(target, true);
      await command(target.agentTabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      await command(target.agentTabId, "Page.setWebLifecycleState", { state: "active" });
      target.controlReady = true;
    }
  }
  async function dropLocalTarget(tabId) {
    const target = localTargets.get(tabId);
    if (!target) return;
    localTargets.delete(tabId);
    for (const task of tasks.values()) if (task.caller.local && task.tabId === tabId) cancelTask(task);
    target.error = {code:"PAGE_CHANGED",message:"The local observation ended. Read the tab again."};
    target.page.invalidate(); target.childSessions.clear();
    if (target.attached) { target.attached = false; await (host.detachReadOnly || host.detach)(tabId).catch(() => {}); }
  }
  async function dropTarget(group, tabId, code = "TAB_LEFT_GROUP") {
    const target = group.targets.get(tabId);
    if (target) {
      target.error = { code, message: "Automation for this participant stopped; other group tabs remain available." };
      target.page.invalidate(); target.childSessions.clear();
      group.targets.delete(tabId); if (targets.get(tabId) === target) targets.delete(tabId);
      if (target.attached) {
        target.attached = false;
        if (target.controlReady && localTargets.get(tabId)?.attached) await host.command(tabId,"Emulation.setFocusEmulationEnabled",{enabled:false}).catch(() => {});
        await host.detach(tabId).catch(() => {});
      }
    }
    await host.updateStatus?.([tabId], { state: "stopped", phase: "stopped", statusMessage: "Participant automation stopped.", error: null });
  }
  async function stopGroup(group, chatTabId) {
    group.state = "stopped"; group.phase = "stopped";
    for (const task of tasks.values()) if (task.caller.group === group || task.caller.targetGroup === group) cancelTask(task);
    for (const tabId of [...group.targets.keys()]) await dropTarget(group, tabId, "BROWSER_SESSION_STOPPED");
    await host.updateStatus?.([...group.members.keys()], { state: "stopped", phase: "stopped", statusMessage: "Group automation stopped.", error: null });
    await groups.saveState(group);
    return groups.project(group, chatTabId);
  }
  async function start(sourceTabId) {
    if (!Number.isSafeInteger(sourceTabId) || sourceTabId < 0) throw browserError("BROWSER_INVALID", "The popup must supply an exact source tab ID.");
    const source = await host.getTab(sourceTabId);
    if (!/^https?:\/\//.test(source.url || "")) throw browserError("BROWSER_INVALID", "Study this site requires an ordinary HTTP/HTTPS source tab.");
    const [options, templates] = await Promise.all([
      host.studyOptions ? host.studyOptions() : { detailedLogging: false },
      host.promptTemplates ? host.promptTemplates().then(normalizeStartupPrompts) : normalizeStartupPrompts()
    ]);
    await checkTabCapacity(null,2);
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
      group = await groups.get(groupId, options); group.connected = true; group.state = "starting"; group.startup = { chatTabId: chat.id, check: checkStarting };
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
      if (!chatPath) throw browserError("BROWSER_CHAT_NOT_FOUND", "The initial ChatGPT conversation must be confirmed.");
      checkStarting(); group.state = "running"; await groups.refresh(group); groups.acknowledge(group, chat.id);
      await notify("running"); group.startup = null;
      log("group started", { groupId, chatTabId: chat.id });
      return { ok: true, chatTabId: chat.id, group: groups.project(group, chat.id) };
    } catch (error) {
      stopped = true;
      const normalStop = ["TAB_CLOSED", "BROWSER_SESSION_STOPPED", "BROWSER_CANCELLED"].includes(error.code);
      if (group) { await stopGroup(group, chat.id); group.state = normalStop ? "stopped" : "failed"; group.error = normalStop ? null : { code: error.code || "BROWSER_UNAVAILABLE", message: error.code ? error.message : "Study startup failed." }; }
      const status = { state: normalStop ? "stopped" : "failed", phase, statusMessage: "Study startup stopped.", error: normalStop ? null : group?.error || { code: error.code || "BROWSER_UNAVAILABLE", message: error.message } };
      for (const id of [agent?.id, chat?.id].filter(Number.isInteger)) statuses.set(id, status);
      await host.updateStatus?.([agent?.id, chat?.id].filter(Number.isInteger), status);
      log("startup failed", { groupId: group?.groupId, phase, code: error.code || "BROWSER_UNAVAILABLE" });
      if (normalStop) return { ok: true, chatTabId: chat?.id ?? null, group: group ? groups.project(group, chat.id) : null };
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
      if (!task.caller.readOnly) await page.command("DOM.scrollIntoViewIfNeeded", { backendNodeId: item.entry.backendNodeId }, target);
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
    if (task.caller.readOnly && !clip) throw browserError("BROWSER_RESOURCE_UNAVAILABLE", "The image is not visible and its original resource is unavailable. Read-only access never scrolls the external tab.");
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
          target: { tabId: task.chatTabId, chatPath: task.caller.chatPath, ...(task.caller.cloudGuard?.target ? { cloudTarget: task.caller.cloudGuard.target } : {}) }, continuation,
          trace: session.trace, taskId: task.taskId,
          checkCancelled: () => checkTask(task, session),
          beforeSend: async () => {
            await waitRunning(task, session);
            if (items.some(item => item.pageVersion !== session.pageVersion)) throw browserError("PAGE_CHANGED", "The page navigated before Send. Saved files and Composer attachments were preserved.");
            for (const item of items) await verifyResource(item, session);
          },
          onPhase: async phase => { checkTask(task, session); progress(task, phase === "composerAccepted" ? "waitingToSend" : phase, phase === "composerAccepted" ? 80 : 70); },
          onSendCommit: () => { checkTask(task, session); if (session.group.state !== "running" || task.caller.group.state !== "running") throw browserError("BROWSER_SESSION_NOT_READY", "The session is not ready to send."); task.sendCommitted = true; }
        });
        task.submittedFiles = task.files.map(file => file.workspacePath); task.submittedAt = timestamp();
      }
      task.status = "completed"; progress(task, addToChat ? "submitted" : "saved", 100);
    } catch (error) {
      if (!task.cancelRequested) { task.status = "failed"; task.error = { code: error.code || "BROWSER_RESOURCE_UNAVAILABLE", message: error.code ? error.message : "Browser resource extraction or delivery failed. Saved files and any Composer attachments were preserved." }; progress(task, "failed", task.progressPercent); }
    } finally {
      task.finishPhase?.({ outcome: task.status }); task.finishPhase = null;
      if (!task.caller.local) await host.taskCompleted?.({ ...publicTask(task), tabId: task.chatTabId, suppressCompletionNotification: addToChat });
      session.trace.event("resource.total", { taskId: task.taskId, elapsedMs: session.trace.now() - task.startedMonotonic, bytes: task.sizeBytes, extraction: task.extraction, outcome: task.status, code: task.error?.code });
      pruneCompletedTasks(tasks, host.historyLimit?.() || 2000);
    }
  }
  async function execute(name, argumentsValue, cloudGuard = null) {
    await cloudGuard?.();
    const input = validateBrowserInput(name, argumentsValue);
    if (name === "site_open") return openSite(input,cloudGuard);
    const { group, member } = await groups.forChat(input.chatTabId, { claim: true });
    const result = await executeInGroup(name, input, group, member, cloudGuard);
    await groups.check(group, input.chatTabId, member.chatPath, { allowStopped: true });
    const fullSnapshot = ["site_list_tabs", "site_session_status"].includes(name) && result.group.revision === group.revision;
    const changes = groups.reportChanges(group, input.chatTabId, fullSnapshot);
    const response = { ...result, ...(changes.groupChanges ? { groupChanges: changes.groupChanges } : {}) };
    changes.commit();
    return response;
  }
  // One entry point from an existing saved chat. Grouping is infrastructure,
  // not a separate operation exposed to the model.
  async function openSite(input, cloudGuard) {
    const url = new URL(input.url).href;
    // Explicit navigation never creates a group or a fallback tab.
    if (input.tabId !== undefined) {
      const {group,member}=await groups.forChat(input.chatTabId,{claim:true});
      if (input.tabId===input.chatTabId || group.groupId<0) throw browserError("BROWSER_READ_ONLY","Choose a site tab in the current real group.");
      const verify=async(tab)=>{
        await cloudGuard?.();
        await groups.check(group,input.chatTabId,member.chatPath);
        if (group.state!=="running") throw browserError("BROWSER_SESSION_NOT_READY","Group is not running.");
        if (tab && tab.groupId!==group.groupId) throw browserError("BROWSER_READ_ONLY","External tabs cannot be navigated.");
      };
      const status=await navigateExisting(input,url,verify);
      await groups.refresh(group);
      const changes=groups.reportChanges(group,input.chatTabId);changes.commit();
      return {chatTabId:input.chatTabId,tabId:input.tabId,group:groups.project(group,input.chatTabId),status,url:safePageUrl(url),error:null,observation:null,...(changes.groupChanges?{groupChanges:changes.groupChanges}:{})};
    }
    const result = await groupCreationQueue.run("create",()=>queue(input.chatTabId, async () => {
      await cloudGuard?.();
      let {group,member} = await groups.forChat(input.chatTabId,{claim:true});
      const chatPath = member.chatPath;
      const verify = async () => {
        await cloudGuard?.();
        const tab = await groups.check(group,input.chatTabId,chatPath);
        if (group.state !== "running") throw browserError("BROWSER_SESSION_NOT_READY","The current group is not running. Resume explicitly if stopped.");
        return tab;
      };
      let chat = await verify();
      if (group.groupId < 0) {
        await checkTabCapacity(null,2);
        if (chat.pinned) throw browserError("BROWSER_INVALID","Unpin the initiating ChatGPT tab before opening a research group.");
        // Revalidate before changing membership; do not select a different chat.
        chat = await verify();
        const groupId = await host.groupTabs([input.chatTabId],browserStudyGroupTitle({url}));
        if (!Number.isSafeInteger(groupId) || groupId < 0) throw browserError("BROWSER_GROUP_NOT_FOUND","Chrome did not create the research group.");
        group = await groups.get(groupId);
        await groups.refresh(group,{claimTabId:input.chatTabId});
        chat = await verify();
      }
      const response = (status,tabId,error=null) => ({chatTabId:input.chatTabId,tabId,group:groups.project(group,input.chatTabId),status,url:safePageUrl(url),error,observation:null});
      if (input.reuseExisting !== false) {
        // Compare full URLs (including query/hash) privately, not sanitized
        // display URLs. Never reuse the caller or a tab in another group.
        for (const candidate of await host.queryTabs(group.groupId)) {
          if (candidate.id === input.chatTabId) continue;
          let match = false;
          try { match = new URL(candidate.pendingUrl || candidate.url).href === url; } catch {}
          if (!match) continue;
          await verify();
          try {
            const live = await host.getTab(candidate.id);
            if (live.groupId !== group.groupId || new URL(live.pendingUrl || live.url).href !== url) continue;
            await groups.refresh(group);
            await verify();
            groups.acknowledge(group,input.chatTabId);
            return response("reused",candidate.id);
          } catch(error) {
            if (error.code) throw error;
          }
        }
      }
      let created = null;
      try {
        chat = await verify();
        await checkTabCapacity(group.groupId);
        // Create a blank inactive tab and group it before navigating. No
        // external tab is moved, navigated, activated or closed.
        created = await host.createSiteTab(chat.windowId);
        await verify();
        const isBlank = tab => ["","about:blank"].includes(tab.url || "") && (!tab.pendingUrl || tab.pendingUrl === "about:blank");
        const blank = await host.getTab(created.id);
        if (blank.windowId !== chat.windowId || (blank.groupId >= 0 && blank.groupId !== group.groupId) || !isBlank(blank))
          throw browserError("BROWSER_TARGET_CHANGED","The new blank tab changed; it was left untouched.");
        if (blank.groupId !== group.groupId) { await checkTabCapacity(group.groupId); await host.addSiteTab(created.id,group.groupId); }
        await verify();
        const live = await host.getTab(created.id);
        if (live.groupId !== group.groupId || !isBlank(live))
          throw browserError("BROWSER_TARGET_CHANGED","The new tab moved or navigated; it was left untouched.");
        await host.navigateSiteTab(created.id,url);
        await groups.refresh(group);
        await verify();
        groups.acknowledge(group,input.chatTabId);
        return response("opening",created.id);
      } catch(error) {
        // Preserve any created tab and its exact ID so the client can inspect
        // partial results instead of retrying and creating duplicates.
        return response("failed",created?.id ?? null,{code:error.code || "BROWSER_UNAVAILABLE",message:error.code ? error.message : "Chrome could not complete the open. Inspect the tab ID before retrying."});
      }
    }));
    // Only pre-read already loaded pages. Do not hold the chat queue while
    // reading another tab, or block opening on a slow site's initial load.
    if (result.status !== "failed") {
      try {
        const tab = await host.getTab(result.tabId);
        if (tab.status === "complete" && !tab.pendingUrl && tab.groupId === result.group.groupId && /^https?:\/\//.test(tab.url || "")) {
          await cloudGuard?.();
          const {group,member} = await groups.forChat(input.chatTabId,{claim:true});
          if (group.groupId === result.group.groupId) {
            const observed = await executeInGroup("site_read",{chatTabId:input.chatTabId,tabId:result.tabId,mode:"outline"},group,member,cloudGuard);
            result.observation = observed;
            result.group = observed.group;
          }
        }
      } catch { /* Opening succeeded; site_read can be retried independently. */ }
    }
    return result;
  }
  async function executeInGroup(name, input, group, member, cloudGuard) {
    const caller = { group, chatTabId: input.chatTabId, chatPath: member.chatPath, tool: name,
      action: name === "site_interact" ? input.steps.length === 1 ? input.steps[0].action : "sequence" : undefined, cloudGuard };
    if (["site_list_tabs", "site_session_status"].includes(name)) {
      return { chatTabId: input.chatTabId, group: groups.project(group, input.chatTabId, input.offset, input.limit),
        ...(name === "site_list_tabs" && input.scope !== "group" ? { otherTabs: await groups.inventory(group, input.otherOffset ?? 0, input.limit ?? 50) } : {}) };
    }
    if (["site_files_status", "site_files_cancel"].includes(name)) {
      const task = tasks.get(input.taskId);
      if (!task || task.caller.local || task.caller.group !== group) throw browserError("BROWSER_TASK_NOT_FOUND", "This task is not in your current group, or its history expired.");
      return name === "site_files_status" ? publicTask(task) : { cancelled: cancelTask(task), task: publicTask(task) };
    }
    if (name === "site_session_stop") return { chatTabId: input.chatTabId, group: await stopGroup(group, input.chatTabId) };
    await groups.check(group, input.chatTabId, caller.chatPath);
    const selected = await host.getTab(input.tabId).catch(() => { throw browserError("TAB_CLOSED", "The selected tab closed."); });
    const external = tabScopeKey(selected) !== group.groupId;
    if (name === "site_interact" && (external || group.groupId < 0))
      throw browserError("BROWSER_READ_ONLY", "Tabs outside the initiating chat's actual Chrome group are read-only.");
    const readTools = ["site_read","site_get_children","site_get_node","site_get_text","site_get_images","site_get_files"];
    if (external && (input.scope !== "all" || !readTools.includes(name)))
      throw browserError("TAB_LEFT_GROUP", "The selected tab is outside the current group. For read-only access use scope=all.");
    const targetGroup = external ? await groups.targetGroup(selected) : group;
    caller.targetGroup = targetGroup;
    caller.readOnly = external || group.groupId < 0;
    const result = await executeTarget(name, input, caller, targetGroup);
    if (Object.hasOwn(result, "taskId")) return result;
    await groups.check(group, input.chatTabId, caller.chatPath);
    await groups.refresh(group);
    return { ...result, chatTabId: input.chatTabId, tabId: input.tabId, group: groups.project(group, input.chatTabId),
      ...(result.observation ? { observation: { ...result.observation, chatTabId: input.chatTabId, group: groups.project(group, input.chatTabId) } } : {}) };
  }
  // The local client has no ChatGPT identity and no mutation or Composer path.
  function localProjection(result) {
    const { chatTabId, group, groupId, groupChanges, submittedFiles, submittedAt, ...value } = result;
    return value;
  }
  async function openLocalSite(input) {
    const url = new URL(input.url).href;
    if (input.tabId !== undefined) {
      const own=await codexGroup();
      if (!own) throw browserError("BROWSER_READ_ONLY","No Codex group exists.");
      const status=await navigateExisting(input,url,async(tab)=>{if(tab) await assertCodexControl(tab);});
      return {tabId:input.tabId,groupId:own.id,status,url:safePageUrl(url),error:null,observation:null};
    }
    const result = await groupCreationQueue.run("create",()=>codexQueue.run("open",async () => {
      let own = await codexGroup(), created = null;
      const result = (status,tabId,error=null) => ({tabId,groupId:own?.id ?? null,status,url:safePageUrl(url),error,observation:null});
      try {
        if (own && input.reuseExisting !== false) {
          for (const candidate of own.tabs) {
            let match = false;
            try { match = new URL(candidate.pendingUrl || candidate.url).href === url; } catch {}
            if (!match) continue;
            const live = await host.getTab(candidate.id).catch(()=>null);
            if (live && live.groupId === own.id && (live.pendingUrl || live.url) && new URL(live.pendingUrl || live.url).href === url) {
              await assertCodexControl(live);
              return result("reused",live.id);
            }
          }
        }
        await checkTabCapacity(own?.id ?? null);
        const windowId = own?.tabs[0]?.windowId ?? await host.codexWindow?.();
        created = await host.createSiteTab(windowId);
        const blank = tab => ["","about:blank"].includes(tab.url || "") && (!tab.pendingUrl || tab.pendingUrl === "about:blank");
        const live = await host.getTab(created.id);
        if (!blank(live) || (windowId != null && live.windowId !== windowId) || (live.groupId >= 0 && live.groupId !== own?.id))
          throw browserError("BROWSER_TARGET_CHANGED","The new blank tab changed; it was left untouched.");
        if (own) {
          const current = await codexGroup();
          if (current?.id !== own.id) throw browserError("BROWSER_TARGET_CHANGED","The Codex group disappeared. Inspect the created tab before retrying.");
          if (live.groupId !== own.id) { await checkTabCapacity(own.id); await host.addSiteTab(created.id,own.id); }
        } else {
          const id = await host.groupTabs([created.id],"RT · Codex");
          if (!Number.isSafeInteger(id) || id < 0) throw browserError("BROWSER_GROUP_NOT_FOUND","Chrome did not create the Codex group.");
          own = {id,tabs:[live]};
          await rememberCodexGroup(id);
        }
        const grouped = await host.getTab(created.id);
        await assertCodexControl(grouped);
        if (!blank(grouped)) throw browserError("BROWSER_TARGET_CHANGED","The new tab navigated before opening; it was left untouched.");
        await host.navigateSiteTab(created.id,url);
        return result("opening",created.id);
      } catch(error) {
        return result("failed",created?.id ?? null,{code:error.code || "BROWSER_UNAVAILABLE",message:error.code ? error.message : "Chrome could not complete the open. Inspect the tab ID before retrying."});
      }
    }));
    if (result.status !== "failed") {
      try {
        const tab = await host.getTab(result.tabId);
        if (tab.status === "complete" && !tab.pendingUrl && tab.groupId === result.groupId && /^https?:\/\//.test(tab.url || ""))
          result.observation = await executeLocal("site_read",{tabId:tab.id,mode:"outline"});
      } catch { /* The tab is open; read independently after loading. */ }
    }
    return result;
  }
  async function executeLocal(name, input) {
    if (Object.hasOwn(input,"chatTabId") || Object.hasOwn(input,"scope") || Object.hasOwn(input,"addToChat"))
      throw browserError("BROWSER_INVALID", "Local browser reads do not accept a chat identity or chat delivery.");
    if (name === "site_open" || name === "site_interact") validateBrowserInput(name,{...input,chatTabId:0});
    if (name === "site_open") return openLocalSite(input);
    if (name === "site_list_tabs") {
      const own = await codexGroup();
      const tabs = (await host.queryAllTabs()).filter(tab => Number.isSafeInteger(tab.id)).sort((a,b) => (a.windowId ?? -1)-(b.windowId ?? -1) || (a.index ?? a.id)-(b.index ?? b.id) || a.id-b.id).map(tab => {
        const readable = /^https?:\/\//.test(tab.url || "");
        return {tabId:tab.id,windowId:tab.windowId ?? -1,groupId:tab.groupId >= 0 ? tab.groupId : null,role:/^https:\/\/chatgpt\.com(?:\/|$)/.test(tab.url || "") ? "chatgpt":"site",title:readable?String(tab.title || "").slice(0,500):"Restricted browser tab",url:readable?safePageUrl(tab.url):"",access:readable?(own && tab.groupId===own.id?"read-write":"read-only"):"restricted"};
      });
      const offset=input.offset ?? 0, limit=input.limit ?? 200;
      let hash=2166136261; for(const c of JSON.stringify(tabs)) hash=Math.imul(hash ^ c.charCodeAt(0),16777619);
      return {revision:hash>>>0,totalTabs:tabs.length,nextOffset:offset+limit<tabs.length?offset+limit:null,tabs:tabs.slice(offset,offset+limit)};
    }
    if (name === "site_files_status" || name === "site_files_cancel") {
      const task = tasks.get(input.taskId);
      if (!task?.caller.local) throw browserError("BROWSER_TASK_NOT_FOUND", "This local resource task expired or does not belong to the local MCP.");
      if (name === "site_files_cancel") return { cancelled: cancelTask(task), task: localProjection(publicTask(task)) };
      return localProjection(publicTask(task));
    }
    if (!["site_read","site_get_children","site_get_node","site_get_text","site_get_images","site_get_files","site_interact"].includes(name))
      throw browserError("BROWSER_READ_ONLY", "Local MCP exposes only its documented Site tools.");
    if (["site_get_images","site_get_files"].includes(name) &&
        (Object.hasOwn(input,"resourceId") === Object.hasOwn(input,"resourceIds") || (input.resourceIds && new Set(input.resourceIds).size !== input.resourceIds.length)))
      throw browserError("BROWSER_INVALID", "Provide exactly one resourceId or a distinct resourceIds batch.");
    if (name === "site_read" && input.mode === "subtree" && !input.nodeId)
      throw browserError("BROWSER_INVALID", "subtree mode requires nodeId.");
    const live = await readTab(input.tabId);
    if (name === "site_interact") await assertCodexControl(live);
    const caller = { group:null, targetGroup:null, chatTabId:null, chatPath:null, local:true, readOnly:name !== "site_interact", tool:name };
    const result = await executeTarget(name, input, caller, null);
    return localProjection({...result,tabId:input.tabId});
  }
  async function executeTarget(name, input, caller, targetGroup) {
    return queue(input.tabId, async () => {
      if (!caller.local) await groups.check(caller.group, input.chatTabId, caller.chatPath);
      const live = caller.local ? await readTab(input.tabId) : await groups.check(targetGroup, input.tabId);
      if (caller.local && !caller.readOnly) await assertCodexControl(live);
      const previous = (caller.local ? localTargets : targets).get(input.tabId);
      if (caller.local && previous?.error) await dropLocalTarget(input.tabId);
      if (!caller.local && previous && previous.group !== targetGroup) await dropTarget(previous.group, input.tabId, "TAB_LEFT_GROUP");
      const target = caller.local ? targetFor(null,live,await (host.studyOptions?.() || {detailedLogging:false})) : targetFor(targetGroup,live);
      target.operation = caller;
      try {
        if (!caller.local) await groups.check(caller.group, input.chatTabId, caller.chatPath);
        await ensureTarget(target);
        if (caller.local && !caller.readOnly) {
          await check(target,true);
          await command(target.agentTabId,"Emulation.setFocusEmulationEnabled",{enabled:true});
          target.localFocus = true;
        }
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
            host.schedule(() => runResource(task, target, items, !caller.local && input.addToChat !== false, name));
            return initial;
          }
          throw browserError("BROWSER_INVALID", "Unknown site tool.");
        });
      } finally {
        if (target.localFocus) {
          target.localFocus = false;
          if (!targets.get(target.agentTabId)?.controlReady)
            await host.command(target.agentTabId,"Emulation.setFocusEmulationEnabled",{enabled:false}).catch(()=>{});
        }
        target.operation = null;
      }
    });
  }
  function discardChildSessions(session, childId) {
    const removed = new Set([childId]);
    for (;;) { const size = removed.size; for (const child of session.childSessions.values()) if (removed.has(child.parentSessionId)) removed.add(child.sessionId); if (size === removed.size) break; }
    for (const id of removed) { session.page.invalidateFrame(null, id); session.childSessions.delete(id); }
  }
  async function onEvent(source, method, params = {}) {
    await Promise.all([targets.get(source.tabId),localTargets.get(source.tabId)].filter(Boolean).map(session => onTargetEvent(session,source,method,params)));
  }
  async function onTargetEvent(session, source, method, params) {
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
          if (session.childSessions.get(params.sessionId) !== child || !session.attached || targetMap(session).get(session.agentTabId) !== session)
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
    await dropLocalTarget(tabId);
    for (const group of groups.values()) if (group.members.has(tabId) || group.startup?.chatTabId === tabId) {
      cancelForTab(group, tabId);
      if (group.state === "starting" && tabId === group.startup?.chatTabId) await stopGroup(group, tabId);
      await dropTarget(group, tabId, "TAB_CLOSED");
    }
    statuses.delete(tabId);
    await groups.changed();
  }
  async function onDetached(source, reason) {
    const local = localTargets.get(source.tabId);
    if (local) { local.attached=false; await dropLocalTarget(source.tabId); }
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
    groups.acknowledge(group, chatTabId);
    return { chatTabId, group: groups.project(group, chatTabId) };
  }
  async function recoverGroups() {
    const tabs = await host.queryChatTabs?.() || [];
    const seen = new Set();
    await Promise.allSettled(tabs.filter(tab => Number.isSafeInteger(tab.groupId) && tab.groupId >= 0 && host.conversationPath(tab.url) && !seen.has(tab.groupId) && seen.add(tab.groupId)).map(async tab => { const group = await groups.get(tab.groupId); await groups.refresh(group); }));
  }
  return { start, execute, executeLocal, connectGroup, recoverGroups, hasPendingChat:id=>[...tasks.values()].some(t=>!TERMINAL.has(t.status)&&t.chatTabId===id), onEvent, onRemoved, onDetached, onUpdated, onCreated: groups.changed, onReplaced: groups.changed,
    localStatus, hasControlTarget: id => Boolean(targets.get(id)?.attached && targets.get(id)?.controlReady), ownsTab: id => [...groups.values()].some(group => !["stopped", "failed"].includes(group.state) && group.members.has(id)) };
}
