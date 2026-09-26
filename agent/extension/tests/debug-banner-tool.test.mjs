import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

assert.doesNotMatch(background, /name: "system_check_debug_banner"/);
assert.match(background, /mixed/, "mixed result must be part of the MCP contract");
assert.match(background, /unknown/, "unknown result must be part of the MCP contract");
assert.match(background, /chromeAutomation: normalizeChromeAutomation\(health\.chromeAutomation\)/, "health status must include the Agent automation state");
assert.match(background, /state: \{ type: "string", enum: \["enabled", "disabled", "mixed", "unknown"\] \}/);
assert.doesNotMatch(background, /chrome\/debug-banner/, "the former standalone status endpoint must not be used by the Extension");
assert.doesNotMatch(background, /processId|user-data-dir/, "MCP contract must not expose process or profile internals");
console.log("chrome automation health: ok");
