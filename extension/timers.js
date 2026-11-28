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
export const timerTaskSchema = object({...fields,repeat:{type:"boolean"},fireCount:{type:"integer",minimum:0},deliveryPending:{type:"boolean"},deliveryUncertain:{type:"boolean"}},Object.keys(fields));
export const TIMER_TOOL_NAMES = Object.freeze(["timer_start", "timer_status", "timer_cancel"]);

export function timerDefinitions(readAnnotations, writeAnnotations) {
  return [
    { name: "timer_start", title: "Start a persistent repeating chat timer",
      description: "Start a persistent repeating timer for the verified current ChatGPT tab. Unlimited wake-ups until timer_cancel; wait for idle and confirmed Send before the next interval. Survives browser/Agent restart and tabId changes. Call once, finish the response; never recreate it or poll waiting for completion. Use duration >= 1 second. No one-shot mode. If the persistent plan queue already drives this chat, use it instead.",
      annotations: { ...writeAnnotations, openWorldHint: true },
      inputSchema: object({ duration: { ...number, description: "Recurring interval, at least one second after unit conversion." }, unit: { enum: ["seconds", "minutes", "hours"], default: "seconds" }, timeZone: { ...text, description: "Optional IANA zone for displaying timestamps." } }, ["duration"]),
      outputSchema: timerTaskSchema,
      _meta: { "openai/toolInvocation/invoking": "Starting persistent timer…", "openai/toolInvocation/invoked": "Persistent timer started." } },
    { name: "timer_status", title: "Check timer progress",
      description: "Read the existing persistent timer by taskId: next deadline, fireCount, deliveryPending and deliveryUncertain. It stays active until cancelled. A busy chat postpones the wake-up; no need to poll in the same assistant turn or start another timer.",
      annotations: readAnnotations, inputSchema: object({ taskId }), outputSchema: timerTaskSchema },
    { name: "timer_cancel", title: "Cancel a timer",
      description: "Stop an existing persistent timer by taskId. No future wake-ups are sent after cancellation. Already delivered messages remain. cancelled is false if already terminal.",
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
  if (Object.keys(value).some(key=>!["duration","unit","timeZone"].includes(key)) || !Object.hasOwn(value,"duration")) fail("Specify duration and optional unit/timeZone for the persistent timer.");
  if (value.timeZone !== undefined) {
    if (typeof value.timeZone !== "string" || !value.timeZone) fail("timeZone must be a nonempty IANA name.");
    try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); } catch { fail("timeZone must be an available IANA time zone."); }
  }
  const unit=value.unit??"seconds";
  const factor={seconds:1,minutes:60,hours:3600}[unit];
  if (typeof value.duration!=="number" || !Number.isFinite(value.duration) || !["seconds","minutes","hours"].includes(unit) || value.unit===null || value.duration*factor<1 || !Number.isSafeInteger(Math.round(value.duration*factor*1000))) fail("A persistent timer needs a finite interval of at least one second; unit must be seconds, minutes or hours.");
  return {duration:value.duration,...(value.unit!==undefined?{unit}:{}),...(value.timeZone!==undefined?{timeZone:value.timeZone}:{})};

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
    return Object.fromEntries(Object.entries(schema.properties).filter(([key])=>Object.hasOwn(value,key)||schema.required.includes(key)).map(([key, field]) => [key, project(field, value[key])]));
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
