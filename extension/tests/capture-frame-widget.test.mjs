import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [widget, viewerHtml, viewer, background] = await Promise.all([
  readFile(new URL("../ui/capture-frame-widget-v27.html", import.meta.url), "utf8"),
  readFile(new URL("../media-viewer.html", import.meta.url), "utf8"),
  readFile(new URL("../media-viewer.js", import.meta.url), "utf8"),
  readFile(new URL("../background.js", import.meta.url), "utf8")
]);

assert.match(widget, /local-media-ready/, "the MCP App must announce a ready media anchor to its parent");
assert.match(widget, /new CustomEvent\("researchtube-local-media-ready"/, "the MCP App must notify its same-frame extension bridge directly");
assert.match(widget, /notifyLocalMedia\(viewer\)/, "the MCP App must hand media metadata to the Extension instead of loading localhost");
assert.match(widget, /local-action-request/, "the MCP App fallback must route path copy through the Extension");
assert.doesNotMatch(widget, /media_load_workspace_image/, "the MCP App must not call back through the ChatGPT MCP bridge for localhost media");
assert.doesNotMatch(widget, /127\.0\.0\.1/, "the MCP App must not contain a loopback URL");
assert.doesNotMatch(widget, /fetch\(/, "the MCP App must not fetch local media itself");
assert.match(widget, /jsonrpc: "2\.0"/, "the parent fallback must be a valid JSON-RPC notification");
assert.match(widget, /researchtube\/extension-bridge/, "the parent fallback must be namespaced away from MCP App traffic");
assert.match(widget, /root\.style\.minHeight = "620px"/, "the hidden anchor must reserve space for the Extension overlay");
assert.match(widget, /workspacePath/, "the media anchor must preserve the logical workspace path");

assert.match(viewer, /researchtube_media_viewer_resolve/, "the extension-owned viewer must resolve media through the service worker");
assert.match(viewer, /researchtube_capture_frame_local_action/, "the extension-owned viewer must copy paths through the service worker");
assert.match(viewerHtml, /<video id="video" controls playsinline controlslist="nodownload noplaybackrate nofullscreen" disablepictureinpicture>/);
assert.match(viewerHtml, /<audio id="audio" controls>/);
assert.match(viewer, /chrome\.runtime\.sendMessage/, "the viewer must use extension messaging, not ChatGPT network APIs");
assert.doesNotMatch(viewer, /window\.openai/, "the viewer is independent of the MCP Apps sandbox");
assert.match(background, /researchtube_media_viewer_resolve/, "the service worker must resolve a loopback URL only for the extension viewer");
assert.match(viewerHtml, /<script src="media-viewer.js"><\/script>/);
assert.doesNotMatch(viewerHtml, /<script>/, "extension pages cannot execute inline JavaScript");
console.log("capture frame widget: ok");
