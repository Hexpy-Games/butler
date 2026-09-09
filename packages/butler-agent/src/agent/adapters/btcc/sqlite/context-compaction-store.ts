import type { Database } from "bun:sqlite";
import type { ContextCompaction, ContextCompactionStore } from "../../../btcc/ports/context-compaction.ts";

/** Summary and its exact source boundary are published in one SQLite write. */
export class SqliteContextCompactionStore implements ContextCompactionStore {
  constructor(private readonly db: Database) {}
  load(turnId: string): ContextCompaction[] {
    return this.db.query<ContextCompaction, [string]>(`
      SELECT source_digest AS sourceDigest, covered_units AS coveredUnits, summary
      FROM btcc_context_compactions WHERE turn_id = ? ORDER BY covered_units DESC
    `).all(turnId);
  }
  save(turnId: string, value: ContextCompaction): void {
    this.db.query(`INSERT OR REPLACE INTO btcc_context_compactions
      (turn_id, source_digest, covered_units, summary) VALUES (?, ?, ?, ?)`)
      .run(turnId, value.sourceDigest, value.coveredUnits, value.summary);
  }
}
