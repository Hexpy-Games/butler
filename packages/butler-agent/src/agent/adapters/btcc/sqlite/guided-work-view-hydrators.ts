import type { Database } from "bun:sqlite";
import {
  type DurableWorkActionProgress,
  type DurableWorkCheckpoint,
  type DurableWorkDisposition,
  type DurableWorkPlan,
  type DurableWorkReview,
  type DurableWorkToolResultRef,
} from "../../../btcc/work/index.ts";
import type {
  GuidedWorkCheckpointRow,
  GuidedWorkDispositionRow,
  GuidedWorkPlanRow,
  GuidedWorkResultRow,
  GuidedWorkReviewRow,
} from "./guided-work-records.ts";

/**
 * Turn-local journal order is authoritative for Work result presentation.
 * `sequence` remains the Work-local append boundary, while the source fields
 * make concurrent completion/replay deterministic. Legacy rows without source
 * evidence fall back to their existing Work sequence after ordered rows.
 */
export const WORK_RESULT_ORDER = `
  CASE WHEN result.source_turn_rowid IS NULL THEN 1 ELSE 0 END,
  result.source_turn_rowid,
  CASE WHEN result.source_turn_sequence IS NULL THEN 1 ELSE 0 END,
  result.source_turn_sequence,
  result.sequence,
  result.rowid
`;

export function hydratePlan(row: GuidedWorkPlanRow): DurableWorkPlan {
  return {
    planRevisionId: row.plan_revision_id,
    revision: row.revision,
    objective: row.objective,
    governingRefs: parseJson(row.governing_refs_json),
    actions: parseJson(row.actions_json),
    checks: parseJson(row.checks_json),
    originTurnId: row.origin_turn_id,
    createdAt: row.created_at,
  };
}

export function hydrateActionProgress(
  value: string,
  fallback: DurableWorkActionProgress[],
): DurableWorkActionProgress[] {
  const parsed = parseJson<DurableWorkActionProgress[]>(value);
  return parsed.length > 0 ? parsed : fallback;
}

export function hydrateCheckpoint(
  db: Database,
  workId: string,
  checkpoint: GuidedWorkCheckpointRow,
  inferredPlanRevisionId: string | undefined,
  defaultProgress: DurableWorkActionProgress[],
): DurableWorkCheckpoint {
  const prior = db.query<{ result_sequence: number }, [string, number]>(`
    SELECT result_sequence FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = ? AND revision < ? ORDER BY revision DESC LIMIT 1
  `).get(workId, checkpoint.revision)?.result_sequence ?? 0;
  const refs = db.query<{ result_ref: string }, [string, number, number]>(`
    SELECT result_ref FROM btcc_guided_work_results result
    WHERE work_id = ? AND sequence > ? AND sequence <= ?
    ORDER BY ${WORK_RESULT_ORDER}
  `).all(workId, prior, checkpoint.result_sequence).map((row) => row.result_ref);
  return {
    checkpointRevisionId: checkpoint.checkpoint_revision_id,
    revision: checkpoint.revision,
    planRevisionId: inferredPlanRevisionId ?? "legacy",
    stage: checkpoint.stage,
    actionProgress: hydrateActionProgress(
      checkpoint.action_states_json,
      defaultProgress,
    ),
    publicSummary: checkpoint.public_summary,
    nextStep: checkpoint.next_step,
    referencedResultRefs: refs,
    originTurnId: checkpoint.origin_turn_id,
    createdAt: checkpoint.created_at,
  };
}

export function hydrateReview(
  db: Database,
  workId: string,
  review: GuidedWorkReviewRow,
): DurableWorkReview {
  const boundResultRefs = review.bound_result_sequence === null
    ? []
    : db.query<{ result_ref: string }, [string, number]>(`
        SELECT result_ref FROM btcc_guided_work_results result
        WHERE work_id = ? AND sequence <= ?
        ORDER BY ${WORK_RESULT_ORDER}
      `).all(workId, review.bound_result_sequence).map((row) => row.result_ref);
  return {
    reviewRevisionId: review.review_revision_id,
    revision: review.revision,
    subject: review.subject,
    verdict: review.verdict,
    summary: review.summary,
    corrections: parseJson<string[]>(review.corrections_json),
    ...(review.bound_plan_revision_id
      ? { boundPlanRevisionId: review.bound_plan_revision_id }
      : {}),
    ...(review.bound_result_review_revision_id
      ? { boundResultReviewRevisionId: review.bound_result_review_revision_id }
      : {}),
    ...(review.bound_action_states_json
      ? {
          boundActionProgress: hydrateActionProgress(
            review.bound_action_states_json,
            [],
          ),
        }
      : {}),
    boundResultRefs,
    originTurnId: review.origin_turn_id,
    createdAt: review.created_at,
  };
}

export function hydrateDisposition(
  row: GuidedWorkDispositionRow,
): DurableWorkDisposition {
  return {
    dispositionRevisionId: row.disposition_revision_id,
    revision: row.revision,
    resultSequence: row.result_sequence,
    materialFingerprint: row.material_fingerprint,
    disposition: row.disposition,
    summary: row.summary,
    actionUpdates: parseJson(row.action_updates_json),
    remainingActions: parseJson(row.remaining_actions_json),
    ...(row.next_condition ? { nextCondition: row.next_condition } : {}),
    evidenceRefs: parseJson(row.evidence_refs_json),
    evidenceSnapshot: parseJson(row.evidence_snapshot_json),
    followups: parseJson(row.followups_json),
    originTurnId: row.origin_turn_id,
    createdAt: row.created_at,
  };
}

export function hydrateResultRef(row: GuidedWorkResultRow): DurableWorkToolResultRef {
  return {
    resultRef: row.result_ref,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    status: row.status,
    ...(row.result_sha256 ? { resultSha256: row.result_sha256 } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    originTurnId: row.origin_turn_id,
    attachedAt: row.attached_at,
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
