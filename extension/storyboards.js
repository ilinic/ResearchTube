// Public storyboard contract. Raw player context stays in the page/Agent bridge.
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const integer = { type: "integer", minimum: 0 };
const positive = { type: "integer", minimum: 1 };
const videoId = { type: "string", pattern: "^[A-Za-z0-9_-]{11}$" };
const taskId = { type: "string", pattern: "^tsk_[A-Za-z0-9_-]{10}$" };
const variantId = { type: "string", pattern: "^storyboard_[1-9][0-9]*$" };
const timestampPositions = ["none", "topLeft", "topRight", "bottomLeft", "bottomRight"];
const frameTimestampPosition = { type: "string", enum: timestampPositions, default: "bottomRight" };
const reasons = ["STORYBOARD_NOT_AVAILABLE", "STORYBOARD_VIDEO_LIVE", "STORYBOARD_CONTEXT_UNAVAILABLE"];
const messages = {
  STORYBOARD_INVALID: "Check videoId, variantId, selection and taskId against the documented input.",
  STORYBOARD_NOT_AVAILABLE: "YouTube has no usable storyboards for this video.",
  STORYBOARD_VIDEO_LIVE: "Storyboards currently support finite videos, not live or upcoming streams.",
  STORYBOARD_CONTEXT_UNAVAILABLE: "Open the video in YouTube or check the Local Agent's yt-dlp installation, then retry.",
  STORYBOARD_VARIANT_NOT_FOUND: "Discover the available variants with youtube_storyboard_get_info.",
  STORYBOARD_SHEET_NOT_FOUND: "Every sheet index must be within the selected variant's sheetCount.",
  STORYBOARD_DOWNLOAD_FAILED: "A sheet could not be downloaded or safely published. Check availability, free space, and conflicting files.",
  TASK_NOT_FOUND: "The storyboard task does not exist in this Agent session."
};
const errorSchema = object({ code: { type: "string", enum: Object.keys(messages) }, message: { type: "string" } });
const variantSchema = object({ variantId, cellWidth: positive, cellHeight: positive, columns: positive, rows: positive,
  framesPerSheet: positive, frameIntervalEstimated: { type: "boolean" }, frameIntervalSeconds: { type: "number", exclusiveMinimum: 0 }, sheetCount: positive, format: { const: "jpeg" } });
const selectionSchema = { oneOf: [object({ mode: { const: "all" } }),
  object({ mode: { const: "range" }, startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } }),
  object({ mode: { const: "sheets" }, sheetIndexes: { type: "array", minItems: 1, items: integer } })] };
const rejected = object({ status: { const: "rejected" }, error: errorSchema });
const infoSchema = { type: "object", oneOf: [
  object({ videoId, durationSeconds: { type: "number", exclusiveMinimum: 0 }, available: { const: true }, variants: { type: "array", minItems: 1, items: variantSchema } }),
  object({ videoId, available: { const: false }, reason: { enum: reasons } }), rejected] };
const statuses = ["working", "completed", "cancelled", "failed"];
const sheetTimestampSchema = object({ sheetIndex: integer,
  frameTimestampsSeconds: { type: "array", minItems: 1, items: { type: "number", minimum: 0 } } });
const taskSchema = object({ taskId, status: { enum: statuses }, phase: { enum: ["resolving", "downloading", "publishing", "completed", "cancelled", "failed"] },
  progressPercent: { type: "number", minimum: 0, maximum: 100 }, completedSheets: integer, totalSheets: positive,
  downloadedSheets: integer, reusedSheets: integer, workspaceDirectory: { const: "storyboards" }, pollIntervalMs: { type: "integer", minimum: 1000 },
  frameTimestampPosition, sheetTimestamps: { type: "array", minItems: 1, items: sheetTimestampSchema }, failedSheetIndex: integer, error: errorSchema },
["taskId", "status", "phase", "progressPercent", "completedSheets", "totalSheets", "downloadedSheets", "reusedSheets", "workspaceDirectory", "pollIntervalMs", "frameTimestampPosition", "sheetTimestamps"]);
const cancelSchema = object({ taskId, status: { enum: statuses } });
export const STORYBOARD_TOOL_NAMES = Object.freeze(["youtube_storyboard_get_info", "youtube_storyboard_download", "youtube_storyboard_get_task", "youtube_storyboard_cancel_task"]);

