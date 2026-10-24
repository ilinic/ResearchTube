import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { writeFile, readFile } from "node:fs/promises";
import { URL } from "node:url";
import { tools } from "../src/catalog";

const ajv = new Ajv({ strict: false, allowUnionTypes: true, code: { source: true, esm: true }, allErrors: false });
// Formats used by the Extension catalog. Unknown formats must fail this build.
ajv.addFormat("uuid", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
ajv.addFormat("uri", /^[a-z][a-z0-9+.-]*:[^\s]*$/i);
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
const names: Record<string, string> = {};
for (const tool of tools) { ajv.addSchema(tool.inputSchema, tool.name); names[tool.name] = tool.name; }
const text = "// Generated from the Extension catalog. Do not edit.\n" + standaloneCode(ajv, names)
  + "\nexport default {" + tools.map(t => t.name).join(",") + "};\n";
const destination = new URL("../src/validators.js", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8") !== text) throw Error("Run npm run validators");
} else await writeFile(destination, text);
console.log(`Generated ${tools.length} Worker-compatible argument validators`);
