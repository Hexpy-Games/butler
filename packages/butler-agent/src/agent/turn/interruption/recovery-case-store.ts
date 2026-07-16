import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureConversationStoreSchema } from "../../conversation/schema-migrations.ts";
import { conversationStorePath } from "../../conversation/store.ts";
import type {
  BtccTurnState,
  BtccTurnStateRecord,
  BtccReportingReceiptInput,
  RecoveryCaseV1,
  TurnInterruptionDirective,
} from "./turn-interruption-types.ts";
import {
  hydrateRecoveryCase,
  hydrateTurnState,
  type RecoveryCaseRow,
  type TurnStateRow,
} from "./recovery-case-store-rows.ts";
import {
  assertBtccInterruptionTransition,
  assertBtccReportingTransition,
} from "./btcc-interruption-transition.ts";

export class BtccRecoveryCaseStore {
  protected readonly db: Database;

  constructor(input: { butlerData: string; dbPath?: string }) {
    const path = input.dbPath ?? conversationStorePath(input.butlerData);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    ensureConversationStoreSchema(this.db);
    this.reconcileCancelledCoreTurns();
  }

  close(): void {
    this.db.close();
  }

  private reconcileCancelledCoreTurns(): void {
    const tornCancellation = this.db.query<{ present: number }, []>(`
      SELECT 1 AS present
      FROM conversation_turns
      JOIN btcc_turn_states
        ON btcc_turn_states.turn_id = conversation_turns.id
      WHERE btcc_turn_states.state = 'cancelled'
        AND btcc_turn_states.terminal_outcome_id IS NOT NULL
        AND (
          conversation_turns.status != 'aborted' OR
          conversation_turns.completed_at IS NULL OR
          EXISTS (
            SELECT 1
            FROM btcc_recovery_cases
            WHERE btcc_recovery_cases.turn_id = conversation_turns.id
              AND btcc_recovery_cases.status = 'open'
          )
        )
      LIMIT 1
    `).get();
    if (!tornCancellation) return;
    const tx = this.db.transaction(() => {
      this.db.query(`
        UPDATE btcc_recovery_cases
        SET status = 'resolved',
            wake_revision_ref = COALESCE(wake_revision_ref, (
              SELECT terminal_outcome_id
              FROM btcc_turn_states
              WHERE btcc_turn_states.turn_id = btcc_recovery_cases.turn_id
            )),
            updated_at = (
              SELECT updated_at
              FROM btcc_turn_states
              WHERE btcc_turn_states.turn_id = btcc_recovery_cases.turn_id
            )
        WHERE status = 'open'
          AND EXISTS (
            SELECT 1
            FROM btcc_turn_states
            WHERE btcc_turn_states.turn_id = btcc_recovery_cases.turn_id
              AND btcc_turn_states.state = 'cancelled'
          )
      `).run();
      this.db.query(`
        UPDATE conversation_turns
        SET status = 'aborted',
            completed_at = COALESCE(completed_at, (
              SELECT updated_at
              FROM btcc_turn_states
              WHERE btcc_turn_states.turn_id = conversation_turns.id
            ))
        WHERE EXISTS (
            SELECT 1
            FROM btcc_turn_states
            WHERE btcc_turn_states.turn_id = conversation_turns.id
              AND btcc_turn_states.state = 'cancelled'
              AND btcc_turn_states.terminal_outcome_id IS NOT NULL
          )
      `).run();
    });
    tx();
  }

