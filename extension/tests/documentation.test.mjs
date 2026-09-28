import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(extensionDir, "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const canonical = [
  "README.md", "AGENTS.md", "agent/README.md", "extension/README.md", "demo/README.md",
  "docs/README.md", "docs/ARCHITECTURE.md", "docs/DEVELOPMENT.md", "docs/TOOLS.md",
  "docs/INSTALLATION.md", "docs/TROUBLESHOOTING.md", "docs/ERRORS.md", "docs/DEMO.md",
  "docs/features/STORYBOARDS.md", "docs/features/MEDIA_VIEWER.md",
  "docs/features/TEXT_TO_SPEECH.md", "docs/features/MEDIA_CLIP.md"
];

for (const path of canonical) assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
assert.equal(existsSync(join(root, "extension/docs/ARCHITECTURE.md")), false, "legacy Extension architecture must not compete with canonical docs");
assert.equal(existsSync(join(root, "extension/docs/STORYBOARDS.md")), false, "legacy storyboard documentation must be removed");

for (const path of canonical) {
  const body = read(path);
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const resolved = resolve(dirname(join(root, path)), target);
    assert.equal(existsSync(resolved), true, `${path} has broken local link ${match[1]}`);
  }
}

const rootReadme = read("README.md");
assert.doesNotMatch(rootReadme, /v1\.5\.1|has no download, Task, or media-processing capability/i);
assert.match(rootReadme, /docs\/TROUBLESHOOTING\.md/);
assert.match(rootReadme, /demo\/researchtube-demo\.mp4/);

const background = read("extension/background.js");
const settingsStart = background.indexOf("const MCP_TOOL_SETTINGS = Object.freeze({");
const settingsEnd = background.indexOf("\n});", settingsStart);
assert.ok(settingsStart >= 0 && settingsEnd > settingsStart, "MCP settings registry must be parseable");
const registry = background.slice(settingsStart, settingsEnd);
const publicTools = [...registry.matchAll(/\b([a-z][a-z0-9_]+): \{ group:/g)].map((match) => match[1]);
const toolsDoc = read("docs/TOOLS.md");
for (const tool of publicTools) assert.match(toolsDoc, new RegExp("`" + tool + "`"), `${tool} must be documented`);
assert.doesNotMatch(toolsDoc, /`media_load_workspace_image` \|/, "private widget action must not be presented as a public row");
assert.match(background, /RESEARCHTUBE_DEMO_GUIDE_URL/);
assert.match(background, /demo\/researchtube-demo\.mp4/);
assert.match(background, /Run it only with consent/);

const demoPath = join(root, "agent/workspace/demo/researchtube-demo.mp4");
const demo = readFileSync(demoPath);
const manifest = JSON.parse(read("demo/manifest.json"));
assert.ok(demo.length > 100_000, "bundled demo must contain real media");
assert.equal(demo.includes(Buffer.from("ftyp")), true, "bundled demo must be an MP4-family file");
assert.equal(manifest.workspacePath, "demo/researchtube-demo.mp4");
assert.equal(manifest.sizeBytes, statSync(demoPath).size);
assert.equal(manifest.sha256, createHash("sha256").update(demo).digest("hex"));

const durableDocs = canonical.filter((path) => path.startsWith("docs/")).map(read).join("\n");
assert.doesNotMatch(durableDocs, /Extension\s+\d+\.\d+\.\d+|Agent\s+\d+\.\d+\.\d+|interface\s+\d+/i, "durable docs must not hard-code release versions");

console.log(`documentation: ${canonical.length} files, ${publicTools.length} public tools, demo verified`);
