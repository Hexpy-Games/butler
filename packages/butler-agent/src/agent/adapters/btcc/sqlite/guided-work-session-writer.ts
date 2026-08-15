import type { Database } from "bun:sqlite";
import type {
  ContinueWorkCommand,
  ReplaceWorkPlanCommand,
  StartWorkCommand,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type { GuidedWorkRow, GuidedWorkTurn } from "./guided-work-records.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { guidedWorkMatchesScope } from "./guided-work-scope.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

export class GuidedWorkSessionWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
  ) {}

  start(input: StartWorkCommand): GuidedWorkRow {
    const replay = this.replayRelation(
      input.mutationCallId,
      "start_work",
      input.requestSha256,
    );
    if (replay) return replay;
    const turn = this.reader.relationTurn(input);
    const bound = this.reader.boundWork(input.turnId);
    if (bound) {
      throw new Error("Durable Work relation is already selected for this Turn");
    }
    const head = this.reader.sessionHead(input.sessionId);
    if (head?.status === "open" || head?.status === "blocked") {
      this.abandon(head.work_id);
    }
    const work = this.createAndBind(input, turn);
    this.recordRelation(
      input.mutationCallId,
      "start_work",
      input.requestSha256,
      work.work_id,
    );
    return work;
  }

  continue(input: ContinueWorkCommand): GuidedWorkRow {
    const replay = this.replayRelation(
      input.mutationCallId,
      "continue_work",
      input.requestSha256,
    );
    if (replay) return replay;
    const turn = this.reader.relationTurn(input);
    const bound = this.reader.boundWork(input.turnId);
    if (bound) {
      const head = this.reader.sessionHead(input.sessionId);
      if (bound.work_id !== input.workId) {
        throw new Error("Durable Work relation is already selected for another Work");
      }
      if (!head || head.work_id !== bound.work_id || !isOpenWork(bound) ||
        !guidedWorkMatchesScope(bound, input)) {
        throw new Error("Durable Work continuation target is not the current open Work");
      }
      this.recordRelation(
        input.mutationCallId,
        "continue_work",
        input.requestSha256,
        bound.work_id,
      );
      return bound;
    }
    const head = this.reader.sessionHead(input.sessionId);
    if (!head || head.work_id !== input.workId || !isOpenWork(head) ||
      !guidedWorkMatchesScope(head, input)) {
      throw new Error("Durable Work continuation target is not the current open Work");
    }
    this.bind(turn, head.work_id);
    this.recordRelation(
      input.mutationCallId,
      "continue_work",
      input.requestSha256,
      head.work_id,
    );
    return head;
  }

  selectForPlan(input: ReplaceWorkPlanCommand): GuidedWorkRow {
    const turn = this.reader.relationTurn(input);
    const bound = this.reader.boundWork(input.turnId);
    const head = this.reader.sessionHead(input.sessionId);
    if (input.startNew && bound) {
      if (this.turnCommittedToWork(input.turnId, bound.work_id)) {
        throw new Error(
          "Durable Work continuation is already committed for this Turn; continue the current Work or start new Work in a fresh Turn",
        );
      }
      throw new Error(
        "Durable Work relation is already selected for this Turn; startNew cannot switch Work; continue the current Work or start new Work in a fresh Turn",
      );
    }
    if (bound && !isOpenWork(bound)) {
      throw new Error(
        "Durable Work relation is already selected for a terminal Work; start new Work in a fresh Turn",
      );
    }
    if (bound && head && bound.work_id !== head.work_id) {
      throw new Error("Durable Work Turn binding is no longer the Session head");
    }
    const current = bound ?? head;
    if (current && !input.startNew && !guidedWorkMatchesScope(current, input)) {
      throw new Error("Durable Work scope changed; startNew is required");
    }
    if (input.startNew) {
      if (current?.status === "open" || current?.status === "blocked") {
        this.abandon(current.work_id);
      }
      const work = this.createAndBind(input, turn);
      this.recordRelation(
        input.mutationCallId,
        "start_work",
        input.requestSha256,
        work.work_id,
      );
      return work;
    }
    if (current?.status === "open" || current?.status === "blocked") {
      const wasBound = Boolean(bound);
      this.bind(turn, current.work_id);
      if (!wasBound) {
        this.recordRelation(
          input.mutationCallId,
          "continue_work",
          input.requestSha256,
          current.work_id,
        );
      }
      return current;
    }
    const work = this.createAndBind(input, turn);
    this.recordRelation(
      input.mutationCallId,
      "start_work",
      input.requestSha256,
      work.work_id,
    );
    return work;
  }

  private turnCommittedToWork(turnId: string, workId: string): boolean {
    return Boolean(this.db.query<{ committed: number }, [string, string]>(`
      SELECT 1 AS committed FROM (
        SELECT work_id, origin_turn_id
        FROM btcc_guided_work_plan_revisions
        UNION ALL
        SELECT work_id, origin_turn_id
        FROM btcc_guided_work_checkpoint_revisions
        UNION ALL
        SELECT work_id, origin_turn_id
        FROM btcc_guided_work_review_revisions
        UNION ALL
        SELECT work_id, origin_turn_id
        FROM btcc_guided_work_results
      ) progress
      WHERE progress.work_id = ? AND progress.origin_turn_id = ?
      LIMIT 1
    `).get(workId, turnId));
  }

  requireBoundHead(scope: WorkTurnScope): GuidedWorkRow {
    return this.requireBound(scope, false);
  }

  requireBoundForResult(scope: WorkTurnScope): GuidedWorkRow {
    return this.requireBound(scope, true);
  }

  requireBoundForDisposition(scope: WorkTurnScope): GuidedWorkRow {
    return this.requireBound(scope, false);
  }

  /**
   * Closeout diagnostics are bookkeeping only.  They still require the
   * admitted/current relation and Stop fence, but must remain appendable when
   * a legacy review/import left a bound Work terminal before disposition was
   * introduced.
   */
  requireBoundForCloseoutDiagnostic(scope: WorkTurnScope): GuidedWorkRow {
    return this.requireBound(scope, true);
  }

  private requireBound(
    scope: WorkTurnScope,
    allowCompleted: boolean,
  ): GuidedWorkRow {
    // A bound relation is still subject to the current Turn admission and
    // execution fence.  Reads may inspect a stopped Turn, but no checkpoint,
    // review, result attachment, or status mutation may be accepted after the
    // Stop CAS moves its fence.
    this.reader.relationTurn(scope);
    const bound = this.reader.boundWork(scope.turnId);
    if (!bound) {
      throw new Error(`Durable Work is not bound to Turn: ${scope.turnId}`);
    }
    const head = this.reader.sessionHead(scope.sessionId);
    if (!head || head.work_id !== bound.work_id) {
      throw new Error("Durable Work Turn binding is no longer the Session head");
    }
    if (
      bound.status !== "open" &&
      bound.status !== "blocked" &&
      !(allowCompleted && bound.status === "completed")
    ) {
      throw new Error(`Durable Work is not open: ${bound.work_id}`);
    }
    if (!guidedWorkMatchesScope(bound, scope)) {
      throw new Error("Durable Work Turn scope does not match its bound Work");
    }
    return bound;
  }

  private createAndBind(
    input: Pick<ReplaceWorkPlanCommand, "turnId" | "sessionId" | "projectRef" |
      "mutationCallId" | "objective">,
    turn: GuidedWorkTurn,
  ): GuidedWorkRow {
    const workId = guidedWorkRecordId("work", input.mutationCallId);
    const now = new Date().toISOString();
    const scopeKind = input.projectRef ? "project" : "session";
    const scopeRef = input.projectRef ?? input.sessionId;
    this.db.query(`
      INSERT INTO btcc_guided_works (
        work_id, session_id, scope_kind, scope_ref, origin_turn_id,
        origin_message_id, objective, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      workId,
      input.sessionId,
      scopeKind,
      scopeRef,
      input.turnId,
      turn.original_message_id,
      input.objective,
      now,
      now,
    );
    this.db.query(`
      INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        work_id = excluded.work_id,
        updated_at = excluded.updated_at
    `).run(input.sessionId, workId, now);
    this.bind(turn, workId);
    return this.reader.sessionHead(input.sessionId)!;
  }

  private replayRelation(
    mutationCallId: string,
    operation: "start_work" | "continue_work",
    requestSha256: string,
  ): GuidedWorkRow | null {
    const row = this.db.query<{
      operation: string;
      request_sha256: string;
      work_id: string;
    }, [string]>(`
      SELECT operation, request_sha256, work_id
      FROM btcc_guided_work_relation_commands WHERE mutation_call_id = ?
    `).get(mutationCallId);
    if (!row) return null;
    if (row.operation !== operation || row.request_sha256 !== requestSha256) {
      throw new Error(`Durable Work relation identity conflict: ${mutationCallId}`);
    }
    return this.db.query<GuidedWorkRow, [string]>(
      "SELECT * FROM btcc_guided_works WHERE work_id = ?",
    ).get(row.work_id) ?? null;
  }

  private recordRelation(
    mutationCallId: string,
    operation: "start_work" | "continue_work",
    requestSha256: string,
    workId: string,
  ): void {
    this.db.query(`
      INSERT INTO btcc_guided_work_relation_commands (
        mutation_call_id, operation, request_sha256, work_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      mutationCallId,
      operation,
      requestSha256,
      workId,
      new Date().toISOString(),
    );
  }

  private abandon(workId: string): void {
    const updated = this.db.query(`
      UPDATE btcc_guided_works SET status = 'abandoned', updated_at = ?
      WHERE work_id = ? AND status IN ('open', 'blocked')
    `).run(new Date().toISOString(), workId);
    if (updated.changes !== 1) {
      throw new Error(`Durable Work could not be abandoned: ${workId}`);
    }
  }

  private bind(turn: GuidedWorkTurn, workId: string): void {
    const current = this.db.query<{ work_id: string }, [string]>(`
      SELECT work_id FROM btcc_guided_turn_work_bindings
      WHERE turn_id = ? AND is_current = 1
    `).get(turn.turn_id);
    if (current?.work_id === workId) return;
    const revision = this.db.query<{ revision: number }, [string]>(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM btcc_guided_turn_work_bindings WHERE turn_id = ?
    `).get(turn.turn_id)?.revision ?? 1;
    this.db.query(`
      UPDATE btcc_guided_turn_work_bindings SET is_current = 0
      WHERE turn_id = ? AND is_current = 1
    `).run(turn.turn_id);
    this.db.query(`
      INSERT INTO btcc_guided_turn_work_bindings (
        binding_revision_id, turn_id, session_id, work_id,
        revision, is_current, bound_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      guidedWorkRecordId("binding", `${turn.turn_id}\0${revision}\0${workId}`),
      turn.turn_id,
      turn.session_id,
      workId,
      revision,
      new Date().toISOString(),
    );
  }
}

function isOpenWork(work: GuidedWorkRow): boolean {
  return work.status === "open" || work.status === "blocked";
}
