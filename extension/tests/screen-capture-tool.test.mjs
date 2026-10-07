import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, agent] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../../agent/researchtube_agent.py", import.meta.url), "utf8")
]);

assert.match(background, /name: "media_capture_screen"/);
assert.match(background, /Capture the virtual desktop or an in-bounds region/);
assert.match(background, /virtualDesktop/);
assert.match(agent, /gdigrab/);
assert.match(agent, /x11grab/);
assert.match(agent, /avfoundation/);
assert.match(background, /Wayland unsupported/);
assert.doesNotMatch(background, /researchtube_install_linux_screen_capture_dependencies/);
assert.doesNotMatch(background, /install-linux-screen-capture-dependencies/);
assert.match(background, /screenshots\//);
assert.match(background, /"\/media\/capture-screen"/);
assert.match(background, /function normalizeScreenCaptureInput\(/);
assert.match(background, /region requires x, y, width, and height/);
assert.match(agent, /region must lie completely inside the current virtual desktop/);
assert.match(agent, /_x.*_y.*_w.*_h/, "regional filenames retain coordinate tags");
assert.match(agent, /"-offset_x", str\(region\["x"\]\)/);
assert.match(background, /outputPath extension must match image\.format/);
assert.match(background, /monitorCount/);
assert.match(background, /virtualDesktop/);
assert.match(background, /Uses FFmpeg/);
assert.match(background, /showInChat/);
assert.match(background, /normalizeWorkspacePath/);
console.log("screen capture tool: ok");
