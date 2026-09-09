import type { Database } from "bun:sqlite";
import type {
  ProjectWorkLegacySnapshot,
  ResolvedProjectWorkScope,
} from "../project-ledger/index.ts";
import type { WorkTurnScope } from "../../../btcc/work/index.ts";
import {
  type DurableWorkView,
} from "../../../btcc/work/index.ts";
import { digest, stableJson } from "./identity.ts";
import type {
  GuidedWorkCheckpointRow,
  GuidedWorkPlanRow,
  GuidedWorkReviewRow,
} from "./guided-work-records.ts";
import {
  hydrateWorkActionProgress,
  hydrateWorkPlan,
  parseWorkJson,
} from "./guided-work-view-hydrators.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";
import { readLegacyDispositions } from "./project-work-legacy-history.ts";
import {
  legacySemanticOriginTurnIds,
  validateLegacyImportPreflight,
} from "./project-work-legacy-preflight.ts";

export type LegacyImportRow = {
  import_id: string;
  legacy_program_id: string;
  source_revision: string;
  work_id: string;
  session_id: string;
  scope_kind: string;
  scope_ref: string;
  source_authority: string;
};

export type LegacyWorkLocator = {
  work_id: string;
  session_id: string;
  scope_kind: string;
  scope_ref: string;
  ledger_project_id: string | null;
  canonical_head_sha256: string | null;
};

type BindingRow = {
  binding_revision_id: string;
  turn_id: string;
  revision: number;
  is_current: number;
  bound_at: string;
  session_id: string;
};

type TurnRow = {
  turn_id: string;
  session_id: string;
  original_message_id: string;
  original_message: string;
  semantic_state: string;
  execution_fence: number;
};

export function captureProjectWorkLegacySnapshot(
  db: Database,
  reader: GuidedWorkViewReader,
  input: { scope: WorkTurnScope; resolvedScope: ResolvedProjectWorkScope },
): ProjectWorkLegacySnapshot | null {
  reader.turn(input.scope);
  const rows = findLegacyProjectWorks(db, input.scope, input.resolvedScope);
  if (rows.length > 1) invalid("project_work_legacy_multiple_open_works");
  const row = rows[0];
  if (!row) return null;
  if (!hasLegacySemanticRows(db, row.work_id) && row.ledger_project_id) return null;
  if (row.ledger_project_id && row.ledger_project_id !== input.resolvedScope.ledgerProjectId)
    invalid("project_work_legacy_scope_conflict");
  const work = reader.view(row.work_id);
  const bindings = db.query<BindingRow, [string]>(`
    SELECT binding_revision_id, turn_id, revision, is_current, bound_at,
      session_id
    FROM btcc_guided_turn_work_bindings
    WHERE work_id = ? ORDER BY revision, binding_revision_id
  `).all(row.work_id).map((binding) => {
    if (binding.session_id !== input.scope.sessionId)
      invalid("project_work_legacy_binding_session_mismatch");
    return {
      bindingRevisionId: binding.binding_revision_id,
      turnId: binding.turn_id,
      revision: binding.revision,
      boundAt: binding.bound_at,
      isCurrent: binding.is_current === 1,
    };
  });
  if (bindings.some((binding) => !binding.isCurrent))
    invalid("project_work_legacy_stale_binding_invalid");
  const requiredTurnIds = new Set([
    work.origin.turnId,
    ...legacySemanticOriginTurnIds(db, row.work_id),
    ...work.resultRefs.map((result) => result.originTurnId),
    ...bindings.map((binding) => binding.turnId),
  ]);
  for (const turnId of requiredTurnIds)
    if (!bindings.some((binding) => binding.turnId === turnId))
      invalid("project_work_legacy_binding_missing");
  const plans = db.query<GuidedWorkPlanRow, [string]>(`
    SELECT * FROM btcc_guided_work_plan_revisions
    WHERE work_id = ? ORDER BY revision
  `).all(row.work_id).map(hydrateWorkPlan);
  const checkpoints = readCheckpoints(db, row.work_id, plans);
  const sourceReviews = readReviews(db, row.work_id, checkpoints, false);
  const reviews = readReviews(db, row.work_id, checkpoints, true);
  const canonicalWork: DurableWorkView = {
    ...work,
    ...(checkpoints.at(-1)
      ? { latestCheckpoint: checkpoints.at(-1)!.checkpoint }
      : {}),
    ...(reviews.filter((item) => item.subject === "plan").at(-1)
      ? { latestPlanReview: reviews.filter((item) => item.subject === "plan").at(-1) }
      : {}),
    ...(reviews.filter((item) => item.subject === "result").at(-1)
      ? { latestResultReview: reviews.filter((item) => item.subject === "result").at(-1) }
      : {}),
    ...(reviews.filter((item) => item.subject === "completion").at(-1)
      ? {
          latestCompletionValidation: reviews
            .filter((item) => item.subject === "completion")
            .at(-1),
        }
      : {}),
  };
  const dispositions = readLegacyDispositions(
    db,
    canonicalWork,
    plans,
    checkpoints,
    sourceReviews,
  );
  const turns = readTurns(db, requiredTurnIds, input.scope.sessionId);
  const prior = readLegacyImportRow(db, row.work_id);
  const sourceProgramId = prior?.legacy_program_id ?? `current-r3:${row.work_id}`;
  validateLegacyImportPreflight(db, input, row.work_id, sourceProgramId, prior);
  const originTurn = turns.find((turn) => turn.turnId === work.origin.turnId);
  if (!originTurn || originTurn.originalMessageId !== work.origin.messageId)
    invalid("project_work_legacy_origin_message_invalid");
  const sourceIdentity = prior
    ? `r2:${sourceProgramId}:${row.work_id}`
    : `current-r3:${row.work_id}`;
  const semantic = {
    sourceProgramId, sourceIdentity, work: canonicalWork, plans, checkpoints, reviews,
    dispositions, bindings, turns,
  };
  return {
    sourceKind: "sqlite_r3",
    sourceProgramIds: [sourceProgramId],
    ...semantic,
    sourceSha256: digest(stableJson(semantic)),
  };
}

