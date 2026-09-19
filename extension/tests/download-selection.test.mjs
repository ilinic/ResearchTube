import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const first = background.indexOf("function normalizeDownloadSelection(");
const last = background.indexOf("\nasync function startYouTubeDownload", first);
assert.ok(first >= 0 && last > first, "download selection normalizer must exist");

const { normalizeDownloadSelection } = new Function(
  `function localAgentError(code, message) { const error = new Error(message); error.code = code; return error; }\n${background.slice(first, last)}\nreturn { normalizeDownloadSelection };`
)();

assert.deepEqual(normalizeDownloadSelection({ combined: "22" }), { combined: "22" });
assert.deepEqual(normalizeDownloadSelection({ video: "best", audio: "251" }), { video: "best", audio: "251" });
assert.deepEqual(normalizeDownloadSelection({ audio: "best" }), { audio: "best" });
assert.throws(() => normalizeDownloadSelection({ combined: "22", audio: "251" }), { code: "FORMAT_SELECTION_INVALID" });
assert.throws(() => normalizeDownloadSelection({ video: "best[ext=mp4]" }), { code: "FORMAT_SELECTION_INVALID" });
console.log("download selection: ok");
