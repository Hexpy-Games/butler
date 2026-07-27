import type { Database } from "bun:sqlite";
import type {
  ManagedProgramState,
  StopPersistenceOutcome,
} from "../../../btcc/gateway-api.ts";
import { ledgerManifestContentHash } from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";

type TurnControlRow = {
  semantic_state: string;
  revision: number;
  canonical_assistant_message_id: string | null;
  final_payload_json: string | null;
  session_id: string;
  context_json: string;
  route: string | null;
};

export type ManagedStopHydration = {
  program: ManagedProgramState;
  expectedRevision: number;
  expectedSemanticState: string;
};

export class ManagedStopPendingPromotionError extends Error {}

export class ManagedStopRevisionChangedError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super("Managed Stop Turn revision changed");
  }
}

export class SqliteStopController {
  constructor(private readonly db: Database) {}

  stop(
    turnId: string,
    hydration?: ManagedStopHydration,
  ): StopPersistenceOutcome {
    return this.db.transaction(() =>
      this.persistStop(turnId, hydration),
    )();
  }

  managedHydrationRequired(turnId: string): boolean {
    const turn = this.db.query<{
      semantic_state: string;
      route: string | null;
    }, [string]>(`
      SELECT semantic_state, route FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    return turn?.route === "managed" &&
      !isTerminalStopState(turn.semantic_state);
  }

  private persistStop(
    turnId: string,
    hydration?: ManagedStopHydration,
  ): StopPersistenceOutcome {
    const turn = this.db.query<TurnControlRow, [string]>(`
      SELECT semantic_state, revision, canonical_assistant_message_id, final_payload_json,
        session_id, context_json, route
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    const stopRequestId = digest(`btcc-stop-request.v1\0${turnId}`);
    if (!turn) {
      this.db.query(`
        INSERT OR IGNORE INTO btcc_stop_requests (
          stop_request_id, turn_id, status, observed_turn_revision, created_at, updated_at
        ) VALUES (?, ?, 'cancelled_before_admission', -1, datetime('now'), datetime('now'))
      `).run(stopRequestId, turnId);
      return { kind: "cancelled", turnId };
    }
    this.db.query(`
      INSERT OR IGNORE INTO btcc_stop_requests (
        stop_request_id, turn_id, status, observed_turn_revision, created_at, updated_at
      ) VALUES (?, ?, 'installed', ?, datetime('now'), datetime('now'))
    `).run(stopRequestId, turnId, turn.revision);

    if (turn.semantic_state === "delivered") {
      this.closeRequest(stopRequestId, "already_delivered", turn.revision);
      const payload = turn.final_payload_json ? JSON.parse(turn.final_payload_json) : null;
      if (!turn.canonical_assistant_message_id || typeof payload?.content !== "string") {
        throw new Error("Delivered BTCC Turn is missing its canonical payload");
      }
      return {
        kind: "already_delivered",
        turnId,
        messageId: turn.canonical_assistant_message_id,
        content: payload.content,
      };
    }
    if (turn.semantic_state === "cancelled") {
      this.closeRequest(stopRequestId, "already_cancelled", turn.revision);
      return { kind: "already_cancelled", turnId };
    }
    if (turn.semantic_state === "delivery_committed") {
      this.closeRequest(stopRequestId, "already_finalizing", turn.revision);
      return { kind: "already_finalizing", turnId };
    }

    if (turn.route === "managed") {
      if (!hydration?.program) {
        throw new Error("Managed Stop requires a canonically hydrated Program");
      }
      if (this.hasPendingProjectPromotion(turnId)) {
        throw new ManagedStopPendingPromotionError(
          "Managed Stop is gated by a pending Project promotion",
        );
      }
      if (turn.revision !== hydration.expectedRevision) {
        throw new ManagedStopRevisionChangedError(
          hydration.expectedRevision,
          turn.revision,
        );
      }
      if (turn.semantic_state !== hydration.expectedSemanticState) {
        throw new Error("Managed Stop semantic state changed without revision");
      }
    }
    const expectedRevision = hydration?.expectedRevision ?? turn.revision;
    const expectedState = hydration?.expectedSemanticState ?? turn.semantic_state;
    const cancelledRevision = expectedRevision + 1;
    const cancelled = this.db.query<{ turn_id: string }, [
      number,
      string,
      number,
      string,
    ]>(`
      UPDATE btcc_turns SET semantic_state = 'cancelled', active_checkpoint_id = NULL,
        revision = ?, execution_fence = execution_fence + 1,
        final_disposition = 'cancelled'
      WHERE turn_id = ? AND revision = ? AND semantic_state = ?
      RETURNING turn_id
    `).get(cancelledRevision, turnId, expectedRevision, expectedState);
    if (cancelled?.turn_id !== turnId) throw new Error("BTCC Stop lost its Turn CAS");
    this.preserveManagedContinuation(turnId, turn, hydration?.program);
    this.db.query(`
      UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL
      WHERE turn_id = ? AND is_active = 1
    `).run(turnId);
    this.db.query(`
      UPDATE btcc_state_claims SET status = 'revoked'
      WHERE turn_id = ? AND status = 'active'
    `).run(turnId);
    this.closeRequest(stopRequestId, "cancelled", cancelledRevision);
    return { kind: "cancelled", turnId };
  }

  private hasPendingProjectPromotion(turnId: string): boolean {
    return Boolean(this.db.query<{ outbox_id: string }, [string]>(`
      SELECT outbox_id FROM btcc_ledger_promotion_outbox
      WHERE turn_id = ? AND status = 'pending'
    `).get(turnId));
  }

  private preserveManagedContinuation(
    turnId: string,
    turn: TurnControlRow,
    program?: ManagedProgramState,
  ): void {
    if (turn.route !== "managed") return;
    if (!program || program.planningState !== "reviewed" ||
      program.frontier === "closed" || program.frontier === "cancelled") return;
    const unfinished = program.tasks.filter((task) => task.status !== "accepted");
    if (unfinished.length === 0) return;
    const interrupted = unfinished.find((task) =>
      task.status === "selected" || task.status === "result_submitted" ||
      task.status === "review_failed");
    const pending = unfinished.filter((task) => task !== interrupted);
    const completed = program.tasks.filter((task) => task.status === "accepted");
    const context = JSON.parse(turn.context_json) as { projectRef?: string };
    const scopeKind = context.projectRef ? "project" : "session";
    const scopeId = context.projectRef ?? turn.session_id;
    const blockerBody = {
      kind: "user_stopped" as const,
      sourceTurnId: turnId,
      sourceState: turn.semantic_state,
      reason: "The owning Turn was stopped by the user.",
      readiness: { kind: "fresh_turn_user_intent" as const },
    };
    const blockerRef = recordRef("stopped-program-blocker", blockerBody);
    const anchorBody = {
      kind: "user_stopped_program" as const,
      sourceTurnId: turnId,
      programId: program.programId,
      blockerRef,
      completedTaskRefs: completed.map((task) => task.task.ref),
      ...(interrupted ? { interruptedTaskRef: interrupted.task.ref } : {}),
      pendingTaskRefs: pending.map((task) => task.task.ref),
      openWorkRefs: program.works
        .filter((work) => work.status !== "closed")
        .map((work) => work.work.ref),
    };
    const anchorRef = recordRef("stopped-program-anchor", anchorBody);
    const baseManifestHash = ledgerManifestContentHash(program, {
      ledgerId: program.ledgerId,
      programId: program.programId,
    });
    const candidateIdentity = {
      continuationKind: "user_stopped" as const,
      ledgerId: program.ledgerId,
      programId: program.programId,
      expectedManifestRevision: program.manifestRevision,
      baseManifestHash,
      sourceTurnId: turnId,
      originalGoalContractRef: program.goalContractRef,
      anchorRef,
      blockerRef,
    };
    const candidateId = digest(
      `btcc-continuation-candidate.v1\0${stableJson(candidateIdentity)}`,
    );
    this.insertRecord(blockerRef, "user_stopped_program_blocker", blockerBody);
    this.insertRecord(anchorRef, "user_stopped_program_anchor", anchorBody);
    const candidateContext = {
      originalGoalContract: this.loadRecord(program.goalContractRef.id),
      acceptedPlan: program.acceptedPlan,
      blocker: {
        sourceState: turn.semantic_state,
        reason: blockerBody.reason,
        readiness: blockerBody.readiness,
      },
      frontier: {
        currentWorkRef: program.currentWork.work.ref,
        ...(interrupted ? { currentTaskRef: interrupted.task.ref } : {}),
        openWorkRefs: anchorBody.openWorkRefs,
        openTaskRefs: unfinished.map((task) => task.task.ref),
        completedTasks: completed.map((task) => continuationTask(task, "reviewed_passed")),
        ...(interrupted
          ? { interruptedTask: continuationTask(interrupted, "interrupted") }
          : {}),
        pendingTasks: pending.map((task) => continuationTask(task, "pending")),
      },
    };
    this.db.query(`
      INSERT OR IGNORE INTO btcc_stopped_program_continuations (
        candidate_id, anchor_id, anchor_sha256, blocker_id, blocker_sha256, source_turn_id,
        session_id, scope_kind, scope_id, ledger_id, program_id,
        expected_manifest_revision, base_manifest_hash, goal_contract_ref,
        context_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eligible')
    `).run(
      candidateId,
      anchorRef.id,
      anchorRef.sha256,
      blockerRef.id,
      blockerRef.sha256,
      turnId,
      turn.session_id,
      scopeKind,
      scopeId,
      program.ledgerId,
      program.programId,
      program.manifestRevision,
      baseManifestHash,
      program.goalContractRef.id,
      stableJson(candidateContext),
    );
  }

  private insertRecord(
    ref: { id: string; sha256: string },
    kind: string,
    body: unknown,
  ): void {
    this.db.query(`
      INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
      VALUES (?, ?, ?, ?)
    `).run(ref.id, kind, ref.sha256, stableJson(body));
  }

  private loadRecord(id: string): Record<string, unknown> | null {
    const row = this.db.query<{ content_json: string }, [string]>(
      "SELECT content_json FROM btcc_records WHERE record_id = ?",
    ).get(id);
    return row ? JSON.parse(row.content_json) : null;
  }

  private closeRequest(id: string, status: string, turnRevision: number): void {
    this.db.query(`
      UPDATE btcc_stop_requests SET status = ?, observed_turn_revision = ?,
        updated_at = datetime('now') WHERE stop_request_id = ?
    `).run(status, turnRevision, id);
  }
}

function isTerminalStopState(state: string): boolean {
  return state === "delivered" || state === "cancelled" ||
    state === "delivery_committed";
}

function recordRef(kind: string, body: unknown) {
  const bytes = stableJson(body);
  return {
    id: digest(`btcc-${kind}.v1\0${bytes}`),
    sha256: digest(bytes),
  };
}

function continuationTask(
  state: Extract<ManagedProgramState, { planningState: "reviewed" }>["tasks"][number],
  status: "reviewed_passed" | "interrupted" | "pending",
) {
  return {
    task: state.task,
    status,
    dependencyTaskRefs: state.task.dependencyTaskRefs,
    ...(state.currentResult ? { resultRef: state.currentResult.result.ref } : {}),
    ...(state.currentReview ? { reviewRef: state.currentReview.review.ref } : {}),
  };
}
