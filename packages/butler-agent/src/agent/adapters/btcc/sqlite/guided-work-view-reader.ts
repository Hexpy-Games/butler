import type { Database } from "bun:sqlite";
import {
  allowedNextWorkStages,
  progressForReplacementPlan,
  type DurableWorkContext,
  type DurableWorkReview,
  type DurableWorkView,
  type WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type {
  GuidedWorkCheckpointRow,
  GuidedWorkDispositionRow,
  GuidedWorkPlanRow,
  GuidedWorkResultRow,
  GuidedWorkReviewRow,
  GuidedWorkRelationTurn,
  GuidedWorkRow,
  GuidedWorkTurn,
} from "./guided-work-records.ts";
import { unresolvedEffectBlockersForWork } from
  "./guided-work-effect-blockers.ts";
import { guidedWorkMatchesScope } from "./guided-work-scope.ts";
import { digest, stableJson } from "./identity.ts";
import {
  WORK_RESULT_ORDER,
  hydrateCheckpoint,
  hydrateDisposition,
  hydratePlan,
  hydrateResultRef,
  hydrateReview,
} from "./guided-work-view-hydrators.ts";

const MAX_CONTEXT_RESULT_FACTS = 50;

type GuidedWorkContextResultRow = Pick<
  GuidedWorkResultRow,
  "tool_name" | "status" | "result_json" | "error_code"
>;

export class GuidedWorkViewReader {
  constructor(private readonly db: Database) {}

  turn(scope: WorkTurnScope): GuidedWorkRelationTurn {
    const turn = this.db.query<GuidedWorkRelationTurn, [string]>(`
      SELECT turn_id, session_id, original_message_id, original_message,
        semantic_state, execution_fence
      FROM btcc_turns WHERE turn_id = ?
    `).get(scope.turnId);
    if (!turn) throw new Error(`Durable Work Turn is not admitted: ${scope.turnId}`);
    if (turn.session_id !== scope.sessionId) {
      throw new Error(`Durable Work Turn Session does not match: ${scope.turnId}`);
    }
    return turn;
  }

  /**
   * Read a Turn immediately before creating or changing the sole Work
   * relation.  A cancelled Turn or a Turn whose execution fence moved is no
   * longer allowed to produce relation rows.
   */
  relationTurn(scope: WorkTurnScope): GuidedWorkRelationTurn {
    const turn = this.turn(scope);
    if (turn.semantic_state !== "admitted" || turn.execution_fence !== 0) {
      throw new Error(
        `Durable Work Turn is stopped or fenced (cancelled or execution fence changed): ${scope.turnId}`,
      );
    }
    return turn;
  }

  boundWork(turnId: string): GuidedWorkRow | null {
    return this.db.query<GuidedWorkRow, [string]>(`
      SELECT work.* FROM btcc_guided_turn_work_bindings binding
      JOIN btcc_guided_works work ON work.work_id = binding.work_id
      WHERE binding.turn_id = ? AND binding.is_current = 1
    `).get(turnId) ?? null;
  }

  sessionHead(sessionId: string): GuidedWorkRow | null {
    return this.db.query<GuidedWorkRow, [string]>(`
      SELECT work.* FROM btcc_guided_work_session_heads head
      JOIN btcc_guided_works work ON work.work_id = head.work_id
      WHERE head.session_id = ?
    `).get(sessionId) ?? null;
  }

  loadContext(scope: WorkTurnScope): DurableWorkContext | null {
    this.turn(scope);
    const bound = this.boundWork(scope.turnId);
    const work = bound
      ? (guidedWorkMatchesScope(bound, scope) ? bound : null)
      : this.openSessionHead(scope);
    if (!work) return null;
    return this.contextFor(work);
  }

  boundView(turnId: string): DurableWorkView | null {
    const work = this.boundWork(turnId);
    return work ? this.viewFor(work) : null;
  }

  view(workId: string): DurableWorkView {
    const work = this.db.query<GuidedWorkRow, [string]>(`
      SELECT * FROM btcc_guided_works WHERE work_id = ?
    `).get(workId);
    if (!work) throw new Error(`Durable Work record is missing: ${workId}`);
    return this.viewFor(work);
  }

  private openSessionHead(scope: WorkTurnScope): GuidedWorkRow | null {
    const work = this.sessionHead(scope.sessionId);
    if (!work || !guidedWorkMatchesScope(work, scope)) return null;
    return work.status === "open" || work.status === "blocked" ? work : null;
  }

  private contextFor(work: GuidedWorkRow): DurableWorkContext {
    const origin = this.db.query<GuidedWorkTurn, [string]>(`
      SELECT turn_id, session_id, original_message_id, original_message
      FROM btcc_turns WHERE turn_id = ?
    `).get(work.origin_turn_id);
    if (!origin || origin.original_message_id !== work.origin_message_id) {
      throw new Error(`Durable Work original request is unavailable: ${work.work_id}`);
    }
    const results = this.results(work.work_id);
    const contextResults = this.contextResults(work.work_id);
    return {
      work: this.viewFor(work, results),
      originalRequest: {
        turnId: origin.turn_id,
        messageId: origin.original_message_id,
        content: origin.original_message,
      },
      resultFacts: contextResults.map((result) => ({
        toolName: result.tool_name,
        status: result.status,
        ...(result.result_json !== null
          ? { resultJson: parseJson<unknown>(result.result_json) }
          : {}),
        ...(result.error_code ? { errorCode: result.error_code } : {}),
      })),
    };
  }

  private viewFor(
    work: GuidedWorkRow,
    loadedResults?: GuidedWorkResultRow[],
  ): DurableWorkView {
    const results = loadedResults ?? this.results(work.work_id);
    const plan = work.current_plan_revision_id
      ? this.db.query<GuidedWorkPlanRow, [string]>(`
          SELECT * FROM btcc_guided_work_plan_revisions
          WHERE plan_revision_id = ?
        `).get(work.current_plan_revision_id)
      : null;
    const hydratedPlan = plan ? hydratePlan(plan) : undefined;
    const checkpoint = this.latestCheckpoint(work.work_id);
    const inferredCheckpointPlanId = checkpoint?.plan_revision_id ??
      (checkpoint && hydratedPlan && checkpoint.created_at >= hydratedPlan.createdAt
        ? hydratedPlan.planRevisionId
        : undefined);
    const defaultProgress = hydratedPlan
      ? progressForReplacementPlan(hydratedPlan.actions, []).map((action) =>
          work.status === "completed" ? { ...action, status: "done" as const } : action)
      : [];
    const hydratedCheckpoint = checkpoint
      ? hydrateCheckpoint(
          this.db,
          work.work_id,
          checkpoint,
          inferredCheckpointPlanId,
          defaultProgress,
        )
      : undefined;
    const checkpointMatchesPlan = Boolean(
      hydratedPlan && hydratedCheckpoint &&
        hydratedCheckpoint.planRevisionId === hydratedPlan.planRevisionId,
    );
    const actionProgress = checkpointMatchesPlan
      ? hydratedCheckpoint!.actionProgress
      : defaultProgress;
    const currentStage = hydratedPlan
      ? (checkpointMatchesPlan ? hydratedCheckpoint!.stage : "planning")
      : hydratedCheckpoint?.stage;
    const planReview = this.latestReview(work.work_id, "plan");
    const resultReview = this.latestReview(work.work_id, "result");
    const completionValidation = this.latestReview(work.work_id, "completion");
    const disposition = this.latestDisposition(work.work_id);
    const effectBlockers = unresolvedEffectBlockersForWork(this.db, work.work_id);
    const effectWatermark = this.effectWatermark(work.work_id);
    return {
      workId: work.work_id,
      sessionId: work.session_id,
      scope: work.scope_kind === "project"
        ? { kind: "project", projectRef: work.scope_ref }
        : { kind: "session", sessionId: work.scope_ref },
      origin: { turnId: work.origin_turn_id, messageId: work.origin_message_id },
      objective: work.objective,
      status: work.status,
      ...(currentStage ? { currentStage } : {}),
      allowedNextStages: allowedNextWorkStages(currentStage),
      actionProgress,
      ...(hydratedPlan ? { currentPlan: hydratedPlan } : {}),
      ...(hydratedCheckpoint
        ? { latestCheckpoint: hydratedCheckpoint }
        : {}),
      ...(planReview
        ? { latestPlanReview: hydrateReview(this.db, work.work_id, planReview) }
        : {}),
      ...(resultReview
        ? { latestResultReview: hydrateReview(this.db, work.work_id, resultReview) }
        : {}),
      ...(completionValidation
        ? {
            latestCompletionValidation: hydrateReview(
              this.db,
              work.work_id,
              completionValidation,
            ),
          }
        : {}),
      ...(disposition
        ? { latestDisposition: hydrateDisposition(disposition) }
        : {}),
      effectWatermark,
      ...(effectBlockers.length > 0 ? { effectBlockers } : {}),
      resultRefs: results.map(hydrateResultRef),
      createdAt: work.created_at,
      updatedAt: work.updated_at,
    };
  }

  private latestCheckpoint(workId: string): GuidedWorkCheckpointRow | null {
    return this.db.query<GuidedWorkCheckpointRow, [string]>(`
      SELECT * FROM btcc_guided_work_checkpoint_revisions
      WHERE work_id = ? ORDER BY revision DESC LIMIT 1
    `).get(workId) ?? null;
  }

  private latestReview(
    workId: string,
    subject: DurableWorkReview["subject"],
  ): GuidedWorkReviewRow | null {
    return this.db.query<GuidedWorkReviewRow, [string, string]>(`
      SELECT * FROM btcc_guided_work_review_revisions
      WHERE work_id = ? AND subject = ? ORDER BY revision DESC LIMIT 1
    `).get(workId, subject) ?? null;
  }

  private latestDisposition(workId: string): GuidedWorkDispositionRow | null {
    return this.db.query<GuidedWorkDispositionRow, [string]>(`
      SELECT * FROM btcc_guided_work_disposition_revisions
      WHERE work_id = ? ORDER BY revision DESC LIMIT 1
    `).get(workId) ?? null;
  }

  private results(workId: string): GuidedWorkResultRow[] {
    return this.db.query<GuidedWorkResultRow, [string]>(`
      SELECT result.result_ref, result.sequence, result.tool_call_id,
        call.tool_name, call.status, NULL AS result_json, call.result_sha256,
        call.error_code, result.origin_turn_id, result.source_turn_rowid,
        result.source_turn_sequence, result.attached_at
      FROM btcc_guided_work_results result
      JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
      WHERE result.work_id = ? ORDER BY ${WORK_RESULT_ORDER}
    `).all(workId);
  }

  private contextResults(workId: string): GuidedWorkContextResultRow[] {
    const rows = this.db.query<GuidedWorkContextResultRow, [string]>(`
      SELECT call.tool_name, call.status, call.result_json, call.error_code
      FROM btcc_guided_work_results result
      JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
      WHERE result.work_id = ?
      ORDER BY ${WORK_RESULT_ORDER}
    `).all(workId);
    return rows.slice(-MAX_CONTEXT_RESULT_FACTS);
  }

  private effectWatermark(workId: string): string {
    const rows = this.db.query<{
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
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
