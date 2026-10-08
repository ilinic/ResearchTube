const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
const number = { type: "number", minimum: 0 };
const nullableNumber = { type: ["number", "null"], minimum: 0 };
const taskId = { type: "string", pattern: "^tsk_[A-Za-z0-9_-]{10}$" };
const warning = object({ code: { enum: ["SYSTEM_CLOCK_CHANGED", "SYSTEM_LOCAL_TIME_CHANGED", "SYSTEM_SUSPEND_DETECTED", "EXECUTION_GAP_DETECTED", "INTERNET_CLOCK_STALE"] }, message: text, observedAtUtc: text, shiftSeconds: { type: ["number", "null"] }, gapSeconds: nullableNumber });
const error = object({ code: { enum: ["TIMER_INVALID", "TIMER_SYSTEM_SUSPENDED", "TIMER_INTERNET_UNAVAILABLE", "TIMER_FAILED"] }, message: text });
const sync = object({ provider: { const: "timeapi.io" }, sampledAtUtc: text, sampleAgeSeconds: number, roundTripMs: number, estimatedUncertaintyMs: number, systemClockOffsetSeconds: { type: "number" }, stale: { type: "boolean" } });
const fields = {
  taskId, status: { enum: ["working", "completed", "cancelled", "failed"] }, phase: { enum: ["preparing", "waiting", "completed", "cancelled", "failed"] },
  mode: { enum: ["duration", "until"] }, clockSource: { enum: ["system", "internet"] }, timeZone: text,
  createdAtUtc: text, startedAtUtc: nullableText, currentUtc: nullableText, targetUtc: nullableText,
  startedAtLocal: nullableText, currentLocal: nullableText, targetLocal: nullableText,
  currentUtcOffsetSeconds: { type: ["integer", "null"] }, targetUtcOffsetSeconds: { type: ["integer", "null"] },
  durationSeconds: nullableNumber, elapsedSeconds: nullableNumber, remainingSeconds: nullableNumber,
  progressPercent: { ...number, maximum: 100 }, pollIntervalMs: { type: "integer", minimum: 250 },
  completedAtUtc: nullableText, latenessSeconds: nullableNumber,
  sleepDetection: { enum: ["systemCounters", "executionGapOnly"] }, warnings: { type: "array", maxItems: 20, items: warning },
  warningCount: { type: "integer", minimum: 0 }, error: { anyOf: [error, { type: "null" }] }, clockSync: { anyOf: [sync, { type: "null" }] }
};
export const timerTaskSchema = object(fields);
export const TIMER_TOOL_NAMES = Object.freeze(["timer_start", "timer_status", "timer_cancel"]);

export function timerDefinitions(readAnnotations, writeAnnotations) {
  return [
    { name: "timer_start", title: "Start a real timer",
      description: "Start a real asynchronous pause: LLMs have no precise internal running clock. Use duration+unit or an ISO until timestamp (UTC/offset, or local timeZone). Default clockSource system; internet uses timeapi.io without fallback. Relative time is monotonic; deadlines follow the clock. Warnings report clock changes; sleep fails and restart loses timers. Poll timer_status in the same assistant turn at pollIntervalMs before dependent work; without tabId, ending the response does not schedule a later reply. Optional tabId notifies that ChatGPT tab on completion only if idle.",
      annotations: { ...writeAnnotations, openWorldHint: true },
      inputSchema: { ...object({ duration: { ...number, description: "Relative duration; mutually exclusive with until." }, unit: { enum: ["seconds", "minutes", "hours"], default: "seconds" }, until: { ...text, description: "Complete ISO timestamp; date and seconds required. Mutually exclusive with duration/unit." }, timeZone: { ...text, description: "IANA zone, for example Pacific/Auckland; defaults to browser local zone." }, clockSource: { enum: ["system", "internet"], default: "system" } }, []), oneOf: [{ required: ["duration"], not: { required: ["until"] } }, { required: ["until"], not: { anyOf: [{ required: ["duration"] }, { required: ["unit"] }] } }] },
      outputSchema: timerTaskSchema,
      _meta: { "openai/toolInvocation/invoking": "Starting timer…", "openai/toolInvocation/invoked": "Timer started." } },
    { name: "timer_status", title: "Check timer progress",
      description: "Read real remaining/elapsed time, progress, UTC/local timestamps, zone, clock warnings and internet synchronization. Poll at pollIntervalMs. Terminal records last until history eviction or Agent restart. With tabId, completion can notify idle ChatGPT; busy tabs are skipped.",
      annotations: readAnnotations, inputSchema: object({ taskId }), outputSchema: timerTaskSchema },
    { name: "timer_cancel", title: "Cancel a timer",
      description: "Cancel a working timer; terminal status remains. cancelled is false if already terminal. TIMER_NOT_FOUND may mean an unknown ID, history eviction or Agent/computer restart.",
      annotations: writeAnnotations, inputSchema: object({ taskId }), outputSchema: object({ task: timerTaskSchema, cancelled: { type: "boolean" } }) }
  ];
}

