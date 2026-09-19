import { readFileSync, writeFileSync } from "node:fs";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node scripts/replace-youtubei-api-keys.mjs <bundle-path>");

const publicKeyLiteral = /API_KEY:\s*["']AIza[0-9A-Za-z_-]{20,}["']/g;
const runtimeKeyGetter = 'get API_KEY() { return globalThis.ytcfg?.get?.("INNERTUBE_API_KEY") || ""; }';
const source = readFileSync(outputPath, "utf8");
let replacements = 0;
const output = source.replace(publicKeyLiteral, () => {
  replacements += 1;
  return runtimeKeyGetter;
});

if (replacements === 0) {
  throw new Error("No bundled youtubei.js API-key literals were found; review the bundle transformation.");
}
if (/AIza[0-9A-Za-z_-]{20,}/.test(output)) {
  throw new Error("A Google-style API-key literal remains in the generated bundle.");
}

writeFileSync(outputPath, output);
console.log(`Replaced ${replacements} bundled youtubei.js public client-key literal(s) with runtime page getters.`);
