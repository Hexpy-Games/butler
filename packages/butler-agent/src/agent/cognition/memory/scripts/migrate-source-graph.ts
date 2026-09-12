import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { migrateSourceGraph } from "../projection/schema-migration.ts";

const { values } = parseArgs({ options: {
  "source-graph": { type: "string" }, "output-graph": { type: "string" }, "source-root": { type: "string" },
}, strict: true });
if (!values["source-graph"] || !values["output-graph"] || !values["source-root"]) {
  throw new Error("Usage: migrate-source-graph.ts --source-graph <snapshot DB> --output-graph <new offline DB> --source-root <canonical snapshot root>");
}
const output = resolve(values["output-graph"]);
if (existsSync(output)) throw new Error("memory_migration_destination_exists");
const started = performance.now();
const source = new Database(resolve(values["source-graph"]), { readonly: true });
try { source.query("VACUUM INTO ?").run(output); } finally { source.close(); }
const db = new Database(output, { create: false, readwrite: true });
db.exec("PRAGMA foreign_keys=ON");
try {
  const result = migrateSourceGraph(db, resolve(values["source-root"]));
  console.log(JSON.stringify({ ...result, output, durationMs: performance.now() - started }));
} finally { db.close(); }
