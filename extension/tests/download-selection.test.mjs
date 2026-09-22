import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const first = background.indexOf("function normalizeFormatSelection(");
const last = background.indexOf("\nasync function startYouTubeDownload", first);
assert.ok(first >= 0 && last > first, "download selection normalizer must exist");

const { normalizeFormatSelection } = new Function(
  `function localAgentError(code, message) { const error = new Error(message); error.code = code; return error; }\n${background.slice(first, last)}\nreturn { normalizeFormatSelection };`
)();

assert.deepEqual(normalizeFormatSelection({ combined: "22" }), { combined: "22" });
assert.deepEqual(normalizeFormatSelection({ video: "best", audio: "251" }), { video: "best", audio: "251" });
assert.deepEqual(normalizeFormatSelection({ audio: "best" }), { audio: "best" });
assert.throws(() => normalizeFormatSelection({ combined: "22", audio: "251" }), { code: "FORMAT_SELECTION_INVALID" });
assert.throws(() => normalizeFormatSelection({ video: "best[ext=mp4]" }), { code: "FORMAT_SELECTION_INVALID" });
console.log("format selection: ok");
