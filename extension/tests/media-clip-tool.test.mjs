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
assert.match(background, /Omit segments for the full source/i);
assert.match(background, /Cut ordered video\/audio intervals into separate files/);
assert.match(background, /copy keeps encoded streams/);
assert.match(background, /accurate re-encodes for precise cuts/);
assert.match(background, /Read clip task progress and completed files\. Poll at pollIntervalMs/);
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