export function findLegacyProjectWorks(
  db: Database,
  scope: WorkTurnScope,
  resolved: ResolvedProjectWorkScope,
): LegacyWorkLocator[] {
  return db.query<LegacyWorkLocator, [string, string]>(`
    SELECT work_id, session_id, scope_kind, scope_ref, ledger_project_id,
      canonical_head_sha256 FROM btcc_guided_works
    WHERE session_id = ? AND scope_kind = 'project' AND scope_ref = ?
      AND status IN ('open', 'blocked', 'completed')
    ORDER BY updated_at DESC, work_id
  `).all(scope.sessionId, resolved.appProjectId);
}

export function readLegacyImportRow(db: Database, workId: string) {
  return db.query<LegacyImportRow, [string]>(`
    SELECT import_id, legacy_program_id, source_revision, work_id,
      session_id, scope_kind, scope_ref, source_authority
    FROM btcc_guided_work_legacy_imports WHERE work_id = ?
  `).get(workId) ?? null;
}

export function hasLegacySemanticRows(db: Database, workId: string): boolean {
  for (const table of [
    "btcc_guided_work_plan_revisions",
    "btcc_guided_work_checkpoint_revisions",
    "btcc_guided_work_review_revisions",
    "btcc_guided_work_disposition_revisions",
  ]) if ((db.query<{ count: number }, [string]>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE work_id = ?`,
  ).get(workId)?.count ?? 0) > 0) return true;
  return false;
}

function readCheckpoints(
  db: Database,
  workId: string,
  plans: ProjectWorkLegacySnapshot["plans"],
): ProjectWorkLegacySnapshot["checkpoints"] {
  return db.query<GuidedWorkCheckpointRow, [string]>(`
    SELECT * FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = ? ORDER BY revision
  `).all(workId).map((row) => {
    const plan = plans.find((item) => item.planRevisionId === row.plan_revision_id);
    if (!plan) invalid("project_work_legacy_plan_missing");
    const refs = db.query<{ result_ref: string }, [string, number]>(`
      SELECT result_ref FROM btcc_guided_work_results
      WHERE work_id = ? AND sequence <= ? ORDER BY sequence
    `).all(workId, row.result_sequence)
      .map((item) => item.result_ref);
    return {
      fromResultSequence: 0,
      toResultSequence: row.result_sequence,
      checkpoint: {
        checkpointRevisionId: row.checkpoint_revision_id,
        revision: row.revision,
        planRevisionId: plan.planRevisionId,
        stage: row.stage,
        actionProgress: hydrateWorkActionProgress(
          row.action_states_json,
          plan.actions.map((action) => ({ actionKey: action.actionKey, status: "pending" as const })),
        ),
        publicSummary: row.public_summary,
        nextStep: row.next_step,
        referencedResultRefs: refs,
        originTurnId: row.origin_turn_id,
        createdAt: row.created_at,
      },
    };
  });
}

function readReviews(
  db: Database,
  workId: string,
  checkpoints: ProjectWorkLegacySnapshot["checkpoints"],
  mapResultActionProgress: boolean,
): ProjectWorkLegacySnapshot["reviews"] {
  return db.query<GuidedWorkReviewRow, [string]>(`
    SELECT * FROM btcc_guided_work_review_revisions WHERE work_id = ? ORDER BY revision
  `).all(workId).map((row) => {
    const checkpoint = checkpoints
      .filter((item) => item.checkpoint.createdAt <= row.created_at)
      .at(-1)?.checkpoint;
    return {
      reviewRevisionId: row.review_revision_id,
      revision: row.revision,
      subject: row.subject,
      verdict: row.verdict,
      summary: row.summary,
      corrections: parseWorkJson(row.corrections_json),
      ...(row.bound_plan_revision_id
        ? { boundPlanRevisionId: row.bound_plan_revision_id }
        : {}),
      ...(row.bound_result_review_revision_id
        ? { boundResultReviewRevisionId: row.bound_result_review_revision_id }
        : {}),
      ...(row.bound_action_states_json
        ? { boundActionProgress: parseWorkJson(row.bound_action_states_json) }
        : mapResultActionProgress && row.subject === "result" && checkpoint
          ? { boundActionProgress: checkpoint.actionProgress }
          : {}),
      boundResultRefs: row.bound_result_sequence === null ? [] : db.query<
        { result_ref: string }, [string, number]
      >(`SELECT result_ref FROM btcc_guided_work_results
         WHERE work_id = ? AND sequence <= ? ORDER BY sequence`)
        .all(workId, row.bound_result_sequence).map((item) => item.result_ref),
      originTurnId: row.origin_turn_id,
      createdAt: row.created_at,
    };
  });
}

function readTurns(
  db: Database,
  ids: Set<string>,
  sessionId: string,
): ProjectWorkLegacySnapshot["turns"] {
  return [...ids].sort().map((turnId) => {
    const row = db.query<TurnRow, [string]>(`
      SELECT turn_id, session_id, original_message_id, original_message,
        semantic_state, execution_fence FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    if (!row || row.session_id !== sessionId)
      invalid("project_work_legacy_turn_ownership_invalid");
    return {
      turnId: row.turn_id,
      sessionId: row.session_id,
      originalMessageId: row.original_message_id,
      originalMessage: row.original_message,
      semanticState: row.semantic_state,
      executionFence: row.execution_fence,
    };
  });
}

function invalid(code: string): never { throw new Error(code); }
