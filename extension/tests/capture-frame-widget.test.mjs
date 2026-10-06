import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [widget, viewerHtml, viewer, background] = await Promise.all([
  readFile(new URL("../ui/capture-frame-widget-v30.html", import.meta.url), "utf8"),
  readFile(new URL("../media-viewer.html", import.meta.url), "utf8"),
  readFile(new URL("../media-viewer.js", import.meta.url), "utf8"),
  readFile(new URL("../background.js", import.meta.url), "utf8")
]);

assert.match(widget, /researchtube-image-view-ready/, "all media use the working acknowledged relay");
assert.match(widget, /startMediaView\(viewer\)/, "images, audio and video share the same retryable handshake");
assert.match(widget, /mediaKind: viewer.info.mediaKind/, "the actual media kind reaches the Extension");
assert.match(widget, /action-request/, "Copy shares the bound media relay");
assert.doesNotMatch(widget, /researchtube-local-media-ready|researchtube\/extension-bridge/, "new widgets never notify the obsolete overlay");
assert.doesNotMatch(widget, /media_load_workspace_image/, "the MCP App must not call back through the ChatGPT MCP bridge for localhost media");
assert.doesNotMatch(widget, /127\.0\.0\.1/, "the MCP App must not contain a loopback URL");
assert.doesNotMatch(widget, /fetch\(/, "the MCP App must not fetch local media itself");
assert.match(widget, /jsonrpc: "2\.0"/, "the parent fallback must be a valid JSON-RPC notification");
assert.match(widget, /root\.style\.minHeight = "620px"/, "the hidden anchor must reserve space for the Extension overlay");
assert.match(widget, /workspacePath/, "the media anchor must preserve the logical workspace path");

assert.match(viewer, /researchtube_media_viewer_resolve/, "the extension-owned viewer must resolve media through the service worker");
assert.match(viewer, /researchtube_capture_frame_local_action/, "the extension-owned viewer must copy paths through the service worker");
assert.match(viewerHtml, /<video id="video" controls preload="metadata" playsinline controlslist="nodownload noplaybackrate nofullscreen" disablepictureinpicture>/);
assert.match(viewerHtml, /<audio id="audio" controls preload="metadata">/);
assert.match(viewer, /chrome\.runtime\.sendMessage/, "the viewer must use extension messaging, not ChatGPT network APIs");
assert.doesNotMatch(viewer, /window\.openai/, "the viewer is independent of the MCP Apps sandbox");
assert.match(background, /researchtube_media_viewer_resolve/, "the service worker must resolve a loopback URL only for the extension viewer");
assert.match(viewerHtml, /<script src="media-viewer.js"><\/script>/);
assert.doesNotMatch(viewerHtml, /<script>/, "extension pages cannot execute inline JavaScript");
const previousWidget = await readFile(new URL('../ui/capture-frame-widget-v28.html', import.meta.url), 'utf8');
assert.equal(viewerHtml.match(/<svg[\s\S]*?<\/svg>/)[0], previousWidget.match(/<svg[\s\S]*?<\/svg>/)[0], 'preserve the finalized Refresh SVG');
const copySvg = viewerHtml.match(/<svg[^>]*class="copy-icon"[\s\S]*?<\/svg>/)[0];
assert.match(copySvg, /viewBox="0 0 20 20"/);
assert.match(copySvg, /fill-rule="evenodd" clip-rule="evenodd"/);
assert.match(copySvg, /fill="currentColor"/);
assert.equal(widget.match(/<svg[^>]*class="copy-icon"[\s\S]*?<\/svg>/)[0],copySvg,'anchor and native viewer use the same supplied Copy SVG');
assert.match(viewerHtml, /\.copy-icon \{[^}]*stroke: none/, 'filled Copy path must not inherit the Refresh stroke');
assert.match(viewerHtml, /class="top-row"[\s\S]*?id="refresh"[\s\S]*?class="path-row"[\s\S]*?id="copy"/, 'controls belong to their respective caption rows');
console.log("capture frame widget: ok");
