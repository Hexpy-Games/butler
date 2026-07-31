import type { Database } from "bun:sqlite";
import type {
  ReplaceWorkPlanCommand,
  WorkTurnScope,
} from "../../../btcc/durable-work/index.ts";
import type { GuidedWorkRow, GuidedWorkTurn } from "./guided-work-records.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { guidedWorkMatchesScope } from "./guided-work-scope.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

export class GuidedWorkSessionWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
  ) {}

  selectForPlan(input: ReplaceWorkPlanCommand): GuidedWorkRow {
    const turn = this.reader.turn(input);
    const bound = this.reader.boundWork(input.turnId);
    const head = this.reader.sessionHead(input.sessionId);
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
      return this.createAndBind(input, turn);
    }
    if (current?.status === "open" || current?.status === "blocked") {
      this.bind(turn, current.work_id);
      return current;
    }
    return this.createAndBind(input, turn);
  }

  bindOpenHead(
    scope: WorkTurnScope,
    expectedWorkId?: string,
  ): GuidedWorkRow | null {
    const turn = this.reader.turn(scope);
    const bound = this.reader.boundWork(scope.turnId);
    const head = this.reader.sessionHead(scope.sessionId);
    if (expectedWorkId && bound?.work_id !== expectedWorkId &&
      head?.work_id !== expectedWorkId) {
      return null;
    }
    if (bound) {
      if (expectedWorkId && bound.work_id !== expectedWorkId) return null;
      if (!head || bound.work_id !== head.work_id) {
        throw new Error("Durable Work Turn binding is no longer the Session head");
      }
      if (!guidedWorkMatchesScope(bound, scope)) {
        throw new Error("Durable Work Turn scope does not match its bound Work");
      }
      return bound.status === "open" || bound.status === "blocked" ? bound : null;
    }
    if (!head || (head.status !== "open" && head.status !== "blocked")) return null;
    if (expectedWorkId && head.work_id !== expectedWorkId) return null;
    if (!guidedWorkMatchesScope(head, scope)) return null;
    this.bind(turn, head.work_id);
    return head;
  }

  requireBoundHead(scope: WorkTurnScope): GuidedWorkRow {
    return this.requireBound(scope, false);
  }

  requireBoundForResult(scope: WorkTurnScope): GuidedWorkRow {
    return this.requireBound(scope, true);
  }

  private requireBound(
    scope: WorkTurnScope,
    allowCompleted: boolean,
  ): GuidedWorkRow {
    this.reader.turn(scope);
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
    input: ReplaceWorkPlanCommand,
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
