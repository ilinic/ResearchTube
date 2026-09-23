import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [bridge, manifest] = await Promise.all([
  readFile(new URL("../chatgpt-capture-frame-bridge.js", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8")
]);
assert.match(bridge, /web-sandbox\.oaiusercontent\.com/);
assert.match(bridge, /researchtube_capture_frame_local_action/);
assert.match(bridge, /copyPath/);
assert.match(bridge, /copyImage/);
assert.match(bridge, /downloadImage/);
assert.match(bridge, /local-action-result/);
assert.match(bridge, /chrome\.runtime\.sendMessage/, "the widget bridge must route local actions to the Extension");
assert.match(manifest, /chatgpt-capture-frame-bridge\.js/, "the local widget bridge must be registered on ChatGPT pages");
console.log("chatgpt capture-frame bridge: ok");
