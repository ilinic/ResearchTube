import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bridge = await readFile(new URL("../chatgpt-capture-frame-bridge.js", import.meta.url), "utf8");
assert.match(bridge, /web-sandbox\.oaiusercontent\.com/);
assert.match(bridge, /researchtube_capture_frame_local_action/);
assert.match(bridge, /copyPath/);
assert.match(bridge, /copyImage/);
assert.match(bridge, /downloadImage/);
assert.match(bridge, /local-action-result/);
console.log("chatgpt capture-frame bridge: ok");
