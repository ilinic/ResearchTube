import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

assert.doesNotMatch(background, /name: "system_check_debug_banner"/);
assert.match(background, /mixed/, "mixed result must be part of the MCP contract");
assert.match(background, /unknown/, "unknown result must be part of the MCP contract");
assert.match(background, /chromeAutomation: normalizeChromeAutomation\(health\.chromeAutomation\)/, "health status must include the Agent automation state");
assert.match(background, /state: \{ type: "string", enum: \["enabled", "disabled", "mixed", "unknown", "checking"\] \}/);
assert.doesNotMatch(background, /chrome\/debug-banner/, "the former standalone status endpoint must not be used by the Extension");
assert.doesNotMatch(background, /processId|user-data-dir/, "MCP contract must not expose process or profile internals");
console.log("chrome automation health: ok");

const first = background.indexOf("function normalizeChromeAutomation(");
const last = background.indexOf("async function getAgentStatus(", first);
const { normalizeChromeAutomation, normalizeAgentComponent } = new Function(
  `${background.slice(first, last)}\nreturn { normalizeChromeAutomation, normalizeAgentComponent };`
)();
const checking = { state: "checking", chromeRunning: null, browserInstances: 0, message: "Checking startup flags", commandLine: "private" };
assert.deepEqual(normalizeChromeAutomation(checking), { state: "checking", chromeRunning: null, browserInstances: 0, message: "Checking startup flags" });
assert.equal(normalizeChromeAutomation({ ...checking, state: "invalid" }), null);
assert.deepEqual(normalizeAgentComponent({ status: "checking", privatePath: "private" }), { status: "checking", version: null, source: null, message: null });
console.log("startup checking state normalization: ok");
