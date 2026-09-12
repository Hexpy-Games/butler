import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { backfillSourceIndex } from "../projection/source-index-migration.ts";

const { values } = parseArgs({ options: {
  graph: { type: "string" }, "source-root": { type: "string" },
}, strict: true });
if (!values.graph || !values["source-root"]) {
  throw new Error("Usage: build-source-index.ts --graph <offline graph copy> --source-root <canonical snapshot root>");
}
const db = new Database(resolve(values.graph), { create: false, readwrite: true });
db.exec("PRAGMA foreign_keys=ON");
const started = performance.now();
try {
  const result = backfillSourceIndex(db, resolve(values["source-root"]));
  console.log(JSON.stringify({ ...result, durationMs: performance.now() - started }));
  if (result.remaining || result.failures.length) process.exitCode = 1;
} finally { db.close(); }
