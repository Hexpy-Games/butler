import type { Database } from "bun:sqlite";
import { hydrateSources } from "./source.ts";
import type { ProjectionSourceRow } from "./store.ts";
import { ensureSourceIndexSchema, indexMemorySourceText } from "./source-index.ts";

/** Offline, resumable derivation from canonical text; never calls an extractor. */
export function backfillSourceIndex(db: Database, sourceRoot: string) {
  ensureSourceIndexSchema(db);
  const failures: Array<{ sourceId: string; code: string }> = [];
  let indexed = 0;
  let after = "";
  const batchSize = 64;
  while (true) {
    const rows = db.query<ProjectionSourceRow, [string, number]>(`
      SELECT s.* FROM memory_chunk_sources s
      WHERE s.source_id>? AND NOT EXISTS(SELECT 1 FROM memory_source_text t WHERE t.source_id=s.source_id)
      ORDER BY s.source_id LIMIT ?
    `).all(after, batchSize);
    if (!rows.length) break;
    const hydrated = hydrateSources(sourceRoot, rows);
    db.transaction(() => {
      for (const row of rows) {
        const result = hydrated.get(row.source_id);
        if (!result?.value) {
          failures.push({ sourceId: row.source_id, code: result?.error ?? "memory_source_unavailable" });
          continue;
        }
        indexMemorySourceText(db, row.source_id, result.value.text);
        indexed++;
      }
    })();
    after = rows.at(-1)!.source_id;
  }
  const remaining = db.query<{ count: number }, []>(`
    SELECT COUNT(*) count FROM memory_chunk_sources s
    WHERE NOT EXISTS(SELECT 1 FROM memory_source_text t WHERE t.source_id=s.source_id)
  `).get()!.count;
  return { indexed, remaining, failures, modelCalls: 0 };
}
