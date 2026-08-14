import type { Database } from "bun:sqlite";
import type {
  DurableWorkDisposition,
  DurableWorkDispositionActionUpdate,
} from "../../../btcc/work/index.ts";
import type { GuidedWorkDispositionRow } from "./guided-work-records.ts";
import { digest, stableJson } from "./identity.ts";

export function readLatestWorkDisposition(
  db: Database,
  workId: string,
): DurableWorkDisposition | undefined {
  const row = db.query<GuidedWorkDispositionRow, [string]>(`
    SELECT * FROM btcc_guided_work_disposition_revisions
    WHERE work_id = ? ORDER BY revision DESC LIMIT 1
  `).get(workId);
  if (!row) return undefined;
  return {
    dispositionRevisionId: row.disposition_revision_id,
    revision: row.revision,
    resultSequence: row.result_sequence,
    materialFingerprint: row.material_fingerprint,
    disposition: row.disposition,
    summary: row.summary,
    actionUpdates: JSON.parse(row.action_updates_json) as
      DurableWorkDispositionActionUpdate[],
    remainingActions: JSON.parse(row.remaining_actions_json) as string[],
    ...(row.next_condition ? { nextCondition: row.next_condition } : {}),
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    evidenceSnapshot: JSON.parse(row.evidence_snapshot_json) as string[],
    followups: JSON.parse(row.followups_json) as string[],
    originTurnId: row.origin_turn_id,
    createdAt: row.created_at,
  };
}

export function readWorkEffectWatermark(db: Database, workId: string): string {
  const rows = db.query<{
    effect_id: string;
    receipt_id: string;
    status: string;
    journal_revision: number;
    updated_at: string;
  }, [string]>(`
    SELECT effect_id, receipt_id, status, journal_revision, updated_at
    FROM btcc_guided_effects WHERE work_id = ? ORDER BY effect_id
  `).all(workId);
  return digest(stableJson(rows));
}
