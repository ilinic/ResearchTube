// Only normalized technical fields cross MCP. Never export existing raw logs.
export function diagnosticMessage(value) {
  return String(value || "ResearchTube operation failed.")
    .replace(/\b(?:https?|chrome-extension|file):\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, "[redacted]")
    .replace(/\b(?:api[_ -]?key|bindingToken|token|cookie|authorization|tunnelId)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[redacted]")
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"']+\1/g, "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\s"'<>]+|(?:^|\s)\/(?:[^\s"'<>]+\/)+[^\s"'<>]*/g, " [path]")
    .replace(/\s+/g, " ").trim().slice(0, 400);
}
const name = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function normalizeDiagnostic(value) {
  if (!value || typeof value !== "object") return null;
  const date = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
  return {
    timestamp: Number.isFinite(date) ? new Date(date).toISOString() : new Date().toISOString(),
    level: value.level === "warning" ? "warning" : "error",
    source: ["tool", "browser", "extension"].includes(value.source) ? value.source : "extension",
    tool: name(value.tool, /^[a-z][a-z0-9_]{0,99}$/),
    stage: name(value.stage, /^[a-zA-Z0-9_.:-]{1,100}$/) || "failed",
    code: name(value.code, /^[A-Z0-9_]{1,80}$/) || "TOOL_ERROR",
    message: diagnosticMessage(value.message),
    tabId: integer(value.tabId), chatTabId: integer(value.chatTabId), groupId: integer(value.groupId),
    taskId: name(value.taskId, /^tsk_[A-Za-z0-9_-]{10}$/),
    elapsedMs: typeof value.elapsedMs === "number" && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? Math.round(value.elapsedMs * 10) / 10 : null,
    method: name(value.method, /^[A-Za-z]+\.[A-Za-z0-9]+$/)
  };
}
export function createSystemDiagnostics({ read, write, version, capacity = 500 }) {
  let tail = Promise.resolve(), entries = null;
  const serial = work => {
    const result = tail.catch(() => {}).then(async () => {
      if (!entries) {
        const stored = await read();
        entries = (Array.isArray(stored) ? stored : []).map(normalizeDiagnostic).filter(Boolean).slice(-capacity);
      }
      return work();
    });
    tail = result.catch(() => {}); return result;
  };
  return {
    append: value => serial(async () => {
      const item = normalizeDiagnostic(value);
      if (!item) return;
      entries.push(item); entries = entries.slice(-capacity);
      await write(entries);
    }),
    get: ({ limit = 20, tool, tabId, taskId } = {}) => serial(() => {
      const matches = entries.filter(item => (!tool || item.tool === tool) && (tabId == null || item.tabId === tabId || item.chatTabId === tabId) && (!taskId || item.taskId === taskId)).reverse();
      return { extensionVersion: version, retained: entries.length, returned: Math.min(limit, matches.length), truncated: matches.length > limit, events: matches.slice(0, limit).map(item => ({ ...item })) };
    }),
    clear: () => serial(async () => { entries = []; await write(entries); })
  };
}
