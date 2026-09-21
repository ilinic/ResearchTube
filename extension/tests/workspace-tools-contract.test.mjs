import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

for (const tool of ["workspace_list", "workspace_stat", "workspace_mkdir", "workspace_move", "workspace_delete", "workspace_share_start", "workspace_share_status", "workspace_share_stop", "media_probe", "capture_frame", "researchtube_get_capture_frame_image", "researchtube_copy_capture_frame_path"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published in tools/list`);
}
for (const tool of ["library_store_start", "library_store_status", "library_store_cancel"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published in tools/list`);
}
assert.match(background, /maxItems: 5/, "Library upload batches must be capped at five files");
assert.match(background, /libraryAvailability = "not_verified"/, "Library completion must not be claimed after ChatGPT submission");
assert.match(background, /"\/internal\/library-store-files"/, "only the Agent may resolve workspace paths for CDP");
assert.match(background, /"\/media\/capture-frame"/);
assert.match(background, /"\/media\/workspace-image"/);
for (const tool of ["youtube_get_download_formats", "youtube_get_download_task_diagnostics"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published in tools/list`);
}
assert.match(background, /youtubeFormats: youtubeFormatsSchema/);
assert.match(background, /youtube_get_download_formats\.downloadFormats/);
assert.match(background, /afterEventId/);
assert.match(background, /const REQUIRED_AGENT_INTERFACE_VERSION = 19;/);
assert.match(background, /tool === "library_store_status"/, "the Extension-local Library status poll must report an outcome to the Agent log");
assert.match(background, /\/mcp\/log\/\$\{tool\}/, "status reports must identify the tool without sending its inputs");
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
assert.doesNotMatch(background, /Public HTTPS URL served only by the Agent's image-only Cloudflare Quick Tunnel/);
assert.match(background, /outputPath/);
assert.match(background, /cloudflared/);
assert.match(background, /workspace_share_start/);
assert.match(background, /workspace_share_status/);
assert.match(background, /workspace_share_stop/);
assert.match(background, /ChatGPT may be unable to fetch it or use it as visual input/, "the public workspace share must not promise image input for ChatGPT");
assert.match(background, /not rely on this tool to inspect or analyze image pixels/, "the public share must state that vision use is unreliable");
assert.match(background, /use library_store_start instead/, "the public-share description must direct ChatGPT to the reliable attachment workflow");
assert.match(background, /no artificial intermediate segment/);
assert.doesNotMatch(background, /saveToLibrary/);
assert.doesNotMatch(background, /delivery\.workspacePath/);
assert.match(background, /--download-sections/);
assert.match(background, /youtube_get_download_formats/);
console.log("workspace tools contract: ok");
