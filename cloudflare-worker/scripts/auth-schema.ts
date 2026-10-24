import { getSchema } from "better-auth/db";
import { writeFile, readFile } from "node:fs/promises";
import { URL } from "node:url";
import { authOptions } from "../src/auth";
import type { Env } from "../src/types";

// Generate only the initial migration. Dependency upgrades require a new,
// reviewed migration; never rewrite a deployed database's history.
const schema = getSchema(authOptions({ PUBLIC_ORIGIN: "https://researchtube.invalid", EXTENSION_ORIGINS: "[]",
  BETTER_AUTH_SECRET: "schema-generation-only-not-a-runtime-secret", DB: undefined } as unknown as Env));
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
let sql = "-- Generated from pinned Better Auth options by npm run schema.\n";
for (const [table, definition] of Object.entries(schema).sort((a, b) => a[1].order - b[1].order)) {
  if (definition.disableMigrations) continue;
  const columns = ['"id" TEXT PRIMARY KEY NOT NULL'];
  for (const [name, field] of Object.entries(definition.fields)) {
    if (name === "id") continue;
    const type = ["number", "boolean", "date"].includes(String(field.type)) ? "INTEGER" : "TEXT";
    columns.push(`${quote(name)} ${type}${field.required ? " NOT NULL" : ""}${field.unique ? " UNIQUE" : ""}`
      + (field.references ? ` REFERENCES ${quote(field.references.model)}(${quote(field.references.field)}) ON DELETE ${field.references.onDelete?.toUpperCase() || "CASCADE"}` : ""));
  }
  sql += `\nCREATE TABLE ${quote(table)} (\n  ${columns.join(",\n  ")}\n);\n`;
  for (const index of definition.indexes || []) {
    sql += `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(table)} (${index.columns.map(quote).join(", ")});\n`;
  }
  for (const [name, field] of Object.entries(definition.fields)) if (field.index && !field.unique)
    sql += `CREATE INDEX ${quote(table + "_" + name + "_idx")} ON ${quote(table)} (${quote(name)});\n`;
}
const destination = new URL("../migrations/0001_auth.sql", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8") !== sql) throw Error("Auth schema changed: add and review a new migration");
} else await writeFile(destination, sql);
console.log(`Generated ${Object.keys(schema).length} auth tables`);
