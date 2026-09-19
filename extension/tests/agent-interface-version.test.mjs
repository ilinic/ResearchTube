import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const first = background.indexOf("function normalizeAgentInterfaceVersion(");
const last = background.indexOf("\nfunction normalizeAgentWorkspace", first);
assert.ok(first >= 0 && last > first, "agent interface helpers must exist");

const { normalizeAgentInterfaceVersion, agentInterfaceIsCompatible } = new Function(
  `const REQUIRED_AGENT_INTERFACE_VERSION = 8;\n${background.slice(first, last)}\nreturn { normalizeAgentInterfaceVersion, agentInterfaceIsCompatible };`
)();

assert.equal(normalizeAgentInterfaceVersion(1), 1);
assert.equal(normalizeAgentInterfaceVersion(2), 2);
assert.equal(normalizeAgentInterfaceVersion("1"), null);
assert.equal(normalizeAgentInterfaceVersion(0), null);
assert.equal(normalizeAgentInterfaceVersion(1.5), null);
assert.equal(normalizeAgentInterfaceVersion(null), null);
assert.equal(agentInterfaceIsCompatible({ available: true, interfaceVersion: 8 }), true);
assert.equal(agentInterfaceIsCompatible({ available: true, interfaceVersion: 6 }), false);
assert.equal(agentInterfaceIsCompatible({ available: true, interfaceVersion: 1 }), false);
assert.equal(agentInterfaceIsCompatible({ available: true, interfaceVersion: null }), false);
assert.equal(agentInterfaceIsCompatible({ available: false, interfaceVersion: 3 }), false);
console.log("agent interface version: ok");
