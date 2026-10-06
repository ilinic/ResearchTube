import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [manifestText, packageText, lockText, source, bundle, agent] = await Promise.all([
  readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/background.js", import.meta.url), "utf8"),
  readFile(new URL("../../agent/researchtube_agent.py", import.meta.url), "utf8")
]);
const manifest = JSON.parse(manifestText);
const sourceExtension = source.match(/const EXTENSION_VERSION = "([^"]+)";/)?.[1];
const bundleExtension = bundle.match(/var EXTENSION_VERSION = "([^"]+)";/)?.[1];
const sourceInterface = Number(source.match(/const REQUIRED_AGENT_INTERFACE_VERSION = (\d+);/)?.[1]);
const bundleInterface = Number(bundle.match(/var REQUIRED_AGENT_INTERFACE_VERSION = (\d+);/)?.[1]);
const agentVersion = agent.match(/AGENT_VERSION = "([^"]+)"/)?.[1];
const agentInterface = Number(agent.match(/INTERFACE_VERSION = (\d+)/)?.[1]);

assert.ok(sourceExtension && bundleExtension && agentVersion, "release versions must be declared");
assert.equal(manifest.version, sourceExtension, "manifest and source extension version must match");
assert.equal(bundleExtension, sourceExtension, "generated service-worker bundle and source extension version must match");
const packageVersion = JSON.parse(packageText).version;
const lock = JSON.parse(lockText);
assert.equal(packageVersion, sourceExtension, "package and source Extension version must match");
assert.equal(lock.version, sourceExtension, "lock root and source Extension version must match");
assert.equal(lock.packages[""].version, sourceExtension, "lock package and source Extension version must match");
assert.match(agentVersion, /^\d+\.\d+\.\d+$/, "Agent has an independent implementation version");
// Do not compare Agent and Extension implementation versions: only interface
// versions determine compatibility. An unchanged component is not bumped.
assert.equal(bundleInterface, sourceInterface, "generated bundle and source interface version must match");
assert.equal(agentInterface, sourceInterface, "Agent and Extension interface versions must match");
console.log(`release versions: extension ${sourceExtension}, agent ${agentVersion}, interface ${sourceInterface}`);
