import { resolveChatComposer } from "./chat-composer.js";

// Optional chat context lives on task records; no task-ID/tab-ID routing table.
export const taskTabSchema = { type: "integer", minimum: 0, description: "Optional ChatGPT tabId from the startup prompt. On completion notify this tab only if idle; omit for no wake-up." };
export function normalizeTaskTabId(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error("tabId must be a nonnegative integer."), { code: "INVALID_ARGUMENT" });
  return value;
}
export function createTaskCompletionDelivery(host) {
  // Used for Agent-owned timers and Custom Tools only. Other managers already
  // own their task records and invoke completed directly.
  let records = [], loaded = false, loading = null, ticking = false, writing = Promise.resolve();
  const terminal = task => ["completed", "failed", "cancelled"].includes(task.status);
  const save = () => {
    const done = records.filter(terminal);
    const remove = new Set(done.slice(0, Math.max(0, done.length - host.historyLimit())).map(task => task.taskId));
    records = records.filter(task => !remove.has(task.taskId));
    const snapshot = JSON.parse(JSON.stringify(records));
    writing = writing.catch(() => {}).then(() => host.save(snapshot));
    return writing;
  };
  async function ensure() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      records = await host.load();
      if (!Array.isArray(records)) records = [];
      records = records.filter(task => typeof task.taskId === "string" && ["timer", "custom"].includes(task.kind));
      loaded = true;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function completed(task, persist = async () => {}) {
    if (task.status !== "completed" || task.chatCompletionHandled || task.tabId == null || task.suppressCompletionNotification) return;
    // Mark before awaited I/O, including immediate completion at task launch.
    // Busy/missing tabs consume the notification: there is no pending wake-up.
    task.chatCompletionHandled = true;
    await persist();
    try { await host.send(task.tabId, { completionText: "ResearchTube task " + task.taskId + " completed." }); }
    catch (error) { host.log?.("Task completion notification stopped", { taskId: task.taskId, code: error.code || "CHAT_UNAVAILABLE" }); }
  }
  async function register(task, kind, tabId) {
    await ensure();
    if (tabId == null) return task;
    let record = records.find(item => item.taskId === task.taskId);
    if (!record) { record = { ...task, kind, tabId }; records.push(record); }
    else Object.assign(record, task);
    await save();
    await completed(record, save);
    if (!terminal(record)) host.schedule(Math.max(250, record.pollIntervalMs || 1000));
    return { ...task, tabId: record.tabId };
  }
  async function observe(task) {
    await ensure();
    const record = records.find(item => item.taskId === task.taskId);
    if (!record) return task;
    Object.assign(record, task);
    await save();
    await completed(record, save);
    return { ...task, tabId: record.tabId };
  }
  async function tick() {
    await ensure();
    if (ticking) return;
    ticking = true;
    try {
      for (const record of records) {
        if (terminal(record) || host.now() < (record.nextPollAt || 0)) continue;
        record.nextPollAt = host.now() + Math.max(250, record.pollIntervalMs || 1000);
        try {
          const task = await host.status(record.kind, record.taskId);
          if (task.taskId !== record.taskId) throw new Error("Another task returned");
          if (terminal(record)) continue; // Cancellation observed during this poll wins.
          Object.assign(record, task);
          await save(); await completed(record, save);
        } catch (error) { host.log?.("Background task poll unavailable", { taskId: record.taskId, code: error.code || "AGENT_UNAVAILABLE" }); }
      }
      const done = records.filter(terminal);
      const remove = new Set(done.slice(0, Math.max(0, done.length - host.historyLimit())).map(task => task.taskId));
      records = records.filter(task => !remove.has(task.taskId)); await save();
      if (records.some(task => !terminal(task))) host.schedule(1000);
    } finally { ticking = false; }
  }
  return { ensure, completed, register, observe, tick };
}

// Installed only in a ChatGPT tab explicitly used by ResearchTube. Readiness
// uses the shared Composer resolver/inspection; messages never log draft text.
export function installComposerWatchdog(seconds, inspect) {
  const previous = window.__researchtubeComposerWatchdog;
  if (previous) { previous.seconds = seconds; return previous.read(); }
  let key = null, changedAt = performance.now(), revision = 0, suppressed = false, requesting = false, holds = 0;
  const state = { seconds };
  function read() {
    const { composer, root } = resolveChatComposer();
    const inspected = inspect();
    const text = composer ? String(composer.value ?? composer.innerText ?? composer.textContent ?? "") : "";
    const attachments = Math.max(inspected.attachments?.length || 0, inspected.previewCount || 0);
    const next = JSON.stringify([Boolean(composer), text, attachments]);
    if (next !== key) { key = next; revision++; changedAt = performance.now(); }
    if (!text.trim() && !attachments) suppressed = false;
    const send = root?.querySelector('button[type="submit"]');
    const generating = Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]'));
    return { found: Boolean(composer && root), text, attachments, revision, stableMs: performance.now() - changedAt,
      idle: !generating, sendEnabled: Boolean(send && !send.disabled && send.getAttribute("aria-disabled") !== "true"),
      blocked: holds > 0 || suppressed };
  }
  state.read = read;
  state.hold = () => { holds++; };
  state.release = preserve => { holds = Math.max(0, holds - 1); if (preserve) suppressed = true; };
  state.suppress = () => { suppressed = true; };
  const sample = () => {
    const value = read();
    if (requesting || value.blocked || !value.found || !value.idle || !value.sendEnabled || !value.text.trim() && !value.attachments || value.stableMs < state.seconds * 1000) return;
    requesting = true;
    chrome.runtime.sendMessage({ type: "researchtube_composer_watchdog", revision: value.revision }).then(reply => {
      // Ignore a response to a draft that has changed while the worker ran.
      if (reply?.sent && read().revision === value.revision) state.suppress();
    }).catch(() => {}).finally(() => { requesting = false; });
  };
  const timer = setInterval(sample, 1000);
  const input = event => {
    const { composer } = resolveChatComposer();
    if (event.isTrusted && composer && (event.target === composer || composer.contains(event.target))) suppressed = false;
    read();
  };
  document.addEventListener("input", input, true);
  document.addEventListener("change", input, true);
  state.dispose = () => { clearInterval(timer); document.removeEventListener("input", input, true); document.removeEventListener("change", input, true); delete window.__researchtubeComposerWatchdog; };
  window.__researchtubeComposerWatchdog = state;
  return read();
}