export function storyboardDefinitions(readAnnotations, writeAnnotations) {
  const make = (name, title, description, inputSchema, outputSchema, write = false) => ({ name, title, description, inputSchema, outputSchema,
    annotations: { ...(write ? writeAnnotations : readAnnotations), openWorldHint: name.endsWith("get_info") || name.endsWith("download") } });
  return [
    make(STORYBOARD_TOOL_NAMES[0], "Get YouTube storyboard variants", "Discover pre-generated timeline-preview sheet variants. Returns cell geometry, interval and sheet count. frameIntervalEstimated marks timing inferred when YouTube has no nonzero interval or the last yt-dlp fallback only provides average fps; range boundaries then use that estimate. Reads the matching open YouTube tab first, then yt-dlp metadata. Creates no files and downloads no media or sheets. variantId is opaque; retain it unchanged.", object({ videoId }), infoSchema),
    make(STORYBOARD_TOOL_NAMES[1], "Download YouTube storyboard sheets", "Start one asynchronous task for all sheets, an inclusive time range within video duration, or zero-based sheet indexes of one discovered variant. Downloads YouTube's ready preview JPEG sheets only, never video/audio. sheetTimestamps always returns the calculated absolute time for every real tile. frameTimestampPosition controls whether those labels are drawn on the ready-made grid: bottomRight by default, or none, topLeft, topRight, or bottomLeft when explicitly requested; unused cells of a final partial sheet stay untouched. Files are directly in storyboards/ with video ID, sz_widthxheight, tstp_seconds, mesh_columnsxrows and sheet index tags in each filename. Never displays an image automatically. Poll youtube_storyboard_get_task at pollIntervalMs; use workspace_list on workspaceDirectory to find files.", object({ videoId, variantId, selection: selectionSchema, frameTimestampPosition }, ["videoId", "variantId", "selection"]), { type: "object", oneOf: [taskSchema, rejected] }, true),
    make(STORYBOARD_TOOL_NAMES[2], "Get storyboard task progress", "Get compact sheet counts and monotonic progress. Poll no faster than pollIntervalMs. Complete sheets remain in storyboards/ after failure or cancellation. Does not return images or a sheet-path array.", object({ taskId }), { type: "object", oneOf: [taskSchema, rejected] }),
    make(STORYBOARD_TOOL_NAMES[3], "Cancel storyboard download", "Stop current and queued transfers for one storyboard task. Preserves all completely published sheets. Repeating cancellation returns the existing terminal status.", object({ taskId }), { type: "object", oneOf: [cancelSchema, rejected] }, true)
  ];
}

