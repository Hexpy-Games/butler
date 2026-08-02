import type { Database } from "bun:sqlite";
import type { DurableWorkEffectBlocker } from
  "../../../btcc/work/index.ts";

export function bindLegacyEffectBlockersToWork(
  db: Database,
  input: {
    workId: string;
    sessionId: string;
    sourceProgramId?: string;
    sourceTurnId?: string;
  },
): void {
  const selectors = [
    ...(input.sourceProgramId ? ["source_program_id = ?"] : []),
    ...(input.sourceTurnId ? ["source_turn_id = ?"] : []),
  ];
  if (selectors.length === 0) return;
  const args = [
    input.workId,
    input.sessionId,
    ...(input.sourceProgramId ? [input.sourceProgramId] : []),
    ...(input.sourceTurnId ? [input.sourceTurnId] : []),
  ];
  db.query(`
    UPDATE btcc_guided_work_effect_blockers SET work_id = ?
    WHERE session_id = ? AND status = 'unresolved'
      AND (${selectors.join(" OR ")})
  `).run(...args);
  preserveBlockedStatus(db, input.workId);
}

export function unresolvedEffectBlockersForWork(
  db: Database,
  workId: string,
): DurableWorkEffectBlocker[] {
  return db.query<{
    blocker_id: string;
    source_turn_id: string;
    capability: string;
    target: string;
    detail: string;
    created_at: string;
  }, [string]>(`
    SELECT blocker_id, source_turn_id, capability, target, detail, created_at
    FROM btcc_guided_work_effect_blockers
    WHERE work_id = ? AND status = 'unresolved'
    ORDER BY created_at, blocker_id
  `).all(workId).map((row) => ({
    blockerId: row.blocker_id,
    sourceTurnId: row.source_turn_id,
    capability: row.capability,
    target: row.target,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export function hasUnresolvedEffectBlockers(
  db: Database,
  workId: string,
): boolean {
  return Boolean(db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM btcc_guided_work_effect_blockers
    WHERE work_id = ? AND status = 'unresolved' LIMIT 1
  `).get(workId));
}

export function preserveBlockedStatus(db: Database, workId: string): void {
  if (!hasUnresolvedEffectBlockers(db, workId)) return;
  db.query(`
    UPDATE btcc_guided_works SET status = 'blocked', updated_at = ?
    WHERE work_id = ? AND status = 'open'
  `).run(new Date().toISOString(), workId);
}
