// All optional Browser Agent performance logging lives behind this boundary.
// Never log CDP parameters/results, page text, URLs, prompts or file paths.
const DETAIL_KEYS = new Set(["sessionId", "taskId", "stage", "event", "spanId", "method", "outcome", "code", "elapsedMs", "sinceLaunchMs", "gapMs", "count", "frameCount", "rawNodes", "indexedNodes", "returnedNodes", "totalNodes", "characters", "bytes", "extraction", "mode", "enabled", "addedNodes", "updatedNodes", "removedNodes", "addedResources", "removedResources"]);
const round = value => Math.round(Math.max(0, value) * 10) / 10;
export function createBrowserDiagnostics({ enabled = false, sessionId, log = () => {}, now = () => performance.now() } = {}) {
  const launched = enabled ? now() : 0;
  const methods = new Map();
  let sequence = 0;
  const emit = (stage, details = {}) => {
    if (!enabled) return;
    const safe = {};
    for (const [key, value] of Object.entries(details)) {
      if (DETAIL_KEYS.has(key) && (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 100)) safe[key] = value;
    }
    try { log("timing", { sessionId, stage, sinceLaunchMs: round(now() - launched), ...safe }); } catch { /* Diagnostics never affect automation. */ }
  };
  const begin = (stage, details = {}) => {
    if (!enabled) return () => {};
    const started = now(), spanId = ++sequence;
    const before = new Map([...methods].map(([method, value]) => [method, { ...value }]));
    emit(stage, { ...details, spanId, event: "begin" });
    let closed = false;
    return (finished = {}) => {
      if (closed) return;
      closed = true;
      emit(stage, { ...details, ...finished, spanId, event: "end", elapsedMs: round(now() - started) });
      // Aggregate repeated IO/DOM calls; do not emit every chunk or retain bodies.
      for (const [method, total] of methods) {
        const old = before.get(method) || { count: 0, ms: 0 };
        if (total.count > old.count) emit(stage, { ...details, spanId, event: "cdp", method, count: total.count - old.count, elapsedMs: round(total.ms - old.ms) });
      }
    };
  };
  const span = async (stage, work, details = {}) => {
    const finish = begin(stage, details);
    try { const result = await work(); finish({ outcome: "ok" }); return result; }
    catch (error) { finish({ outcome: "failed", code: /^[A-Z0-9_]{1,80}$/.test(error?.code || "") ? error.code : "UNEXPECTED" }); throw error; }
  };
  const command = async (method, work) => {
    if (!enabled) return work();
    const started = now(); let outcome = "ok";
    try { return await work(); }
    catch (error) { outcome = "failed"; throw error; }
    finally {
      const elapsedMs = round(now() - started);
      const total = methods.get(method) || { count: 0, ms: 0 };
      total.count++; total.ms += elapsedMs; methods.set(method, total);
      if (elapsedMs >= 250 || outcome === "failed") emit("cdp.slow", { method, elapsedMs, outcome });
    }
  };
  return { enabled, now, event: emit, begin, span, command };
}