function fail(code = "STORYBOARD_INVALID") { throw Object.assign(new Error(messages[code] || "The Agent returned invalid storyboard metadata."), { code }); }
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const matches = (schema, value) => typeof value === "string" && new RegExp(schema.pattern).test(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
export function validateStoryboardInput(name, args) {
  const keys = name.endsWith("get_info") ? ["videoId"] : name.endsWith("download") ? ["videoId", "variantId", "selection"] : ["taskId"];
  const allowed = name.endsWith("download") ? [...keys, "frameTimestampPosition"] : keys;
  if (!plain(args) || Object.keys(args).some(k => !allowed.includes(k)) || keys.some(k => !Object.hasOwn(args, k))) fail();
  if (keys.includes("taskId")) { if (!matches(taskId, args.taskId)) fail(); return { taskId: args.taskId }; }
  if (!matches(videoId, args.videoId)) fail();
  if (name.endsWith("get_info")) return { videoId: args.videoId };
  if (!matches(variantId, args.variantId) || !plain(args.selection) || (args.frameTimestampPosition !== undefined && !timestampPositions.includes(args.frameTimestampPosition))) fail();
  const s = args.selection;
  const position = args.frameTimestampPosition === undefined ? "bottomRight" : args.frameTimestampPosition;
  if (s.mode === "all" && Object.keys(s).length === 1) return { ...args, frameTimestampPosition: position, selection: { mode: "all" } };
  if (s.mode === "range" && Object.keys(s).length === 3 && finite(s.startSeconds) && finite(s.endSeconds) && 0 <= s.startSeconds && s.startSeconds <= s.endSeconds) return { ...args, frameTimestampPosition: position, selection: { mode: "range", startSeconds: s.startSeconds, endSeconds: s.endSeconds } };
  if (s.mode === "sheets" && Object.keys(s).length === 2 && Array.isArray(s.sheetIndexes) && s.sheetIndexes.length && s.sheetIndexes.every(i => Number.isInteger(i) && i >= 0)) return { ...args, frameTimestampPosition: position, selection: { mode: "sheets", sheetIndexes: [...new Set(s.sheetIndexes)] } };
  fail();
}

// Explicit field projection and fixed messages also protect MCP diagnostics
// from accidental future additions to Agent responses.
export function normalizeStoryboardResult(name, data) {
  const bad = () => fail("AGENT_INVALID_RESPONSE");
  if (!plain(data)) bad();
  if (data.status === "rejected") {
    if (!messages[data.error?.code]) bad();
    return { status: "rejected", error: { code: data.error.code, message: messages[data.error.code] } };
  }
  if (name.endsWith("get_info")) {
    if (!matches(videoId, data.videoId)) bad();
    if (data.available === false && reasons.includes(data.reason)) return { videoId: data.videoId, available: false, reason: data.reason };
    if (data.available !== true || !finite(data.durationSeconds) || data.durationSeconds <= 0 || !Array.isArray(data.variants) || !data.variants.length) bad();
    const variants = data.variants.map(v => {
      if (!plain(v) || !matches(variantId, v.variantId) || v.format !== "jpeg" || typeof v.frameIntervalEstimated !== "boolean" || !finite(v.frameIntervalSeconds) || v.frameIntervalSeconds <= 0 ||
          !["cellWidth", "cellHeight", "columns", "rows", "framesPerSheet", "sheetCount"].every(k => Number.isInteger(v[k]) && v[k] > 0) || v.framesPerSheet !== v.columns * v.rows) bad();
      return Object.fromEntries(Object.keys(variantSchema.properties).map(k => [k, v[k]]));
    });
    if (new Set(variants.map(v => v.variantId)).size !== variants.length) bad();
    return { videoId: data.videoId, durationSeconds: data.durationSeconds, available: true, variants };
  }
  if (!matches(taskId, data.taskId) || !statuses.includes(data.status)) bad();
  if (name.endsWith("cancel_task")) return { taskId: data.taskId, status: data.status };
  if (!taskSchema.properties.phase.enum.includes(data.phase) || !finite(data.progressPercent) || data.progressPercent < 0 || data.progressPercent > 100 ||
      !["completedSheets", "totalSheets", "downloadedSheets", "reusedSheets", "pollIntervalMs"].every(k => Number.isInteger(data[k]) && data[k] >= 0) ||
      data.pollIntervalMs < 1000 || data.totalSheets < 1 || data.completedSheets > data.totalSheets || data.completedSheets !== data.downloadedSheets + data.reusedSheets || data.workspaceDirectory !== "storyboards" ||
      !timestampPositions.includes(data.frameTimestampPosition) || !Array.isArray(data.sheetTimestamps) || data.sheetTimestamps.length !== data.totalSheets) bad();
  if (new Set(data.sheetTimestamps.map(sheet => sheet?.sheetIndex)).size !== data.sheetTimestamps.length || data.sheetTimestamps.some(sheet =>
      !plain(sheet) || !Number.isInteger(sheet.sheetIndex) || sheet.sheetIndex < 0 || !Array.isArray(sheet.frameTimestampsSeconds) || !sheet.frameTimestampsSeconds.length ||
      sheet.frameTimestampsSeconds.some(timestamp => !finite(timestamp) || timestamp < 0))) bad();
  if (data.status !== "working" && data.phase !== data.status || data.status === "working" && !["resolving", "downloading", "publishing"].includes(data.phase)) bad();
  if (data.status === "completed" && (data.progressPercent !== 100 || data.completedSheets !== data.totalSheets)) bad();
  if (data.status !== "failed" && data.error) bad();
  const result = Object.fromEntries(taskSchema.required.map(k => [k, data[k]]));
  if (data.status === "failed") {
    if (data.error?.code !== "STORYBOARD_DOWNLOAD_FAILED" || !Number.isInteger(data.failedSheetIndex) || data.failedSheetIndex < 0) bad();
    result.failedSheetIndex = data.failedSheetIndex;
    result.error = { code: data.error.code, message: messages[data.error.code] };
  }
  return result;
}
