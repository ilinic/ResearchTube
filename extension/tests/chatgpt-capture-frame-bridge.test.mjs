import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [bridge, manifest] = await Promise.all([
  readFile(new URL("../chatgpt-capture-frame-bridge.js", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8")
]);
assert.match(bridge, /researchtube_capture_frame_local_action/);
assert.match(bridge, /copyPath/);
assert.match(bridge, /copyImage/);
assert.match(bridge, /downloadImage/);
assert.match(bridge, /local-action-result/);
assert.match(bridge, /local-media-ready/, "the content script must receive the widget media-anchor handshake");
assert.match(bridge, /frame\.contentWindow === source/, "the primary bridge must identify the exact MCP iframe by postMessage source");
assert.match(bridge, /widgetBridgeMessage/, "the primary bridge must unwrap the JSON-RPC fallback notification");
assert.match(bridge, /researchtube-local-media-ready/, "the content script must listen inside the sandbox iframe for its local CustomEvent");
assert.match(bridge, /new CustomEvent\("researchtube-local-action-result"/, "the content script must return local-action results inside the sandbox iframe");
assert.match(bridge, /media-viewer\.html/, "the content script must overlay the extension-owned viewer");
assert.match(bridge, /anchorHeight/, "the top-page overlay must preserve the anchor's measured height");
assert.match(bridge, /position:fixed/, "the extension viewer must cover only the sandbox widget viewport");
assert.match(bridge, /root\.style\.visibility = "hidden"/, "the original MCP widget content must remain a hidden layout anchor");
assert.match(manifest, /web_accessible_resources/, "the page must be allowed to embed the extension viewer");
assert.match(manifest, /media-viewer\.html/, "the extension viewer must be web-accessible on ChatGPT");
assert.match(manifest, /chatgpt\.com/, "the primary media bridge must run in the ChatGPT page");
assert.match(manifest, /web-sandbox\.oaiusercontent\.com/, "the fallback media bridge must also target the widget sandbox origin");
assert.match(manifest, /"all_frames": true/, "the media bridge must be injected into the sandbox iframe");
assert.match(bridge, /chrome\.runtime\.sendMessage/, "the widget bridge must route local actions to the Extension");
assert.match(manifest, /chatgpt-capture-frame-bridge\.js/, "the local widget bridge must be registered on ChatGPT pages");
console.log("chatgpt capture-frame bridge: ok");
