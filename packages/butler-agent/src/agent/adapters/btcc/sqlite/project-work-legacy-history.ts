import type { Database } from "bun:sqlite";
import type { ProjectWorkLegacySnapshot } from "../project-ledger/index.ts";
import {
  allowedNextWorkStages,
  dispositionMaterialFingerprint,
  type DurableWorkDisposition,
  type DurableWorkReview,
  type DurableWorkView,
} from "../../../btcc/work/index.ts";
import { digest, stableJson } from "./identity.ts";
import type { GuidedWorkDispositionRow } from "./guided-work-records.ts";
import { parseWorkJson } from "./guided-work-view-hydrators.ts";

/** Reconstructs only histories whose exact disposition material is provable. */
export function readLegacyDispositions(
  db: Database,
  work: DurableWorkView,
  plans: ProjectWorkLegacySnapshot["plans"],
  checkpoints: ProjectWorkLegacySnapshot["checkpoints"],
  reviews: ProjectWorkLegacySnapshot["reviews"],
): ProjectWorkLegacySnapshot["dispositions"] {
  const rows = db.query<GuidedWorkDispositionRow, [string]>(`
    SELECT * FROM btcc_guided_work_disposition_revisions
    WHERE work_id = ? ORDER BY revision
  `).all(work.workId);
  if (rows.length === 0) return [];
  assertNoHistoricalEffects(db, work.workId);
  const effectWatermark = digest(stableJson([]));
  return rows.map((row) => {
    const disposition: DurableWorkDisposition = {
      dispositionRevisionId: row.disposition_revision_id,
      revision: row.revision,
      resultSequence: row.result_sequence,
      materialFingerprint: row.material_fingerprint,
      runtimeOwnedOpen: row.runtime_owned_open === 1,
      disposition: row.disposition,
      summary: row.summary,
      actionUpdates: parseWorkJson(row.action_updates_json),
      remainingActions: parseWorkJson(row.remaining_actions_json),
      ...(row.next_condition ? { nextCondition: row.next_condition } : {}),
      evidenceRefs: parseWorkJson(row.evidence_refs_json),
      evidenceSnapshot: parseWorkJson(row.evidence_snapshot_json),
      followups: parseWorkJson(row.followups_json),
      originTurnId: row.origin_turn_id,
      createdAt: row.created_at,
    };
    const currentPlan = plans.filter((item) => item.createdAt <= row.created_at).at(-1);
    const checkpointItem = checkpoints
      .filter((item) => item.checkpoint.createdAt <= row.created_at)
      .at(-1);
    const checkpointIndex = checkpointItem
      ? checkpoints.indexOf(checkpointItem)
      : -1;
    const priorCheckpointSequence = checkpointIndex > 0
      ? checkpoints[checkpointIndex - 1]!.toResultSequence
      : 0;
    const latestCheckpoint = checkpointItem
      ? {
          ...checkpointItem.checkpoint,
          referencedResultRefs: work.resultRefs
            .slice(priorCheckpointSequence, checkpointItem.toResultSequence)
            .map((item) => item.resultRef),
        }
      : undefined;
    const bySubject = (subject: DurableWorkReview["subject"]) => reviews
      .filter((item) => item.subject === subject && item.createdAt <= row.created_at)
      .at(-1);
    const resultRefs = work.resultRefs.slice(0, row.result_sequence);
    if (resultRefs.length !== row.result_sequence)
      invalid("project_work_legacy_disposition_result_missing");
    const historicalView: DurableWorkView = {
      workId: work.workId,
      sessionId: work.sessionId,
      scope: work.scope,
      origin: work.origin,
      objective: currentPlan?.objective ?? work.objective,
      status: row.disposition,
      ...(latestCheckpoint
        ? {
            currentStage: latestCheckpoint.stage,
            latestCheckpoint,
            actionProgress: latestCheckpoint.actionProgress,
          }
        : { actionProgress: currentPlan?.actions.map((action) => ({
            actionKey: action.actionKey,
            status: "pending" as const,
          })) ?? [] }),
      allowedNextStages: allowedNextWorkStages(latestCheckpoint?.stage),
      ...(currentPlan ? { currentPlan } : {}),
      ...(bySubject("plan") ? { latestPlanReview: bySubject("plan") } : {}),
      ...(bySubject("result") ? { latestResultReview: bySubject("result") } : {}),
      ...(bySubject("completion")
        ? { latestCompletionValidation: bySubject("completion") }
        : {}),
      resultRefs,
      effectWatermark,
      effectBlockers: [],
      createdAt: work.createdAt,
      updatedAt: row.created_at,
    };
    if (dispositionMaterialFingerprint(historicalView) !== row.material_fingerprint)
      invalid("project_work_legacy_disposition_material_mismatch");
    return { disposition, historicalView, effectWatermark };
  });
}

function assertNoHistoricalEffects(db: Database, workId: string): void {
  for (const table of ["btcc_guided_effects", "btcc_guided_work_effect_blockers"])
    if ((db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE work_id = ?`,
    ).get(workId)?.count ?? 0) > 0)
      invalid("project_work_legacy_disposition_effect_history_unavailable");
}

function invalid(code: string): never { throw new Error(code); }
