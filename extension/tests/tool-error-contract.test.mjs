import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const first = background.indexOf("function toolError(");
const last = background.indexOf("\nfunction disabledMcpToolError", first);
assert.ok(first >= 0 && last > first, "tool-error helpers must exist");
const { toolError } = new Function(`${background.slice(first, last)}\nreturn { toolError };`)();

const expected = toolError(1, { code: "VISUAL_MAP_INVALID", message: "startSeconds must be less than endSeconds." });
assert.equal(expected.result.isError, false);
assert.deepEqual(expected.result.structuredContent, {
  status: "rejected",
  error: { code: "VISUAL_MAP_INVALID", message: "startSeconds must be less than endSeconds.", detail: null }
});

const state = toolError(2, { code: "TASK_NOT_FOUND", message: "The requested task does not exist." });
assert.equal(state.result.isError, false);

for (const code of ["CAPTURE_FRAME_INVALID", "MEDIA_CLIP_INVALID", "CAMERA_RECORD_INVALID", "LIBRARY_STORE_INVALID", "MEDIA_TO_CHAT_INVALID", "MEDIA_TO_CHAT_TASK_NOT_FOUND", "CONFIG_INVALID", "TIMER_INVALID", "TIMER_NOT_FOUND"]) {
  const result = toolError(4, { code, message: "Requested 3; configured maximum is 2." });
  assert.equal(result.result.isError, false, `${code} must be an ordinary rejected tool result`);
  assert.match(result.result.content[0].text, /configured maximum is 2/);
}

const technical = toolError(3, { code: "AGENT_UNAVAILABLE", message: "The Local Agent is not available." });
assert.equal(technical.result.isError, true);
assert.equal(technical.result.structuredContent.error.code, "AGENT_UNAVAILABLE");
console.log("tool error contract: ok");
