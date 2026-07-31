import type { Database } from "bun:sqlite";
import type {
  DurableWorkCheckpoint,
  DurableWorkContext,
  DurableWorkPlan,
  DurableWorkReview,
  DurableWorkToolResultRef,
  DurableWorkView,
  WorkTurnScope,
} from "../../../btcc/durable-work/index.ts";
import type {
  GuidedWorkCheckpointRow,
  GuidedWorkPlanRow,
  GuidedWorkResultRow,
  GuidedWorkReviewRow,
  GuidedWorkRow,
  GuidedWorkTurn,
} from "./guided-work-records.ts";
import { guidedWorkMatchesScope } from "./guided-work-scope.ts";

const MAX_CONTEXT_RESULT_FACTS = 50;

type GuidedWorkContextResultRow = Pick<
  GuidedWorkResultRow,
  "tool_name" | "status" | "result_json" | "error_code"
>;

export class GuidedWorkViewReader {
  constructor(private readonly db: Database) {}

  turn(scope: WorkTurnScope): GuidedWorkTurn {
    const turn = this.db.query<GuidedWorkTurn, [string]>(`
      SELECT turn_id, session_id, original_message_id, original_message
      FROM btcc_turns WHERE turn_id = ?
    `).get(scope.turnId);
    if (!turn) throw new Error(`Durable Work Turn is not admitted: ${scope.turnId}`);
    if (turn.session_id !== scope.sessionId) {
      throw new Error(`Durable Work Turn Session does not match: ${scope.turnId}`);
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
    const checkpoint = this.latestCheckpoint(work.work_id);
    const planReview = this.latestReview(work.work_id, "plan");
    const resultReview = this.latestReview(work.work_id, "result");
    return {
      workId: work.work_id,
      sessionId: work.session_id,
      scope: work.scope_kind === "project"
        ? { kind: "project", projectRef: work.scope_ref }
        : { kind: "session", sessionId: work.scope_ref },
      origin: { turnId: work.origin_turn_id, messageId: work.origin_message_id },
      objective: work.objective,
      status: work.status,
      ...(plan ? { currentPlan: hydratePlan(plan) } : {}),
      ...(checkpoint
        ? { latestCheckpoint: this.hydrateCheckpoint(work.work_id, checkpoint) }
        : {}),
      ...(planReview
        ? { latestPlanReview: this.hydrateReview(work.work_id, planReview) }
        : {}),
      ...(resultReview
        ? { latestResultReview: this.hydrateReview(work.work_id, resultReview) }
        : {}),
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

  private hydrateCheckpoint(
    workId: string,
    checkpoint: GuidedWorkCheckpointRow,
  ): DurableWorkCheckpoint {
    const prior = this.db.query<{ result_sequence: number }, [string, number]>(`
      SELECT result_sequence FROM btcc_guided_work_checkpoint_revisions
      WHERE work_id = ? AND revision < ? ORDER BY revision DESC LIMIT 1
    `).get(workId, checkpoint.revision)?.result_sequence ?? 0;
    const refs = this.db.query<{ result_ref: string }, [string, number, number]>(`
      SELECT result_ref FROM btcc_guided_work_results
      WHERE work_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence
    `).all(workId, prior, checkpoint.result_sequence).map((row) => row.result_ref);
    return {
      checkpointRevisionId: checkpoint.checkpoint_revision_id,
      revision: checkpoint.revision,
      stage: checkpoint.stage,
      publicSummary: checkpoint.public_summary,
      nextStep: checkpoint.next_step,
      referencedResultRefs: refs,
      originTurnId: checkpoint.origin_turn_id,
      createdAt: checkpoint.created_at,
    };
  }

  private hydrateReview(
    workId: string,
    review: GuidedWorkReviewRow,
  ): DurableWorkReview {
    const boundResultRefs = review.bound_result_sequence === null
      ? []
      : this.db.query<{ result_ref: string }, [string, number]>(`
          SELECT result_ref FROM btcc_guided_work_results
          WHERE work_id = ? AND sequence <= ? ORDER BY sequence
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
      boundResultRefs,
      originTurnId: review.origin_turn_id,
      createdAt: review.created_at,
    };
  }

  private results(workId: string): GuidedWorkResultRow[] {
    return this.db.query<GuidedWorkResultRow, [string]>(`
      SELECT result.result_ref, result.sequence, result.tool_call_id,
        call.tool_name, call.status, NULL AS result_json, call.result_sha256,
        call.error_code, result.origin_turn_id, result.attached_at
      FROM btcc_guided_work_results result
      JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
      WHERE result.work_id = ? ORDER BY result.sequence
    `).all(workId);
  }

  private contextResults(workId: string): GuidedWorkContextResultRow[] {
    return this.db.query<GuidedWorkContextResultRow, [string, number]>(`
      SELECT call.tool_name, call.status, call.result_json, call.error_code
      FROM btcc_guided_work_results result
      JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
      WHERE result.work_id = ?
      ORDER BY result.sequence DESC LIMIT ?
    `).all(workId, MAX_CONTEXT_RESULT_FACTS).reverse();
  }
}

function hydratePlan(row: GuidedWorkPlanRow): DurableWorkPlan {
  return {
    planRevisionId: row.plan_revision_id,
    revision: row.revision,
    objective: row.objective,
    actions: parseJson(row.actions_json),
    checks: parseJson(row.checks_json),
    originTurnId: row.origin_turn_id,
    createdAt: row.created_at,
  };
}

function hydrateResultRef(row: GuidedWorkResultRow): DurableWorkToolResultRef {
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
