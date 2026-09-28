import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, agent] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../../agent/researchtube_agent.py", import.meta.url), "utf8")
]);

for (const tool of ["media_clip", "media_clip_get_task", "media_clip_cancel_task"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published`);
}
assert.match(background, /segments: \{ type: "array", minItems: 1, maxItems: 20/);
assert.match(background, /omit segments to process the entire source/);
assert.match(background, /each interval creates a separate output file in the same input order/);
assert.match(background, /cutMode=copy is the default and preserves encoded streams without transcoding/);
assert.match(background, /cutMode=accurate re-encodes for precise requested boundaries/);
assert.match(background, /progressPercent comes from actual FFmpeg processing progress/);
assert.match(background, /function normalizeMediaClipInput\(/);
assert.match(background, /function normalizeMediaClipTask\(/);
assert.match(background, /"\/tasks\/media-clip"/);
assert.match(agent, /MEDIA_CLIP_MAX_SEGMENTS = 20/);
assert.match(agent, /"-progress", "pipe:1"/);
assert.match(agent, /out_time_us=/);
assert.match(agent, /progress_percent = max\(task\.progress_percent/);
assert.match(agent, /media_clip_publish_without_overwrite/);
assert.match(agent, /task\.clips\.append\(clip\)/);
assert.match(agent, /await MEDIA_CLIP_TASKS\.shutdown\(\)/);
console.log("media clip tool: ok");