  admitTurn(input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
    now?: string;
  }): BtccTurnStateRecord {
    const now = input.now ?? new Date().toISOString();
    const source = this.db.query<{ session_id: string }, [string]>(
      "SELECT session_id FROM conversation_turns WHERE id = ?",
    ).get(input.turnId);
    if (!source || source.session_id !== input.sessionId) {
      throw new Error("btcc_turn_conversation_binding_missing");
    }
    this.db.query(`
      INSERT OR IGNORE INTO btcc_turn_states (
        turn_id, session_id, attempt_id, state, generation,
        last_stable_checkpoint_ref, active_recovery_case_id,
        active_wait_owner_ref, active_wake_revision_ref, terminal_outcome_id,
        lifecycle_status, current_phase, phase_generation, row_version,
        project_policy_json, accepted_controls_ref,
        accepted_receipt_refs_json, invalidated_receipt_refs_json,
        last_stable_input_fingerprint, created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'accepted', 1, NULL, NULL, NULL, NULL, NULL,
        'active', 'conception', 1, 1, '{"kind":"unbound"}', ?, '[]', '[]', '', ?, ?
      )
    `).run(
      input.turnId,
      input.sessionId,
      input.attemptId,
      `controls:${input.turnId}`,
      now,
      now,
    );
    const state = this.requireTurnState(input.turnId);
    if (state.attemptId !== input.attemptId || state.sessionId !== input.sessionId) {
      throw new Error("btcc_turn_admission_identity_conflict");
    }
    return state;
  }

  readTurnState(turnId: string): BtccTurnStateRecord | null {
    const row = this.db.query<TurnStateRow, [string]>(
      "SELECT * FROM btcc_turn_states WHERE turn_id = ?",
    ).get(turnId);
    return row ? hydrateTurnState(row) : null;
  }

  readRecoveryCase(recoveryCaseId: string): RecoveryCaseV1 | null {
    const row = this.db.query<RecoveryCaseRow, [string]>(
      "SELECT * FROM btcc_recovery_cases WHERE recovery_case_id = ?",
    ).get(recoveryCaseId);
    return row ? hydrateRecoveryCase(row) : null;
  }

  applyDirective(directive: TurnInterruptionDirective): BtccTurnStateRecord {
    switch (directive.kind) {
      case "continue_same_turn":
        return this.transition(directive, "continuing");
      case "waiting_user":
        return this.transition(directive, "waiting_user", {
          waitOwnerRef: directive.ownerRef,
        });
      case "waiting_external":
        return this.transition(directive, "waiting_external", {
          waitOwnerRef: directive.ownerRef,
          wakeRevisionRef: directive.wakeRevisionRef,
        });
      case "waiting_runtime":
        return this.openRuntimeWait(directive);
      case "cancelled":
        return this.acceptCancellationDirective(directive);
    }
  }

  acceptReportingReceipt(input: BtccReportingReceiptInput): BtccTurnStateRecord {
    const before = this.requireTurnState(input.turnId);
    if (before.state === "delivered" &&
      before.terminalOutcomeId === input.reportingReceiptId) return before;
    if (before.attemptId !== input.attemptId) throw new Error("btcc_turn_attempt_mismatch");
    if (before.generation !== input.expectedGeneration) {
      throw new Error("btcc_turn_generation_conflict");
    }
    assertBtccReportingTransition(before.state);
    if (!input.reportingReceiptId.trim() || !input.publicMessageRef.trim()) {
      throw new Error("btcc_reporting_receipt_identity_missing");
    }
    const tx = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO btcc_reporting_receipts (
          reporting_receipt_id, turn_id, attempt_id, expected_generation,
          result_disposition, public_message_ref,
          completion_evidence_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.reportingReceiptId, input.turnId, input.attemptId,
        input.expectedGeneration, input.resultDisposition, input.publicMessageRef,
        JSON.stringify(uniqueRefs(input.completionEvidenceRefs)), input.createdAt,
      );
      const result = this.db.query(`
        UPDATE btcc_turn_states
        SET state = 'delivered', generation = generation + 1,
            lifecycle_status = 'delivered', row_version = row_version + 1,
            active_recovery_case_id = NULL, active_wait_owner_ref = NULL,
            active_wake_revision_ref = NULL,
            active_continuation_owner_ref = NULL, terminal_outcome_id = ?,
            updated_at = ?
        WHERE turn_id = ? AND attempt_id = ? AND generation = ?
      `).run(
        input.reportingReceiptId, input.createdAt, input.turnId,
        input.attemptId, input.expectedGeneration,
      );
      if (result.changes !== 1) throw new Error("btcc_reporting_receipt_cas_conflict");
      const next = this.requireTurnState(input.turnId);
      this.enqueueProjection(next, "turn.outcome", input.reportingReceiptId);
      return next;
    });
    return tx();
  }

  resolveRecoveryCase(input: {
    recoveryCaseId: string;
    observedWakeRevisionRef: string;
    now?: string;
  }): { changed: boolean; state: BtccTurnStateRecord; recoveryCase: RecoveryCaseV1 } {
    const before = this.requireRecoveryCase(input.recoveryCaseId);
    const state = this.requireTurnState(before.turnId);
    if (before.status === "resolved" || input.observedWakeRevisionRef === before.wakeRevisionRef) {
      return { changed: false, state, recoveryCase: before };
    }
    if (before.status !== "open") throw new Error("btcc_recovery_case_not_open");
    if (!input.observedWakeRevisionRef.trim()) {
      throw new Error("btcc_recovery_wake_revision_missing");
    }
    const now = input.now ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      const result = this.db.query(`
        UPDATE btcc_recovery_cases
        SET status = 'resolved', wake_revision_ref = ?, updated_at = ?
        WHERE recovery_case_id = ? AND status = 'open'
      `).run(input.observedWakeRevisionRef, now, input.recoveryCaseId);
      if (result.changes !== 1) throw new Error("btcc_recovery_case_cas_conflict");
      const turnResult = this.db.query(`
        UPDATE btcc_turn_states
        SET state = 'continuing', generation = generation + 1,
            lifecycle_status = 'active', row_version = row_version + 1,
            active_recovery_case_id = NULL, active_wait_owner_ref = NULL,
            active_wake_revision_ref = NULL,
            active_continuation_owner_ref = NULL, terminal_outcome_id = NULL,
            updated_at = ?
        WHERE turn_id = ? AND state = 'waiting_runtime'
          AND active_recovery_case_id = ?
      `).run(now, before.turnId, before.recoveryCaseId);
      if (turnResult.changes !== 1) throw new Error("btcc_recovery_turn_cas_conflict");
      const next = this.requireTurnState(before.turnId);
      this.enqueueProjection(next, "recovery.case.resolved", before.recoveryCaseId);
      this.enqueueProjection(next, "turn.state_changed", next.turnId);
      return {
        changed: true,
        state: next,
        recoveryCase: this.requireRecoveryCase(input.recoveryCaseId),
      };
    });
    return tx();
  }

  private openRuntimeWait(
    directive: Extract<TurnInterruptionDirective, { kind: "waiting_runtime" }>,
  ): BtccTurnStateRecord {
    const existing = this.db.query<RecoveryCaseRow, [string]>(
      "SELECT * FROM btcc_recovery_cases WHERE interruption_id = ?",
    ).get(directive.interruptionReceipt.interruptionId);
    if (existing) {
      const state = this.requireTurnState(directive.turnId);
      if (state.activeRecoveryCaseId !== existing.recovery_case_id) {
        throw new Error("btcc_recovery_replay_binding_conflict");
      }
      return state;
    }
    const tx = this.db.transaction(() => {
      this.insertInterruptionReceipt(directive);
      this.insertRecoveryCase(directive.recoveryCase);
      const state = this.transition(directive, "waiting_runtime", {
        recoveryCaseId: directive.recoveryCase.recoveryCaseId,
      });
      this.enqueueProjection(
        state,
        "runtime.interruption.recorded",
        directive.interruptionReceipt.interruptionId,
      );
      this.enqueueProjection(
        state,
        "recovery.case.opened",
        directive.recoveryCase.recoveryCaseId,
      );
      return state;
    });
    return tx();
  }

  private acceptCancellationDirective(
    directive: Extract<TurnInterruptionDirective, { kind: "cancelled" }>,
  ): BtccTurnStateRecord {
    const before = this.requireTurnState(directive.turnId);
    if (before.state === "cancelled" &&
      before.terminalOutcomeId === directive.cancellationReceiptRef) {
      const replayTx = this.db.transaction(() => {
        this.settleCancellation(directive);
        return this.requireTurnState(directive.turnId);
      });
      return replayTx();
    }
    const tx = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO btcc_cancellation_receipts (
          cancellation_receipt_id, turn_id, attempt_id,
          expected_generation, checkpoint_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        directive.cancellationReceiptRef, directive.turnId, directive.attemptId,
        directive.expectedGeneration, directive.checkpointRef, directive.createdAt,
      );
      const next = this.transition(directive, "cancelled", {
        terminalOutcomeId: directive.cancellationReceiptRef,
      });
      this.settleCancellation(directive);
      return next;
    });
    return tx();
  }

  private settleCancellation(
    directive: Extract<TurnInterruptionDirective, { kind: "cancelled" }>,
  ): void {
    this.db.query(`
      UPDATE btcc_recovery_cases
      SET status = 'resolved', wake_revision_ref = ?, updated_at = ?
      WHERE turn_id = ? AND status = 'open'
    `).run(
      directive.cancellationReceiptRef,
      directive.createdAt,
      directive.turnId,
    );
    this.db.query(`
      UPDATE conversation_turns
      SET status = 'aborted', completed_at = COALESCE(completed_at, ?)
      WHERE id = ? AND status IN ('accepted', 'running', 'aborted')
    `).run(directive.createdAt, directive.turnId);
    const coreTurn = this.db.query<{
      status: string;
      completed_at: string | null;
    }, [string]>(`
      SELECT status, completed_at
      FROM conversation_turns
      WHERE id = ?
    `).get(directive.turnId);
    if (!coreTurn || coreTurn.status !== "aborted" || !coreTurn.completed_at) {
      throw new Error("btcc_cancellation_core_turn_conflict");
    }
  }

  private transition(
    directive: TurnInterruptionDirective,
    state: BtccTurnState,
    refs: {
      recoveryCaseId?: string;
      waitOwnerRef?: string;
      wakeRevisionRef?: string;
      terminalOutcomeId?: string;
    } = {},
  ): BtccTurnStateRecord {
    const before = this.requireTurnState(directive.turnId);
    if (before.attemptId !== directive.attemptId) {
      throw new Error("btcc_turn_attempt_mismatch");
    }
    assertBtccInterruptionTransition(before.state, state);
    const now = new Date().toISOString();
    const result = this.db.query(`
      UPDATE btcc_turn_states
      SET state = ?, generation = generation + 1,
          lifecycle_status = ?, row_version = row_version + 1,
          last_stable_checkpoint_ref = ?, active_recovery_case_id = ?,
          active_wait_owner_ref = ?, active_wake_revision_ref = ?,
          active_continuation_owner_ref = NULL,
          terminal_outcome_id = ?, updated_at = ?
      WHERE turn_id = ? AND generation = ? AND attempt_id = ?
    `).run(
      state,
      lifecycleForTurnState(state),
      directive.checkpointRef,
      refs.recoveryCaseId ?? null,
      refs.waitOwnerRef ?? null,
      refs.wakeRevisionRef ?? null,
      refs.terminalOutcomeId ?? null,
      now,
      directive.turnId,
      directive.expectedGeneration,
      directive.attemptId,
    );
    if (result.changes !== 1) throw new Error("btcc_turn_generation_conflict");
    const next = this.requireTurnState(directive.turnId);
    this.enqueueProjection(next, "turn.state_changed", next.turnId);
    return next;
  }

  private insertInterruptionReceipt(
    directive: Extract<TurnInterruptionDirective, { kind: "waiting_runtime" }>,
  ): void {
    const receipt = directive.interruptionReceipt;
    this.db.query(`
      INSERT INTO btcc_interruption_receipts (
        interruption_id, turn_id, attempt_id, origin, diagnostic_code,
        last_stable_checkpoint_ref, pending_operation_ref, side_effect_state,
        resume_predicate_ref, wake_revision_ref, progress_fingerprint,
        diagnostic_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.interruptionId, receipt.turnId, receipt.attemptId, receipt.origin,
      receipt.diagnosticCode, receipt.lastStableCheckpointRef,
      receipt.pendingOperationRef ?? null, receipt.sideEffectState,
      receipt.resumePredicateRef, receipt.wakeRevisionRef ?? null,
      receipt.progressFingerprint, JSON.stringify(receipt.diagnosticRefs),
      receipt.createdAt,
    );
  }

  private insertRecoveryCase(recovery: RecoveryCaseV1): void {
    this.db.query(`
      INSERT INTO btcc_recovery_cases (
        recovery_case_id, turn_id, attempt_id, interruption_id, origin,
        diagnostic_code, last_stable_checkpoint_ref, pending_operation_ref,
        side_effect_state, owner, resume_predicate_ref, wake_revision_ref,
        progress_fingerprint, diagnostic_refs_json, public_status_id,
        available_control_refs_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recovery.recoveryCaseId, recovery.turnId, recovery.attemptId,
      recovery.interruptionId, recovery.origin, recovery.diagnosticCode,
      recovery.lastStableCheckpointRef, recovery.pendingOperationRef ?? null,
      recovery.sideEffectState, recovery.owner, recovery.resumePredicateRef,
      recovery.wakeRevisionRef ?? null, recovery.progressFingerprint,
      JSON.stringify(recovery.diagnosticRefs), recovery.publicStatusId,
      JSON.stringify(recovery.availableControlRefs), recovery.status,
      recovery.createdAt, recovery.createdAt,
    );
  }

  private requireTurnState(turnId: string): BtccTurnStateRecord {
    const state = this.readTurnState(turnId);
    if (!state) throw new Error("btcc_turn_state_missing");
    return state;
  }

  private requireRecoveryCase(recoveryCaseId: string): RecoveryCaseV1 {
    const recovery = this.readRecoveryCase(recoveryCaseId);
    if (!recovery) throw new Error("btcc_recovery_case_missing");
    return recovery;
  }

  private enqueueProjection(
    state: BtccTurnStateRecord,
    kind: string,
    payloadRef: string,
  ): void {
    const seq = this.db.query<{ seq: number }, [string]>(
      "SELECT seq FROM conversation_turns WHERE id = ?",
    ).get(state.turnId)?.seq ?? 0;
    const outboxId = `btcc-${stableHash({
      turnId: state.turnId,
      generation: state.generation,
      kind,
      payloadRef,
    }).slice(0, 24)}`;
    this.db.query(`
      INSERT OR IGNORE INTO conversation_projection_outbox (
        outbox_id, conversation_session_id, seq, kind, payload_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(outboxId, state.sessionId, seq, kind, payloadRef, state.updatedAt);
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))].slice(0, 64);
}

function lifecycleForTurnState(state: BtccTurnState): string {
  switch (state) {
    case "waiting_user":
    case "waiting_external":
    case "waiting_runtime":
    case "delivered":
    case "cancelled":
      return state;
    default:
      return "active";
  }
}
