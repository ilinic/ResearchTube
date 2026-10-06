import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, agent] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../../agent/researchtube_agent.py", import.meta.url), "utf8")
]);

for (const tool of ["media_clip", "media_clip_get_task", "media_clip_cancel_task"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published`);
}
assert.match(background, /segments: \{ type: "array", minItems: 1/);
assert.match(background, /omit segments to process the entire source/i);
assert.match(background, /each interval creates a separate output file in input order/);
assert.match(background, /cutMode=copy preserves encoded streams without transcoding/);
assert.match(background, /accurate re-encodes for precise boundaries/);
assert.match(background, /Poll media_clip_get_task no faster than pollIntervalMs/);
assert.match(background, /function normalizeMediaClipInput\(/);
assert.match(background, /function normalizeMediaClipTask\(/);
assert.match(background, /"\/tasks\/media-clip"/);
assert.match(agent, /configured_tool_limits\(\)\["mediaClipMaxSegments"\]/);
assert.match(agent, /"-progress", "pipe:1"/);
assert.match(agent, /out_time_us=/);
assert.match(agent, /progress_percent = max\(task\.progress_percent/);
assert.match(agent, /media_clip_publish_without_overwrite/);
assert.match(agent, /task\.clips\.append\(clip\)/);
assert.match(agent, /await MEDIA_CLIP_TASKS\.shutdown\(\)/);
console.log("media clip tool: ok");
