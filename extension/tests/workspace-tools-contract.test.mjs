import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

for (const tool of ["workspace_list", "workspace_stat", "workspace_mkdir", "workspace_move", "workspace_delete", "media_probe"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published in tools/list`);
  assert.match(background, new RegExp(`"/${tool.replace("workspace_", "workspace/").replace("media_probe", "media/probe")}"`), `${tool} must route to an Agent endpoint`);
}
assert.match(background, /const REQUIRED_AGENT_INTERFACE_VERSION = 8;/);
assert.match(background, /availableBytes/);
assert.match(background, /operatingSystem.*release.*version.*architecture/s);
assert.match(background, /function normalizeWorkspacePath\(/);
assert.match(background, /source.*destination.*never overwrites/s);
assert.match(background, /Non-empty directories are refused/);
console.log("workspace tools contract: ok");
