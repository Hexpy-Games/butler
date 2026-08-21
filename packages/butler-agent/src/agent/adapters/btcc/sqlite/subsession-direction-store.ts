import type { Database } from "bun:sqlite";
import type { CreateStewardDirectionInput, StewardDirection } from "../../../btcc/subsessions/index.ts";

export function createStewardDirection(
  db: Database,
  direction: CreateStewardDirectionInput,
): StewardDirection {
  return db.transaction(() => {
    const existing = directionBySourceMessage(db, direction.relation_id, direction.source_message_id);
    if (existing) return existing;
    const revision = (db.query<{ revision: number }, [string]>(`
      SELECT COALESCE(MAX(revision), 0) AS revision
      FROM btcc_subsession_directions WHERE relation_id = ?
    `).get(direction.relation_id)?.revision ?? 0) + 1;
    db.query(`
      INSERT INTO btcc_subsession_directions (
        instruction_id, relation_id, revision, source_parent_turn_id,
        source_message_id, instruction, status, created_at,
        applied_at, applied_child_turn_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
    `).run(direction.instruction_id, direction.relation_id, revision,
      direction.source_parent_turn_id, direction.source_message_id,
      direction.instruction, direction.created_at);
    return directionBySourceMessage(db, direction.relation_id, direction.source_message_id)!;
  }).immediate();
}

export function consumePendingStewardDirection(
  db: Database,
  input: { relationId: string; childTurnId: string },
): StewardDirection | null {
  return db.transaction(() => {
    const row = db.query<StewardDirection, [string]>(`
      SELECT instruction_id, relation_id, revision, source_parent_turn_id,
        source_message_id, instruction, status, created_at,
        applied_at, applied_child_turn_id
      FROM btcc_subsession_directions
      WHERE relation_id = ? AND status = 'pending'
      ORDER BY revision ASC LIMIT 1
    `).get(input.relationId);
    if (!row) return null;
    const appliedAt = new Date().toISOString();
    const updated = db.query(`
      UPDATE btcc_subsession_directions
      SET status = 'applied', applied_at = ?, applied_child_turn_id = ?
      WHERE instruction_id = ? AND status = 'pending'
    `).run(appliedAt, input.childTurnId, row.instruction_id);
    return updated.changes === 1
      ? { ...row, status: "applied" as const, applied_at: appliedAt,
          applied_child_turn_id: input.childTurnId }
      : null;
  }).immediate();
}

function directionBySourceMessage(
  db: Database,
  relationId: string,
  sourceMessageId: string,
): StewardDirection | null {
  return db.query<StewardDirection, [string, string]>(`
    SELECT instruction_id, relation_id, revision, source_parent_turn_id,
      source_message_id, instruction, status, created_at,
      applied_at, applied_child_turn_id
    FROM btcc_subsession_directions
    WHERE relation_id = ? AND source_message_id = ?
  `).get(relationId, sourceMessageId) ?? null;
}
