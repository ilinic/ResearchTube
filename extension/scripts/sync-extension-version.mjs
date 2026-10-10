import { readFile, writeFile } from "node:fs/promises";

// Chrome's manifest is authoritative; npm files carry derived build metadata.
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
for (const name of ["package.json", "package-lock.json"]) {
  const url = new URL(`../${name}`, import.meta.url);
  const text = await readFile(url, "utf8");
  const data = JSON.parse(text);
  data.version = manifest.version;
  if (name === "package-lock.json") data.packages[""].version = manifest.version;
  const updated = JSON.stringify(data, null, 2) + "\n";
  if (updated !== text) await writeFile(url, updated);
}
