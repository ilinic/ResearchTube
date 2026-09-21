import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

for (const tool of ["workspace_list", "workspace_stat", "workspace_mkdir", "workspace_move", "workspace_delete", "media_probe", "capture_frame", "researchtube_get_capture_frame_image", "researchtube_copy_capture_frame_path"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published in tools/list`);
}
assert.match(background, /"\/media\/capture-frame"/);
assert.match(background, /"\/media\/workspace-image"/);
for (const tool of ["youtube_get_download_formats", "youtube_get_download_task_diagnostics"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published in tools/list`);
}
assert.match(background, /youtubeFormats: youtubeFormatsSchema/);
assert.match(background, /youtube_get_download_formats\.downloadFormats/);
assert.match(background, /afterEventId/);
assert.match(background, /const REQUIRED_AGENT_INTERFACE_VERSION = 15;/);
assert.match(background, /availableBytes/);
assert.match(background, /operatingSystem.*release.*version.*architecture/s);
assert.match(background, /function normalizeWorkspacePath\(/);
assert.match(background, /source.*destination.*never overwrites/s);
assert.match(background, /Non-empty directories are refused/);
assert.match(background, /ffprobeFileSizeBytes/);
assert.match(background, /author, creation time, location\/GPS/);
assert.match(background, /CAPTURE_FRAME_WIDGET_URI/);
assert.match(background, /resources\/read/);
assert.match(background, /text\/html;profile=mcp-app/);
assert.match(background, /captureFrameImageBase64/);
assert.doesNotMatch(background, /researchtube_copy_capture_frame_image/);
assert.doesNotMatch(background, /researchtube_download_capture_frame/);
assert.doesNotMatch(background, /chrome\.downloads\.download/);
assert.match(background, /chrome\.offscreen\.createDocument/);
assert.match(background, /capture-frame-offscreen\.html/);
assert.match(background, /saves only the image in the workspace/);
assert.match(background, /publicUrl/);
assert.match(background, /outputPath/);
assert.match(background, /cloudflared/);
assert.doesNotMatch(background, /saveToLibrary/);
assert.doesNotMatch(background, /delivery\.workspacePath/);
assert.match(background, /--download-sections/);
assert.match(background, /youtube_get_download_formats/);
console.log("workspace tools contract: ok");