function fail(message, code = "TIMER_INVALID") { throw Object.assign(new Error(message), { code }); }
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
export function validateTimerInput(name, value) {
  if (!plain(value)) fail("Timer input must be an object.");
  if (name !== "timer_start") {
    if (Object.keys(value).length !== 1 || typeof value.taskId !== "string" || !/^tsk_[A-Za-z0-9_-]{10}$/.test(value.taskId)) fail("Use the unchanged taskId returned by timer_start.");
    return { taskId: value.taskId };
  }
  if (Object.keys(value).some((key) => !["duration", "unit", "until", "timeZone", "clockSource"].includes(key)) || Object.hasOwn(value, "duration") === Object.hasOwn(value, "until")) fail("Specify exactly one of duration or until and no unsupported fields.");
  if (value.clockSource !== undefined && !["system", "internet"].includes(value.clockSource)) fail("clockSource must be system or internet.");
  if (value.timeZone !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); } catch { fail("timeZone must be an available IANA time zone."); }
    if (typeof value.timeZone !== "string" || !value.timeZone) fail("timeZone must be a nonempty IANA name.");
  }
  if (Object.hasOwn(value, "duration")) {
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0 || value.unit !== undefined && !["seconds", "minutes", "hours"].includes(value.unit)) fail("duration must be nonnegative and finite; unit must be seconds, minutes or hours.");
  } else if (Object.hasOwn(value, "unit") || typeof value.until !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value.until)) fail("until must contain a complete ISO date/time including seconds; omit unit.");
  return { ...value };
}

// Project through the schema rather than returning unreviewed Agent fields.
function project(schema, value) {
  const bad = () => fail("The Local Agent returned invalid timer metadata.", "AGENT_INVALID_RESPONSE");
  if (schema.anyOf) {
    for (const child of schema.anyOf) { try { return project(child, value); } catch {} }
    bad();
  }
  if (schema.const !== undefined && value !== schema.const || schema.enum && !schema.enum.includes(value)) bad();
  if (value === null) { if (schema.type === "null" || Array.isArray(schema.type) && schema.type.includes("null")) return null; bad(); }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "object") {
    if (!plain(value) || schema.required.some((key) => !Object.hasOwn(value, key))) bad();
    return Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => [key, project(field, value[key])]));
  }
  if (type === "array") {
    if (!Array.isArray(value) || schema.maxItems !== undefined && value.length > schema.maxItems) bad();
    return value.map((item) => project(schema.items, item));
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || type === "integer" && !Number.isSafeInteger(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) bad();
  } else if (type && typeof value !== type) bad();
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) bad();
  return value;
}

export function normalizeTimerResult(name, value) {
  const result = project(name === "timer_cancel" ? object({ task: timerTaskSchema, cancelled: { type: "boolean" } }) : timerTaskSchema, value);
  const task = name === "timer_cancel" ? result.task : result;
  if (task.status === "working" && !["preparing", "waiting"].includes(task.phase) || task.status !== "working" && task.phase !== task.status || task.status === "completed" && (task.progressPercent !== 100 || task.remainingSeconds !== 0) || task.status !== "failed" && task.error !== null || task.warningCount < task.warnings.length || task.clockSource === "system" && task.clockSync !== null) fail("The Local Agent returned inconsistent timer metadata.", "AGENT_INVALID_RESPONSE");
  for (const key of ["createdAtUtc", "startedAtUtc", "currentUtc", "targetUtc", "completedAtUtc"]) {
    if (task[key] !== null && (!/Z$/.test(task[key]) || !Number.isFinite(Date.parse(task[key])))) fail("The Local Agent returned invalid UTC timer metadata.", "AGENT_INVALID_RESPONSE");
  }
  return result;
}
