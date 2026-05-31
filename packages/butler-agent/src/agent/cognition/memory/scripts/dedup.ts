// Deduplicate LanceDB rows: keep only the most recent entry per session_id
// Usage: bun run packages/butler-agent/src/agent/cognition/memory/scripts/dedup.ts
import * as lancedb from "@lancedb/lancedb";
import { join } from "path";
import { BUTLER_DIR } from "./constants.ts";

const DB_PATH = join(BUTLER_DIR.MEMORY, "db", "butler.lance");

const db = await lancedb.connect(DB_PATH);
let table: any;
try {
  table = await db.openTable("butler_memory");
} catch {
  console.log("Table butler_memory does not exist — nothing to dedup.");
  process.exit(0);
}

const allRows = await table.query().toArray();
console.log(`Total rows before dedup: ${allRows.length}`);

// Group by session_id, collect all row ids
const groups = new Map<string, Array<{ id: string; timestamp: number }>>();
for (const row of allRows) {
  const sid = row.session_id as string;
  if (!groups.has(sid)) groups.set(sid, []);
  groups.get(sid)!.push({ id: row.id as string, timestamp: row.timestamp as number });
}

// For each session_id, keep the most recent chunk set (highest timestamp rows with matching chunk index)
// Strategy: keep rows whose id matches the latest timestamp batch
const toDelete: string[] = [];
for (const rows of groups.values()) {
  if (rows.length === 0) continue;

  // Find the max timestamp for this session
  const maxTs = Math.max(...rows.map(r => r.timestamp));

  // Delete rows that don't have the max timestamp
  for (const row of rows) {
    if (row.timestamp < maxTs) {
      toDelete.push(row.id);
    }
  }
}

if (toDelete.length === 0) {
  console.log("No duplicates found.");
  process.exit(0);
}

console.log(`Deleting ${toDelete.length} duplicate rows...`);

// Delete in batches of 100
const BATCH = 100;
for (let i = 0; i < toDelete.length; i += BATCH) {
  const batch = toDelete.slice(i, i + BATCH);
  const ids = batch.map(id => `'${id.replace(/'/g, "''")}'`).join(", ");
  await table.delete(`id IN (${ids})`);
}

const remaining = await table.query().toArray();
console.log(`Total rows after dedup: ${remaining.length}`);
console.log(`Removed: ${allRows.length - remaining.length} rows`);
