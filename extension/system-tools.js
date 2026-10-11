import { browserGroupSchema } from "./browser-tools.js";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string" };
const id = { type: "integer", minimum: 0 };
const nullableId = { type: ["integer", "null"], minimum: 0 };
const taskId = { type: "string", pattern: "^tsk_[A-Za-z0-9_-]{10}$" };
const error = { ...object({ code: text, message: text }), type: ["object", "null"] };
export function systemToolDefinitions(widgetUri) {
  return [{
    name: "system_get_chat_context", title: "Connect this chat to its tab group",
    description: "Identify this exact ChatGPT tab through the ResearchTube widget and connect its existing Chrome tab group. Call with no arguments to start; poll with taskId at pollIntervalMs. Returns chatTabId and group tabs for site tools. cancel=true with taskId cancels binding. No popup launch is required; no tabs or drafts are changed. Finish the response if the client delays mounting the widget.",
    inputSchema: object({ taskId, cancel: { type: "boolean", default: false } }, []),
    outputSchema: object({ taskId, status: { enum: ["working", "completed", "failed", "cancelled"] }, phase: text, progressPercent: { type: "number", minimum: 0, maximum: 100 }, pollIntervalMs: { type: "integer", minimum: 100 }, chatTabId: nullableId, group: { ...browserGroupSchema, type: ["object", "null"] }, error }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: widgetUri }, "openai/outputTemplate": widgetUri, "openai/toolInvocation/invoking": "Connecting tab group…", "openai/toolInvocation/invoked": "Check tab group connection." }
  }, {
    name: "system_get_diagnostics", title: "Read recent ResearchTube errors",
    description: "Read recent ResearchTube errors and warnings, newest first. Default 20, maximum 100; optionally filter by tool, tabId or taskId. Includes tool names, stages, codes and timings without page/chat contents or credentials. Does not read website consoles or OpenAI blocks that never reached ResearchTube.",
    inputSchema: object({ limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, tool: { type: "string", pattern: "^[a-z][a-z0-9_]{0,99}$" }, tabId: id, taskId }, []),
    outputSchema: object({ extensionVersion: text, retained: id, returned: id, truncated: { type: "boolean" }, events: { type: "array", items: object({ timestamp: text, level: { enum: ["error", "warning"] }, source: { enum: ["tool", "browser", "extension"] }, tool: { type: ["string", "null"] }, stage: text, code: text, message: text, tabId: nullableId, chatTabId: nullableId, groupId: nullableId, taskId: { type: ["string", "null"] }, elapsedMs: { type: ["number", "null"], minimum: 0 }, method: { type: ["string", "null"] } }) } }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }];
}
export function validateSystemInput(name, value = {}) {
  const rule = systemToolDefinitions("").find(tool => tool.name === name)?.inputSchema;
  const invalid = () => { throw Object.assign(new Error("Invalid system-tool arguments."), { code: "INVALID_ARGUMENT" }); };
  if (!rule || !value || typeof value !== "object" || Array.isArray(value)) invalid();
  for (const [key, item] of Object.entries(value)) {
    const field = rule.properties[key];
    if (!field || field.type === "boolean" && typeof item !== "boolean" || field.type === "string" && (typeof item !== "string" || field.pattern && !new RegExp(field.pattern).test(item)) || field.type === "integer" && (!Number.isSafeInteger(item) || item < field.minimum || field.maximum != null && item > field.maximum)) invalid();
  }
  if (name === "system_get_chat_context" && value.cancel && !value.taskId) invalid();
  return { ...value };
}
