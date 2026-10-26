// Explicit, bounded Browser Agent timing captures for pasteable MCP reports.
// Only timing metadata is retained; tool arguments and page contents are excluded.
const STORAGE_KEY = "browserTimingSessions";
const SAFE_TIMING_FIELDS = new Set([
  "stage", "event", "spanId", "method", "outcome", "code", "elapsedMs",
  "sinceLaunchMs", "gapMs", "count", "frameCount", "rawNodes", "indexedNodes",
  "returnedNodes", "totalNodes", "characters", "bytes", "extraction", "mode",
  "enabled", "addedNodes", "updatedNodes", "removedNodes", "addedResources",
  "removedResources", "point", "tabId", "tabStatus", "active", "visibilityState",
  "hidden", "hasFocus", "readyState", "tabState", "cdpState", "taskId", "stepIndex", "action", "requestId"
]);
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const rounded = value => Math.round(Math.max(0, value) * 10) / 10;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const label = event => `${event.tool}${event.action ? `:${event.action}` : ""}`;

export function createBrowserTimingSessions({
  storage = null, now = () => Date.now(), maxSessions = 4
} = {}) {
  const sessions = new Map();
  let loaded = false;
  let loading = null;
  let writeTail = Promise.resolve();

  async function load() {
    if (loaded) return;
    if (!loading) loading = (async () => {
      const saved = await storage?.get?.(STORAGE_KEY);
      for (const entry of saved?.[STORAGE_KEY] || []) {
        if (!safeInteger(entry.chatTabId) || !safeInteger(entry.groupId) || !Array.isArray(entry.events)) continue;
        const events = entry.events.filter(event => event && ["tool", "gap", "timing"].includes(event.kind)).slice(-800);
        sessions.set(entry.chatTabId, { ...entry, events, pending: new Map() });
      }
      loaded = true;
    })().finally(() => { loading = null; });
    await loading;
  }

  function flush() {
    if (!storage) return Promise.resolve();
    const snapshot = [...sessions.values()].map(({ pending, ...entry }) => entry);
    writeTail = writeTail.catch(() => {}).then(() => storage.set({ [STORAGE_KEY]: snapshot })).catch(() => {});
    return writeTail;
  }

  function append(session, event) {
    session.events.push(event);
    if (session.events.length > session.maxEvents) {
      session.droppedEvents += session.events.length - session.maxEvents;
      session.events.splice(0, session.events.length - session.maxEvents);
    }
  }

  async function start({ chatTabId, groupId, maxEvents = 600 }) {
    await load();
    if (!safeInteger(chatTabId) || !safeInteger(groupId) || !Number.isSafeInteger(maxEvents) || maxEvents < 100 || maxEvents > 800) throw Error("Invalid timing capture arguments.");
    // One recorder per leading chat; a fresh start deliberately resets its old data.
    sessions.delete(chatTabId);
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    const startedAtMs = now();
    sessions.set(chatTabId, { chatTabId, groupId, startedAtMs, startedAt: new Date(startedAtMs).toISOString(),
      maxEvents, droppedEvents: 0, events: [], lastTool: null, recording: true, pending: new Map() });
    await flush();
    return { chatTabId, groupId, startedAt: new Date(startedAtMs).toISOString(), recording: true, maxEvents };
  }

  async function beginTool({ chatTabId, tabId, tool, action }) {
    await load();
    const session = sessions.get(chatTabId);
    if (!session?.recording || !/^site_(?!diagnostics_)[a-z_]+$/.test(tool)) return null;
    const atMs = now();
    if (session.lastTool && atMs >= session.lastTool.endMs) {
      append(session, { kind: "gap", atMs, elapsedMs: rounded(atMs - session.lastTool.endMs),
        after: session.lastTool.label, before: label({ tool, action }) });
    }
    const call = { kind: "tool", atMs, tool, ...(safeInteger(tabId) ? { tabId } : {}),
      ...(typeof action === "string" && /^[a-z]+$/.test(action) ? { action } : {}),
      outcome: "working", elapsedMs: null };
    append(session, call);
    session.pending.set(call, atMs);
    return { session, call };
  }

  async function endTool(handle, { outcome = "ok", code = null } = {}) {
    if (!handle) return;
    const { session, call } = handle;
    const started = session.pending.get(call);
    if (started === undefined) return;
    session.pending.delete(call);
    const endMs = now();
    call.elapsedMs = rounded(endMs - started);
    call.outcome = outcome === "failed" ? "failed" : "ok";
    if (call.outcome === "failed") call.code = safeCode(code) || "UNEXPECTED";
    session.lastTool = { label: label(call), endMs };
    await flush();
  }

  function timing(record) {
    if (!record || !safeInteger(record.groupId) && !safeInteger(record.chatTabId)) return;
    if (!loaded) {
      // A Cloudflare socket can deliver UTC stamps before the first Site tool
      // rehydrates the recorder after service-worker suspension.
      void load().then(() => timing(record)).catch(() => {});
      return;
    }
    const atMs = Number.isSafeInteger(record.atMs) && Math.abs(record.atMs - now()) <= 300000 ? record.atMs : now();
    let appended = false;
    for (const session of sessions.values()) {
      if (!session.recording || (safeInteger(record.chatTabId) ? session.chatTabId !== record.chatTabId : session.groupId !== record.groupId) || atMs < session.startedAtMs) continue;
      const event = { kind: "timing", atMs };
      for (const [key, value] of Object.entries(record)) {
        if (!SAFE_TIMING_FIELDS.has(key)) continue;
        if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 100 && !/[\/?\\=]/.test(value)) event[key] = value;
      }
      append(session, event);
      appended = true;
    }
    // The DO's last stamp arrives after the Site call's endTool flush; save
    // this final event without delaying the browser response or every stamp.
    if (appended && record.stage === "room.responded") void flush();
  }

  async function report({ chatTabId, stop = true, limit = 120 }) {
    await load();
    const session = sessions.get(chatTabId);
    if (!session) throw Object.assign(Error("No browser timing capture for this chat. Start one first."), { code: "BROWSER_DIAGNOSTICS_NOT_FOUND" });
    const endedAtMs = now();
    if (stop) session.recording = false;
    const completed = session.events.filter(event => event.kind === "tool" && event.elapsedMs !== null);
    const gaps = session.events.filter(event => event.kind === "gap");
    const timings = session.events.filter(event => event.kind === "timing" && event.event === "end" && typeof event.elapsedMs === "number");
    const lines = [
      "# ResearchTube browser timing report",
      `Started: ${session.startedAt}; Reported: ${new Date(endedAtMs).toISOString()}`,
      `Group: ${session.groupId}; Leading chat: ${session.chatTabId}; Recording: ${session.recording ? "active" : "stopped"}`,
      `Completed calls: ${completed.length}; Inter-call gaps: ${gaps.length}; Dropped events: ${session.droppedEvents}`,
      "",
      "## Slowest calls and gaps"
    ];
    const slow = [
      ...completed.map(event => ({ ms: event.elapsedMs, what: `Tool ${label(event)}`, code: event.code })),
      ...gaps.map(event => ({ ms: event.elapsedMs, what: `Between ${event.after} → ${event.before}` }))
    ].sort((a, b) => b.ms - a.ms).slice(0, 12);
    lines.push(...(slow.length ? slow.map(event => `- ${event.ms} ms — ${event.what}${event.code ? ` (${event.code})` : ""}`) : ["- No completed calls yet."]));
    lines.push("", "## Tool timeline (oldest to newest)");
    const timeline = session.events.filter(event => event.kind !== "timing").slice(-limit);
    for (const event of timeline) {
      const time = new Date(event.atMs).toISOString().slice(11, 23);
      if (event.kind === "gap") lines.push(`- ${time} · GAP ${event.elapsedMs} ms · ${event.after} → ${event.before}`);
      else lines.push(`- ${time} · ${label(event)} · ${event.elapsedMs ?? "pending"} ms · ${event.outcome}${event.code ? ` (${event.code})` : ""}`);
    }
    lines.push("", "## Slowest internal browser stages");
    const stages = timings.sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 15);
    const stageLabel = event => `${event.stage}${event.stage === "page.actionStep" ? ` #${event.stepIndex + 1} ${event.action}` : ""}`;
    lines.push(...(stages.length ? stages.map(event => `- ${event.elapsedMs} ms · ${stageLabel(event)}${event.tabId !== undefined ? ` · tab ${event.tabId}` : ""}`) : ["- No browser stages captured (enable diagnostics before performing actions)."]));
    lines.push("", "## Browser event log (oldest to newest)");
    const browserEvents = session.events.filter(event => event.kind === "timing" && (["end", "cdp"].includes(event.event) || event.stage === "cdp.slow")).slice(-limit);
    for (const event of browserEvents) {
      const time = new Date(event.atMs).toISOString().slice(11, 23);
      lines.push(`- ${time} · ${stageLabel(event)} · ${event.event || "slow"}${event.method ? ` · ${event.method}` : ""}${typeof event.elapsedMs === "number" ? ` · ${event.elapsedMs} ms` : ""}${event.count ? ` · ×${event.count}` : ""}${event.code ? ` · ${event.code}` : ""}`);
    }
    if (!browserEvents.length) lines.push("- No detailed browser events captured.");
    lines.push("", "## Cloudflare ↔ extension UTC timeline");
    const stamps = session.events.filter(event => event.kind === "timing" && event.event === "stamp" && event.requestId).slice(-limit);
    const previous = new Map();
    for (const event of stamps) {
      const earlier = previous.get(event.requestId);
      const delta = earlier === undefined ? "" : ` · Δ ${event.atMs - earlier} ms`;
      previous.set(event.requestId, event.atMs);
      lines.push(`- ${new Date(event.atMs).toISOString()} · ${event.requestId.slice(0, 8)} · ${event.stage}${delta}`);
    }
    if (!stamps.length) lines.push("- No relay UTC timestamps captured.");
    lines.push("", "Note: GAP is time between one MCP tool's completion in the extension and the next call's arrival. It includes ChatGPT/client/network delay; it is not exclusively model thinking time.");
    lines.push("Cloudflare and desktop UTC comparisons assume approximately synchronized clocks; negative deltas suggest clock skew. Neither the model's internal processing time nor the MCP client's receipt of the final response is observable here.");
    if (session.events.filter(event => event.kind !== "timing").length > limit) lines.push(`Timeline limited to the latest ${limit} entries.`);
    if (session.events.filter(event => event.kind === "timing").length > limit) lines.push(`Browser events limited to the latest ${limit} entries.`);
    const result = { chatTabId, groupId: session.groupId, recording: session.recording,
      completedCalls: completed.length, interCallGaps: gaps.length, droppedEvents: session.droppedEvents,
      reportMarkdown: lines.join("\n") };
    if (stop) await flush();
    return result;
  }

  return { start, beginTool, endTool, timing, report };
}
