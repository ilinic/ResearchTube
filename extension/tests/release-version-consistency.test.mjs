import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const [manifestText, packageText, lockText, source, bundle, agent, widget] = await Promise.all([
  readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/background.js", import.meta.url), "utf8"),
  readFile(new URL("../../agent/researchtube_agent.py", import.meta.url), "utf8"),
  readFile(new URL("../ui/capture-frame-widget-v30.html", import.meta.url), "utf8")
]);
const manifest = JSON.parse(manifestText);
const sourceExtension = source.match(/const EXTENSION_VERSION = ([^;]+);/)?.[1];
const bundleExtension = bundle.match(/var EXTENSION_VERSION = ([^;]+);/)?.[1];
const sourceInterface = Number(source.match(/const REQUIRED_AGENT_INTERFACE_VERSION = (\d+);/)?.[1]);
const bundleInterface = Number(bundle.match(/var REQUIRED_AGENT_INTERFACE_VERSION = (\d+);/)?.[1]);
const agentVersion = agent.match(/AGENT_VERSION = "([^"]+)"/)?.[1];
const agentInterface = Number(agent.match(/INTERFACE_VERSION = (\d+)/)?.[1]);

assert.ok(sourceExtension && bundleExtension && agentVersion, "release versions must be declared");
assert.equal(sourceExtension, "chrome.runtime.getManifest().version", "manifest is the single runtime source");
assert.equal(bundleExtension, sourceExtension, "generated service-worker bundle and source extension version must match");
for (const version of [manifest.version, "9.8.7"]) {
  assert.equal(vm.runInNewContext(bundleExtension, { chrome: { runtime: { getManifest: () => ({ version }) } } }), version,
    "a manifest-only update must take effect without rebundling a version literal");
}
assert.equal(widget.match(/const WIDGET_VERSION = "([^"]+)";/)?.[1], "__EXTENSION_VERSION__", "worker stamps the media widget version");
assert.equal(widget.match(/data-researchtube-media-widget="([^"]+)"/)?.[1], "__EXTENSION_VERSION__", "worker stamps the media widget marker");
const packageVersion = JSON.parse(packageText).version;
const lock = JSON.parse(lockText);
assert.equal(packageVersion, manifest.version, "package metadata is derived from manifest");
assert.equal(lock.version, manifest.version, "lock root metadata is derived from manifest");
assert.equal(lock.packages[""].version, manifest.version, "lock package metadata is derived from manifest");
assert.match(agentVersion, /^\d+\.\d+\.\d+$/, "Agent has an independent implementation version");
// Do not compare Agent and Extension implementation versions: only interface
// versions determine compatibility. An unchanged component is not bumped.
assert.equal(bundleInterface, sourceInterface, "generated bundle and source interface version must match");
assert.equal(agentInterface, sourceInterface, "Agent and Extension interface versions must match");
// Exercise the build helper on a mismatched package/lock, without touching the checkout.
const fixture = await mkdtemp(join(tmpdir(), "researchtube-version-"));
try {
  await mkdir(join(fixture, "scripts"));
  await writeFile(join(fixture, "scripts", "sync-extension-version.mjs"), await readFile(new URL("../scripts/sync-extension-version.mjs", import.meta.url)));
  await writeFile(join(fixture, "manifest.json"), JSON.stringify({ version: "9.8.7" }));
  await writeFile(join(fixture, "package.json"), JSON.stringify({ version: "1.0.0", scripts: { build: "keep" } }));
  await writeFile(join(fixture, "package-lock.json"), JSON.stringify({ version: "2.0.0", packages: { "": { version: "3.0.0" }, "node_modules/example": { version: "4.0.0" } } }));
  execFileSync(process.execPath, [join(fixture, "scripts", "sync-extension-version.mjs")]);
  const syncedPackage = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
  const syncedLock = JSON.parse(await readFile(join(fixture, "package-lock.json"), "utf8"));
  assert.equal(syncedPackage.version, "9.8.7");
  assert.equal(syncedPackage.scripts.build, "keep");
  assert.equal(syncedLock.version, "9.8.7");
  assert.equal(syncedLock.packages[""].version, "9.8.7");
  assert.equal(syncedLock.packages["node_modules/example"].version, "4.0.0");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
console.log(`release versions: extension ${manifest.version}, agent ${agentVersion}, interface ${sourceInterface}`);
