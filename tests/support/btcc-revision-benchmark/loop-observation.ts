import type { Database } from "bun:sqlite";

export function readValidatorRejections(
  db: Database | null,
  turnId: string,
): number | null {
  if (!db || !turnId) return null;
  if (tableExists(db, "btcc_guided_tool_calls")) return 0;
  if (
    tableExists(db, "btcc_checkpoints") &&
    tableExists(db, "btcc_phase_checkpoint_revisions")
  ) {
    return r2ValidatorRejections(db, turnId);
  }
  return null;
}

function r2ValidatorRejections(db: Database, turnId: string): number {
  let rejected = db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count
    FROM btcc_phase_checkpoint_revisions revision
    JOIN btcc_checkpoints checkpoint
      ON checkpoint.checkpoint_id = revision.checkpoint_id
    WHERE checkpoint.turn_id = ?
      AND revision.status = 'provider_product_rejected'
  `).get(turnId)?.count ?? 0;
  if (tableExists(db, "btcc_operational_interruptions")) {
    rejected += db.query<{ count: number }, [string]>(`
      SELECT COALESCE(SUM(activation_count), 0) AS count
      FROM btcc_operational_interruptions
      WHERE turn_id = ?
        AND json_extract(diagnostic_json, '$.kind') = 'provider_carrier_rejection'
    `).get(turnId)?.count ?? 0;
  }
  return rejected;
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(table));
}
