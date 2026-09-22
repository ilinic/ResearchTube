import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

assert.match(background, /name: "system_check_debug_banner"/);
assert.match(background, /--silent-debugger-extension-api/);
assert.match(background, /banner_suppressed/, "suppressed result must be part of the MCP contract");
assert.match(background, /banner_enabled/, "enabled result must be part of the MCP contract");
assert.match(background, /mixed/, "mixed result must be part of the MCP contract");
assert.match(background, /unknown/, "unknown result must be part of the MCP contract");
assert.match(background, /chrome\.windows\.getAll/, "Extension must count normal windows and tabs itself");
assert.match(background, /"\/chrome\/debug-banner"/, "diagnosis must query the Local Agent every time");
assert.match(background, /executeToolCall\(request\.id, "system_check_debug_banner", \{\}, getDebugBannerStatus\)/);
assert.doesNotMatch(background, /processId|user-data-dir/, "MCP contract must not expose process or profile internals");
console.log("debug banner tool: ok");
