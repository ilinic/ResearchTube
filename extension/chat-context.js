import { browserError } from "./browser-tools.js";
import { pruneCompletedTasks } from "./task-history.js";

// A private widget capability binds a request to Chrome's sender, never focus.
// Context tasks and group membership remain in memory, not Chrome Storage.
export function createChatContext(host) {
  const tasks = new Map();
  const now = host.now || Date.now;
  const document = task => structuredClone(Object.fromEntries(["taskId", "status", "phase", "progressPercent", "pollIntervalMs", "chatTabId", "group", "error"].map(key => [key, task[key]])));
  function fail(task, code, message) {
    if (task.status === "cancelled") return;
    task.status = "failed"; task.phase = "failed"; task.group = null; task.error = { code, message };
    try { host.error?.({ taskId: task.taskId, chatTabId: task.chatTabId, code, message }); } catch { /* Diagnostics cannot affect binding. */ }
  }
  function expire(task) {
    if (task.status === "working" && now() >= task.deadline) fail(task, "BROWSER_CONTEXT_TIMEOUT", "The chat widget did not identify its tab within two minutes. Retry after the widget loads.");
  }
  async function verify(target) {
    const tab = await host.getTab(target.tabId).catch(() => { throw browserError("TAB_CLOSED", "The bound ChatGPT tab closed."); });
    if (host.conversationPath(tab.url) !== target.chatPath) throw browserError("BROWSER_CHAT_CHANGED", "The bound conversation changed. Connect this chat again.");
    if (target.groupId != null && tab.groupId !== target.groupId) throw browserError("TAB_LEFT_GROUP", "The chat moved to another group. Connect it again.");
    const matches = (await host.queryTabs()).filter(item => host.conversationPath(item.url)?.split("/c/").pop() === target.chatPath.split("/c/").pop());
    if (matches.length !== 1 || matches[0].id !== target.tabId) throw browserError("BROWSER_CONTEXT_AMBIGUOUS", "This conversation is open in multiple tabs. Close its duplicate and retry.");
  }
  async function call(input) {
    if (!input.taskId) {
      for (const task of tasks.values()) expire(task);
      pruneCompletedTasks(tasks, 2000);
      if ([...tasks.values()].filter(task => task.status === "working").length >= 100) throw browserError("BROWSER_CONTEXT_BUSY", "Too many chat bindings are pending. Wait for their deadlines.");
      let taskId; do { taskId = host.id(); } while (tasks.has(taskId));
      const task = { taskId, status: "working", phase: "binding", progressPercent: 0, pollIntervalMs: 1000, chatTabId: null, group: null, error: null,
        createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), deadline: now() + 120000, token: host.token(), target: null, resumeGroup: input.resumeGroup === true };
      tasks.set(taskId, task);
      host.scheduleExpiry?.(() => expire(task), 120000);
      return document(task);
    }
    const task = tasks.get(input.taskId);
    if (!task) throw browserError("BROWSER_CONTEXT_NOT_FOUND", "This chat binding expired or the Extension restarted. Connect again without taskId.");
    expire(task);
    if (input.cancel && task.status === "working") { task.status = "cancelled"; task.phase = "cancelled"; }
    if (task.status === "completed") {
      try {
        await verify(task.target);
        const context = task.target.groupId == null ? { group: null } : await host.inspect(task.chatTabId);
        await verify(task.target);
        // Reading a binding never resumes a stopped group.
        task.group = context.group;
      } catch (error) { fail(task, error.code || "BROWSER_UNAVAILABLE", error.code ? error.message : "The bound group could not be inspected."); }
    }
    return document(task);
  }
  function metadata(taskId) {
    const task = tasks.get(taskId);
    if (task) expire(task);
    return task?.status === "working" ? { taskId, bindingToken: task.token, mode: "group" } : null;
  }
  async function bind(message, sender) {
    const task = tasks.get(message.taskId);
    if (!task || message.bindingToken !== task.token || sender?.id !== host.extensionId || !Number.isSafeInteger(sender.tab?.id)) throw browserError("BROWSER_CONTEXT_INVALID", "Invalid or expired chat binding.");
    expire(task);
    const chatPath = host.conversationPath(sender.tab.url);
    if (!chatPath || /\/c\/local-chatgpt(?:%3A|:)/i.test(chatPath)) {
      const error = browserError("BROWSER_SESSION_NOT_READY", "Wait for ChatGPT to save this conversation, then connect again.");
      if (task.status === "working") fail(task, error.code, error.message);
      throw error;
    }
    if (task.target && (task.target.tabId !== sender.tab.id || task.target.chatPath !== chatPath)) throw browserError("BROWSER_CHAT_CHANGED", "This binding belongs to another tab or conversation.");
    if (task.status === "completed") { await verify(task.target); return { ok: true, context: document(task) }; }
    if (task.status !== "working") throw browserError(task.error?.code || "BROWSER_CANCELLED", task.error?.message || "Chat binding is no longer pending.");
    if (!task.binding) task.binding = (async () => {
      task.target = { tabId: sender.tab.id, chatPath };
      try {
        await verify(task.target);
        const checkPending = () => {
          expire(task);
          if (task.status !== "working") throw browserError("BROWSER_CANCELLED", "Chat binding ended during connection.");
        };
        checkPending();
        const liveTab = await host.getTab(sender.tab.id);
        const grouped = Number.isSafeInteger(liveTab.groupId) && liveTab.groupId >= 0;
        if (task.resumeGroup && !grouped) throw browserError("BROWSER_GROUP_NOT_FOUND", "Place this chat in a tab group before resuming.");
        const context = grouped ? (task.resumeGroup ? await host.connect(sender.tab.id, checkPending) : await host.inspect(sender.tab.id)) : { chatTabId: sender.tab.id, group: null };
        checkPending();
        task.target.groupId = context.group?.groupId ?? null;
        await verify(task.target);
        expire(task);
        if (task.status !== "working") throw browserError("BROWSER_CANCELLED", "Chat binding ended during verification.");
        task.chatTabId = context.chatTabId; task.group = context.group;
        task.status = "completed"; task.phase = "connected"; task.progressPercent = 100;
        return { ok: true, context: document(task) };
      } catch (error) {
        if (task.status === "working") fail(task, error.code || "BROWSER_UNAVAILABLE", error.code ? error.message : "Unable to connect this tab group.");
        throw error;
      }
    })();
    return task.binding;
  }
  async function direct(chatTabId) {
    if (!Number.isSafeInteger(chatTabId) || chatTabId < 0) throw browserError("INVALID_ARGUMENT", "Use the current-chat widget to identify the live ChatGPT tab.");
    const tab = await host.getTab(chatTabId);
    const target = { tabId: chatTabId, chatPath: host.conversationPath(tab.url) };
    if (!target.chatPath) throw browserError("BROWSER_CONTEXT_REQUIRED", "The specified tab is not a saved ChatGPT conversation.");
    await verify(target);
    const context = await host.connect(chatTabId, () => {});
    await verify(target);
    return { taskId: host.id(), status: "completed", phase: "connected", progressPercent: 100, pollIntervalMs: 1000, chatTabId,
      group: context.group, error: null };
  }
  return { call, bind, metadata, direct };
}
