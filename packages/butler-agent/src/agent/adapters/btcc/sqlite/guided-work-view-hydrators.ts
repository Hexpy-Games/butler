import type {
  DurableWorkActionProgress,
  DurableWorkPlan,
  DurableWorkToolResultRef,
} from "../../../btcc/work/index.ts";
import type {
  GuidedWorkPlanRow,
  GuidedWorkResultRow,
} from "./guided-work-records.ts";

/** Deterministic Turn-journal order with a stable legacy fallback. */
export const WORK_RESULT_ORDER = `
  CASE WHEN result.source_turn_rowid IS NULL THEN 1 ELSE 0 END,
  result.source_turn_rowid,
  CASE WHEN result.source_turn_sequence IS NULL THEN 1 ELSE 0 END,
  result.source_turn_sequence,
  result.sequence,
  result.rowid
`;

export function hydrateWorkPlan(row: GuidedWorkPlanRow): DurableWorkPlan {
  return {
    planRevisionId: row.plan_revision_id,
    revision: row.revision,
    objective: row.objective,
    governingRefs: parseWorkJson(row.governing_refs_json),
    actions: parseWorkJson(row.actions_json),
    checks: parseWorkJson(row.checks_json),
    originTurnId: row.origin_turn_id,
    createdAt: row.created_at,
  };
}

export function hydrateWorkActionProgress(
  value: string,
  fallback: DurableWorkActionProgress[],
): DurableWorkActionProgress[] {
  const parsed = parseWorkJson<DurableWorkActionProgress[]>(value);
  return parsed.length > 0 ? parsed : fallback;
}

export function hydrateWorkResultRef(
  row: GuidedWorkResultRow,
): DurableWorkToolResultRef {
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

export function parseWorkJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
