import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, agent] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../../agent/researchtube_agent.py", import.meta.url), "utf8")
]);

assert.match(background, /name: "media_capture_screen"/);
assert.match(background, /Capture the complete current virtual desktop or one requested region/);
assert.match(background, /Small platform display queries provide only truthful virtual-desktop bounds and monitorCount/);
assert.match(background, /gdigrab on Windows/);
assert.match(background, /x11grab on Linux\/X11/);
assert.match(background, /avfoundation/);
assert.match(background, /Wayland capture is intentionally not supported/);
assert.doesNotMatch(background, /researchtube_install_linux_screen_capture_dependencies/);
assert.doesNotMatch(background, /install-linux-screen-capture-dependencies/);
assert.match(background, /screenshots\//);
assert.match(background, /"\/media\/capture-screen"/);
assert.match(background, /function normalizeScreenCaptureInput\(/);
assert.match(background, /region requires x, y, width, and height/);
assert.match(agent, /region must lie completely inside the current virtual desktop/);
assert.match(background, /_x, _y, _w, and _h tags immediately before its unique ID/);
assert.match(agent, /"-offset_x", str\(region\["x"\]\)/);
assert.match(background, /outputPath extension must match image\.format/);
assert.match(background, /monitorCount/);
assert.match(background, /virtualDesktop/);
assert.match(background, /FFmpeg is the only pixel-capture implementation/);
assert.match(background, /showInChat/);
assert.match(background, /The tool never returns a host path and never overwrites an existing workspace file/);
console.log("screen capture tool: ok");
