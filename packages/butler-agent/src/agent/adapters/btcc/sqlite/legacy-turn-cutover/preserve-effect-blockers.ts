import type { Database } from "bun:sqlite";
import { bindLegacyEffectBlockersToWork } from
  "../guided-work-effect-blockers.ts";
import { digest, stableJson } from "../identity.ts";
import type {
  LegacyTurnCutoverBlocker,
  PendingLegacyTurnCutoverBlocker,
} from "./contracts.ts";
import type { LegacyTurnRow } from "./legacy-turn-preflight.ts";

export function preserveLegacyEffectBlockers(
  db: Database,
  turn: LegacyTurnRow,
  blockers: readonly PendingLegacyTurnCutoverBlocker[],
  createdAt: string,
): void {
  const sourceProgramId = legacyProgramId(turn.managed_state_json);
  const workId = existingWorkId(db, turn.turn_id, sourceProgramId);
  for (const blocker of blockers) {
    const reconciliation = blocker.reconciliation;
    if (!reconciliation) continue;
    const inputJson = stableJson(reconciliation.input);
    const blockerId = digest(
      `btcc-r3-work-effect-blocker.v1\0${reconciliation.sourceOccurrenceId}` +
        `\0${reconciliation.target}`,
    );
    db.query(`
      INSERT OR IGNORE INTO btcc_guided_work_effect_blockers (
        blocker_id, source_turn_id, source_program_id, source_occurrence_id,
        session_id, work_id, capability, target, input_json, input_sha256,
        idempotency_key, detail, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)
    `).run(
      blockerId,
      turn.turn_id,
      sourceProgramId,
      reconciliation.sourceOccurrenceId,
      turn.session_id,
      workId,
      reconciliation.capability,
      reconciliation.target,
      inputJson,
      digest(inputJson),
      reconciliation.idempotencyKey,
      blocker.detail,
      createdAt,
    );
  }
  if (workId) {
    bindLegacyEffectBlockersToWork(db, {
      workId,
      sessionId: turn.session_id,
      ...(sourceProgramId ? { sourceProgramId } : {}),
      sourceTurnId: turn.turn_id,
    });
  }
}

export function publicCutoverBlockers(
  blockers: readonly PendingLegacyTurnCutoverBlocker[],
): LegacyTurnCutoverBlocker[] {
  return blockers.map(({ reconciliation: _reconciliation, ...blocker }) => blocker);
}

function existingWorkId(
  db: Database,
  turnId: string,
  sourceProgramId: string | null,
): string | null {
  const bound = db.query<{ work_id: string }, [string]>(`
    SELECT work_id FROM btcc_guided_turn_work_bindings
    WHERE turn_id = ? AND is_current = 1
  `).get(turnId)?.work_id;
  if (bound) return bound;
  if (!sourceProgramId) return null;
  return db.query<{ work_id: string }, [string]>(`
    SELECT work_id FROM btcc_guided_work_legacy_imports
    WHERE legacy_program_id = ? ORDER BY imported_at DESC LIMIT 1
  `).get(sourceProgramId)?.work_id ?? null;
}

function legacyProgramId(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { programId?: unknown };
    return typeof parsed.programId === "string" && parsed.programId.trim()
      ? parsed.programId.trim()
      : null;
  } catch {
    return null;
  }
}
