// Local-only tools. Browser read schemas remain owned by background.js.
export const LOCAL_YOUTUBE_TOOLS = Object.freeze(["youtube_search", "youtube_get_video", "youtube_get_transcript", "youtube_get_comments", "youtube_get_comment_replies", "youtube_get_channel_videos", "youtube_get_channel_playlists", "youtube_get_playlist_videos"]);
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const taskId = { type: "string", pattern: "^tsk_[A-Za-z0-9_-]{10}$" };
const str = { type: "string" }, num = { type: "integer", minimum: 0 }, nullable = { type: ["string", "null"] };
const error = { anyOf: [object({ code: str, message: str }), { type: "null" }] };
const task = object({ taskId, status: { enum: ["working", "completed", "cancelled", "failed"] }, phase: str, progressPercent: { type: "number", minimum: 0, maximum: 100 }, pollIntervalMs: num, videoId: str, collected: num, topLevel: num, replies: num, pages: num, maxComments: num, truncated: { type: "boolean" }, workspacePath: nullable, error });
export function localResearchDefinitions() {
  const titles = { youtube_comments_export: "Export YouTube comments (local)", youtube_research_task_status: "YouTube export progress (local)", youtube_research_task_cancel: "Cancel YouTube export (local)", youtube_dataset_read: "Read YouTube comment dataset (local)", youtube_bridge_status: "YouTube local connection status" };
  const define = (name, description, input, output) => ({ name, title: titles[name], description, inputSchema: input, outputSchema: output, annotations: { readOnlyHint: !name.endsWith("_export") && !name.endsWith("_cancel"), destructiveHint: false, openWorldHint: true } });
  return [
    define("youtube_comments_export", "Collect public comments through the signed-in Chrome page context into a Workspace JSONL dataset. Returns a task immediately. maxComments counts roots plus replies; includeReplies may increase collection time. Poll youtube_research_task_status. Existing files are never overwritten.", object({ videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,}$" }, sort: { enum: ["top", "newest"], default: "newest" }, maxComments: { type: "integer", minimum: 1, maximum: 100000, default: 10000 }, includeReplies: { type: "boolean", default: true } }, ["videoId"]), task),
    define("youtube_research_task_status", "Read local comment-export progress and retained results. Poll no faster than pollIntervalMs. Progress is measured against the requested collection ceiling; completion may contain fewer comments when YouTube has no more pages.", object({ taskId }), task),
    define("youtube_research_task_cancel", "Stop a local comment export. Already saved comments and the dataset file are preserved. Returns the terminal task snapshot.", object({ taskId }), task),
    define("youtube_dataset_read", "Read bounded records from a task's saved comment dataset, optionally filtering text or parent comment ID. offset is a matching-record offset. Files survive later collection failures; read only records actually published by this task.", object({ taskId, offset: { ...num, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, query: { type: "string", maxLength: 500 }, parentCommentId: { type: "string", maxLength: 500 } }, ["taskId"]), object({ records: { type: "array", items: commentRecordSchema() }, returned: num, nextOffset: { type: ["integer", "null"] }, collected: num })),
    define("youtube_bridge_status", "Diagnose the local Agent-to-extension connection without opening a tab. Browser calls require YouTube sign-in but retain anonymous page-context requests. Reuses a tab or creates one inactive; no account cookies are used.", object({}), object({ connected: { type: "boolean" }, extensionVersion: nullable, interfaceVersion: num, authentication: { const: "public-page-context" } }))
  ];
}
export function commentRecordSchema() {
  return object({ videoId: str, commentId: { type: "string", maxLength: 500 }, parentCommentId: { type: ["string", "null"], maxLength: 500 }, author: object({ name: { ...nullable, maxLength: 1000 }, channelId: { ...nullable, maxLength: 500 } }), text: { type: "string", maxLength: 30000 }, publishedAt: nullable, publishedText: { ...nullable, maxLength: 1000 }, likes: { type: ["integer", "null"], minimum: 0 }, authorIsCreator: { type: "boolean" }, isHearted: { type: "boolean" } });
}
export function projectCommentRecord(value) {
  const text = (v, max) => typeof v === "string" ? v.slice(0, max) : null;
  if (!value || typeof value.videoId !== "string" || typeof value.commentId !== "string") throw Error("Invalid comment record");
  return { videoId: value.videoId, commentId: value.commentId.slice(0, 500), parentCommentId: text(value.parentCommentId, 500), author: { name: text(value.author?.name, 1000), channelId: text(value.author?.channelId, 500) }, text: text(value.text, 30000) || "", publishedAt: null, publishedText: text(value.publishedText, 1000), likes: Number.isSafeInteger(value.likes) && value.likes >= 0 ? value.likes : null, authorIsCreator: value.authorIsCreator === true, isHearted: value.isHearted === true };
}
export function validateLocalArguments(schema, value) {
  if (schema.anyOf) return schema.anyOf.some(choice => validateLocalArguments(choice, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  const kinds = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isSafeInteger(value) ? "integer" : typeof value;
  if (kinds.length && !kinds.includes(kind) && !(kind === "integer" && kinds.includes("number"))) return false;
  if (value === null) return true;
  if (typeof value === "string") return value.length >= (schema.minLength || 0) && value.length <= (schema.maxLength ?? 100000) && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (typeof value === "number") return Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (Array.isArray(value)) return value.length <= (schema.maxItems ?? 10000) && value.every(item => validateLocalArguments(schema.items || {}, item));
  if (typeof value === "object") return (schema.required || []).every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => Object.hasOwn(schema.properties || {}, k) && validateLocalArguments(schema.properties[k], value[k]));
  return true;
}
