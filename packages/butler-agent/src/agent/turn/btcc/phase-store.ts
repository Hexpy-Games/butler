import { createHash } from "node:crypto";
import { BtccRecoveryCaseStore } from "../interruption/recovery-case-store.ts";
import {
  BTCC_CONCEPTION_CHECKPOINT_SCHEMA,
  BTCC_GOAL_CONTRACT_SCHEMA,
  BTCC_PHASE_ARTIFACT_SCHEMA,
  BTCC_PHASES,
  BTCC_PHASE_RECEIPT_SCHEMA,
  BTCC_PHASE_STATE_SCHEMA,
  BTCC_RETURN_TICKET_SCHEMA,
  type BtccDependencyAuthority,
  type BtccPhase,
  type BtccPhaseArtifactKind,
  type BtccPhaseArtifactV1,
  type BtccPhaseLifecycleStatus,
  type BtccPhaseStateV1,
  type ConceptionCheckpointV1,
  type GoalContractV1,
  type PhaseReceiptV1,
  type ProjectPolicy,
  type ReturnTicketV1,
  type TrackingPolicy,
} from "./phase-types.ts";
import {
  assertBtccPhaseReceiptTransition,
  invalidatedPhasesForAuthority,
  phaseAndLifecycleForReceipt,
} from "./phase-transition.ts";

interface BtccPhaseStateRow {
  turn_id: string;
  session_id: string;
  attempt_id: string;
  lifecycle_status: BtccPhaseLifecycleStatus;
  current_phase: BtccPhase;
  phase_generation: number;
  row_version: number;
  project_policy_json: string;
  tracking_policy_candidate_json: string | null;
  tracking_policy_json: string | null;
  accepted_controls_ref: string;
  goal_contract_ref: string | null;
  active_conception_checkpoint_ref: string | null;
  active_planning_checkpoint_ref: string | null;
  active_execution_checkpoint_ref: string | null;
  active_review_checkpoint_ref: string | null;
  active_consolidation_checkpoint_ref: string | null;
  active_reporting_checkpoint_ref: string | null;
  active_consolidation_target_ref: string | null;
  active_final_dossier_ref: string | null;
  active_tracking_attempt_ref: string | null;
  active_execution_operation_ref: string | null;
  active_review_target_ref: string | null;
  open_tool_call_ref: string | null;
  plan_revision_ref: string | null;
  active_tracking_work_ref: string | null;
  active_task_ref: string | null;
  active_return_ticket_ref: string | null;
  pending_closeout_ref: string | null;
  active_continuation_owner_ref: string | null;
  accepted_receipt_refs_json: string;
  invalidated_receipt_refs_json: string;
  last_stable_input_fingerprint: string;
  updated_at: string;
}

export interface BtccPhaseStateRefsPatch {
  activeConceptionCheckpointRef?: string | null;
  activePlanningCheckpointRef?: string | null;
  activeExecutionCheckpointRef?: string | null;
  activeReviewCheckpointRef?: string | null;
  activeConsolidationCheckpointRef?: string | null;
  activeReportingCheckpointRef?: string | null;
  activeConsolidationTargetRef?: string | null;
  activeFinalDossierRef?: string | null;
  activeTrackingAttemptRef?: string | null;
  activeExecutionOperationRef?: string | null;
  activeReviewTargetRef?: string | null;
  openToolCallRef?: string | null;
  planRevisionRef?: string | null;
  activeTrackingWorkRef?: string | null;
  activeTaskRef?: string | null;
  activeReturnTicketRef?: string | null;
  pendingCloseoutRef?: string | null;
}

export interface BtccPhaseCommitInput {
  expectedRowVersion: number;
  receipt: PhaseReceiptV1;
  artifacts: BtccPhaseArtifactV1[];
  conceptionCheckpoint?: ConceptionCheckpointV1;
  goalContract?: GoalContractV1;
  trackingPolicyCandidate?: TrackingPolicy;
  trackingPolicy?: TrackingPolicy;
  refs?: BtccPhaseStateRefsPatch;
  returnTicket?: {
    ticket: ReturnTicketV1;
    invalidatesAuthority: BtccDependencyAuthority;
  };
  waitOwnerRef?: string;
  wakeRevisionRef?: string;
}

export class BtccPhaseStore extends BtccRecoveryCaseStore {
  admitPhaseTurn(input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
    projectPolicy: ProjectPolicy;
    acceptedControlsRef: string;
    inputFingerprint: string;
    now?: string;
  }): BtccPhaseStateV1 {
    assertProjectPolicy(input.projectPolicy);
    assertNonEmpty(input.acceptedControlsRef, "btcc_accepted_controls_ref_missing");
    assertNonEmpty(input.inputFingerprint, "btcc_phase_input_fingerprint_missing");
    super.admitTurn(input);
    const before = this.requirePhaseState(input.turnId);
    const defaultControlsRef = `controls:${input.turnId}`;
    const desiredPolicy = stableJson(input.projectPolicy);
    if (
      stableJson(before.projectPolicy) === desiredPolicy &&
      before.acceptedControlsRef === input.acceptedControlsRef &&
      before.lastStableInputFingerprint === input.inputFingerprint
    ) {
      return before;
    }
    if (
      before.currentPhase !== "conception" ||
      before.acceptedReceiptRefs.length > 0 ||
      (before.acceptedControlsRef !== defaultControlsRef &&
        before.acceptedControlsRef !== input.acceptedControlsRef)
    ) {
      throw new Error("btcc_phase_admission_identity_conflict");
    }
    const now = input.now ?? new Date().toISOString();
    const result = this.db.query(`
      UPDATE btcc_turn_states
      SET project_policy_json = ?, accepted_controls_ref = ?,
          last_stable_input_fingerprint = ?, row_version = row_version + 1,
          updated_at = ?
      WHERE turn_id = ? AND attempt_id = ? AND row_version = ?
    `).run(
      desiredPolicy,
      input.acceptedControlsRef,
      input.inputFingerprint,
      now,
      input.turnId,
      input.attemptId,
      before.rowVersion,
    );
    if (result.changes !== 1) throw new Error("btcc_phase_state_cas_conflict");
    const next = this.requirePhaseState(input.turnId);
    this.enqueuePhaseProjection(next, "btcc.phase.admitted", next.turnId);
    return next;
  }

  readPhaseState(turnId: string): BtccPhaseStateV1 | null {
    const row = this.db.query<BtccPhaseStateRow, [string]>(`
      SELECT * FROM btcc_turn_states WHERE turn_id = ?
    `).get(turnId);
    return row ? hydratePhaseState(row) : null;
  }

  commitConceptionCheckpoint(input: {
    expectedRowVersion: number;
    checkpoint: ConceptionCheckpointV1;
    now?: string;
  }): BtccPhaseStateV1 {
    const state = this.requirePhaseState(input.checkpoint.turnRef);
    const existing = this.db.query<{ content_hash: string }, [string]>(`
      SELECT content_hash FROM btcc_conception_checkpoints WHERE checkpoint_ref = ?
    `).get(input.checkpoint.checkpointRef);
    if (existing) {
      if (
        existing.content_hash !== hashBtccPayload(input.checkpoint) ||
        state.activeConceptionCheckpointRef !== input.checkpoint.checkpointRef
      ) {
        throw new Error("btcc_conception_checkpoint_replay_conflict");
      }
      return state;
    }
    assertConceptionCheckpoint(input.checkpoint, state);
    assertActiveVersion(state, input.expectedRowVersion);
    const now = input.now ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.insertConceptionCheckpoint(input.checkpoint, now);
      const result = this.db.query(`
        UPDATE btcc_turn_states
        SET active_conception_checkpoint_ref = ?,
            last_stable_input_fingerprint = ?, row_version = row_version + 1,
            updated_at = ?
        WHERE turn_id = ? AND attempt_id = ? AND current_phase = 'conception'
          AND lifecycle_status = 'active' AND row_version = ?
      `).run(
        input.checkpoint.checkpointRef,
        input.checkpoint.lastInputFingerprint,
        now,
        state.turnId,
        state.attemptId,
        input.expectedRowVersion,
      );
      if (result.changes !== 1) throw new Error("btcc_phase_state_cas_conflict");
      const next = this.requirePhaseState(state.turnId);
      this.enqueuePhaseProjection(
        next,
        "btcc.conception.checkpointed",
        input.checkpoint.checkpointRef,
      );
      return next;
    });
    return tx();
  }

  commitPhase(input: BtccPhaseCommitInput): BtccPhaseStateV1 {
    const before = this.requirePhaseState(input.receipt.turnId);
    const existingReceipt = this.db.query<{ content_hash: string }, [string]>(`
      SELECT content_hash FROM btcc_phase_receipts WHERE receipt_id = ?
    `).get(input.receipt.receiptId);
    if (existingReceipt) {
      if (
        existingReceipt.content_hash !== hashBtccPayload(input.receipt) ||
        !before.acceptedReceiptRefs.includes(input.receipt.receiptId)
      ) {
        throw new Error("btcc_phase_receipt_replay_conflict");
      }
      return before;
    }
    assertActiveVersion(before, input.expectedRowVersion);
    assertBtccPhaseReceiptTransition(before, input.receipt);
    this.assertCommitIdentity(input, before);
    const transition = phaseAndLifecycleForReceipt(
      before.currentPhase,
      input.receipt.nextState,
    );
    if (transition.lifecycle === "waiting_runtime") {
      throw new Error("btcc_runtime_wait_requires_recovery_case");
    }
    assertWaitIdentity(transition.lifecycle, input);
    const tx = this.db.transaction(() => {
      for (const artifact of input.artifacts) this.insertArtifact(artifact);
      if (input.conceptionCheckpoint) {
        this.insertConceptionCheckpoint(
          input.conceptionCheckpoint,
          input.receipt.createdAt,
        );
      }
      if (input.goalContract) {
        this.insertGoalContract(input.goalContract, input.receipt.createdAt);
      }
      this.assertReceiptDependencies(before, input.receipt);
      this.assertReceiptOutputsExist(input.receipt);
      this.insertPhaseReceipt(input.receipt);

      const invalidatedRefs = input.returnTicket
        ? this.findAcceptedReceiptRefsForPhases(
          before,
          invalidatedPhasesForAuthority(input.returnTicket.invalidatesAuthority),
        )
        : [];
      const invalidated = uniqueRefs([
        ...before.invalidatedReceiptRefs,
        ...invalidatedRefs,
      ]);
      const invalidatedSet = new Set(invalidated);
      const accepted = uniqueRefs([
        ...before.acceptedReceiptRefs.filter((ref) => !invalidatedSet.has(ref)),
        input.receipt.receiptId,
      ]);
      const phaseGeneration = transition.phaseChanged
        ? before.phaseGeneration + 1
        : before.phaseGeneration;
      const refs = deriveRefs(
        clearRefsForReturnTicket(mergeRefs(before, input.refs), input.returnTicket?.ticket),
        input.artifacts,
      );
      this.assertCanonicalRefs(before, refs);
      const activeReturnTicketRef = this.resolveActiveReturnTicketRef(
        before,
        input,
        refs.activeReturnTicketRef,
      );
      const compatibilityState = compatibilityStateForLifecycle(
        transition.lifecycle,
      );
      const result = this.db.query(`
        UPDATE btcc_turn_states
        SET state = ?, lifecycle_status = ?, current_phase = ?,
            phase_generation = ?, row_version = row_version + 1,
            tracking_policy_candidate_json = ?, tracking_policy_json = ?,
            goal_contract_ref = ?, active_conception_checkpoint_ref = ?,
            active_planning_checkpoint_ref = ?, active_execution_checkpoint_ref = ?,
            active_review_checkpoint_ref = ?, active_consolidation_checkpoint_ref = ?,
            active_reporting_checkpoint_ref = ?, active_consolidation_target_ref = ?,
            active_final_dossier_ref = ?, active_tracking_attempt_ref = ?,
            active_execution_operation_ref = ?, active_review_target_ref = ?,
            open_tool_call_ref = ?, plan_revision_ref = ?, active_tracking_work_ref = ?,
            active_task_ref = ?, active_return_ticket_ref = ?, pending_closeout_ref = ?,
            active_wait_owner_ref = ?, active_wake_revision_ref = ?,
            active_continuation_owner_ref = ?,
            accepted_receipt_refs_json = ?, invalidated_receipt_refs_json = ?,
            last_stable_input_fingerprint = ?, updated_at = ?
        WHERE turn_id = ? AND attempt_id = ? AND current_phase = ?
          AND phase_generation = ? AND lifecycle_status = 'active'
          AND row_version = ?
      `).run(
        compatibilityState,
        transition.lifecycle,
        transition.phase,
        phaseGeneration,
        jsonOrNull(
          input.trackingPolicyCandidate ??
          (input.returnTicket?.ticket.ownerPhase === "conception"
            ? undefined
            : before.trackingPolicyCandidate),
        ),
        jsonOrNull(
          input.trackingPolicy ??
          (input.returnTicket?.ticket.ownerPhase === "conception" ||
            input.returnTicket?.ticket.ownerPhase === "planning"
            ? undefined
            : before.trackingPolicy),
        ),
        input.goalContract?.goalContractRef ??
          (input.returnTicket?.ticket.ownerPhase === "conception"
            ? null
            : before.goalContractRef ?? null),
        input.conceptionCheckpoint?.checkpointRef ?? refs.activeConceptionCheckpointRef,
        refs.activePlanningCheckpointRef,
        refs.activeExecutionCheckpointRef,
        refs.activeReviewCheckpointRef,
        refs.activeConsolidationCheckpointRef,
        refs.activeReportingCheckpointRef,
        refs.activeConsolidationTargetRef,
        refs.activeFinalDossierRef,
        refs.activeTrackingAttemptRef,
        refs.activeExecutionOperationRef,
        refs.activeReviewTargetRef,
        refs.openToolCallRef,
        refs.planRevisionRef,
        refs.activeTrackingWorkRef,
        refs.activeTaskRef,
        activeReturnTicketRef,
        refs.pendingCloseoutRef,
        transition.lifecycle === "waiting_user" ||
          transition.lifecycle === "waiting_external"
          ? input.waitOwnerRef ?? null
          : null,
        transition.lifecycle === "waiting_external"
          ? input.wakeRevisionRef ?? null
          : null,
        transition.lifecycle === "scheduled_continuation"
          ? input.waitOwnerRef ?? null
          : null,
        JSON.stringify(accepted),
        JSON.stringify(invalidated),
        input.receipt.inputFingerprint,
        input.receipt.createdAt,
        before.turnId,
        before.attemptId,
        before.currentPhase,
        before.phaseGeneration,
        input.expectedRowVersion,
      );
      if (result.changes !== 1) throw new Error("btcc_phase_state_cas_conflict");
      const next = this.requirePhaseState(before.turnId);
      this.enqueuePhaseProjection(
        next,
        "btcc.phase.receipt_accepted",
        input.receipt.receiptId,
      );
      if (input.returnTicket) {
        this.enqueuePhaseProjection(
          next,
          "btcc.return_ticket.activated",
          input.returnTicket.ticket.ticketId,
        );
      }
      return next;
    });
    return tx();
  }

  resumeAuthorityWait(input: {
    turnId: string;
    attemptId: string;
    expectedRowVersion: number;
    authorityRef: string;
    observedWakeRevisionRef?: string;
    inputFingerprint: string;
    now?: string;
  }): BtccPhaseStateV1 {
    const before = this.requirePhaseState(input.turnId);
    if (before.attemptId !== input.attemptId) {
      throw new Error("btcc_turn_attempt_mismatch");
    }
    if (before.rowVersion !== input.expectedRowVersion) {
      throw new Error("btcc_phase_state_cas_conflict");
    }
    if (
      before.lifecycleStatus !== "waiting_user" &&
      before.lifecycleStatus !== "waiting_external" &&
      before.lifecycleStatus !== "scheduled_continuation"
    ) {
      throw new Error("btcc_phase_authority_wait_not_active");
    }
    const raw = this.db.query<{
      active_wait_owner_ref: string | null;
      active_wake_revision_ref: string | null;
      active_continuation_owner_ref: string | null;
    }, [string]>(`
      SELECT active_wait_owner_ref, active_wake_revision_ref,
             active_continuation_owner_ref
      FROM btcc_turn_states WHERE turn_id = ?
    `).get(input.turnId);
    const ownerRef = before.lifecycleStatus === "scheduled_continuation"
      ? raw?.active_continuation_owner_ref
      : raw?.active_wait_owner_ref;
    if (!raw || ownerRef !== input.authorityRef) {
      throw new Error("btcc_phase_wait_authority_mismatch");
    }
    if (
      before.lifecycleStatus === "waiting_external" &&
      (!input.observedWakeRevisionRef ||
        input.observedWakeRevisionRef === raw.active_wake_revision_ref)
    ) {
      throw new Error("btcc_phase_external_revision_not_advanced");
    }
    const now = input.now ?? new Date().toISOString();
    const result = this.db.query(`
      UPDATE btcc_turn_states
      SET state = 'continuing', lifecycle_status = 'active',
          active_wait_owner_ref = NULL, active_wake_revision_ref = NULL,
          active_continuation_owner_ref = NULL,
          last_stable_input_fingerprint = ?, row_version = row_version + 1,
          updated_at = ?
      WHERE turn_id = ? AND attempt_id = ? AND row_version = ?
        AND lifecycle_status = ?
    `).run(
      input.inputFingerprint,
      now,
      input.turnId,
      input.attemptId,
      input.expectedRowVersion,
      before.lifecycleStatus,
    );
    if (result.changes !== 1) throw new Error("btcc_phase_state_cas_conflict");
    const next = this.requirePhaseState(input.turnId);
    this.enqueuePhaseProjection(next, "btcc.phase.wait_resumed", input.authorityRef);
    return next;
  }

  readPhaseReceipt(receiptId: string): PhaseReceiptV1 | null {
    const row = this.db.query<Record<string, unknown>, [string]>(`
      SELECT * FROM btcc_phase_receipts WHERE receipt_id = ?
    `).get(receiptId);
    if (!row) return null;
    return {
      schemaVersion: BTCC_PHASE_RECEIPT_SCHEMA,
      receiptId: String(row.receipt_id),
      turnId: String(row.turn_id),
      attemptId: String(row.attempt_id),
      phase: row.phase as BtccPhase,
      phaseGeneration: Number(row.phase_generation),
      ...(row.task_ref ? { taskRef: String(row.task_ref) } : {}),
      inputFingerprint: String(row.input_fingerprint),
      phasePromptId: String(row.phase_prompt_id),
      phasePromptVersion: Number(row.phase_prompt_version),
      phasePromptHash: String(row.phase_prompt_hash),
      outputArtifactRefs: parseStringArray(String(row.output_artifact_refs_json)),
      evidenceRefs: parseStringArray(String(row.evidence_refs_json)),
      dependencyReceiptRefs: parseStringArray(
        String(row.dependency_receipt_refs_json),
      ),
      status: "passed",
      nextState: row.next_state as PhaseReceiptV1["nextState"],
      ...(row.payload_json
        ? { payload: JSON.parse(String(row.payload_json)) as unknown }
        : {}),
      createdAt: String(row.created_at),
    };
  }

  private assertCommitIdentity(
    input: BtccPhaseCommitInput,
    state: BtccPhaseStateV1,
  ): void {
    for (const artifact of input.artifacts) {
      if (
        artifact.schemaVersion !== BTCC_PHASE_ARTIFACT_SCHEMA ||
        artifact.turnId !== state.turnId ||
        artifact.attemptId !== state.attemptId ||
        artifact.phase !== state.currentPhase ||
        artifact.phaseGeneration !== state.phaseGeneration
      ) {
        throw new Error("btcc_phase_artifact_target_mismatch");
      }
      if (artifact.contentHash !== hashBtccPayload(artifact.payload)) {
        throw new Error("btcc_phase_artifact_hash_mismatch");
      }
    }
    if (input.conceptionCheckpoint) {
      assertConceptionCheckpoint(input.conceptionCheckpoint, state);
    }
    if (input.goalContract) assertGoalContract(input.goalContract, state);
    if (input.trackingPolicyCandidate) {
      assertTrackingPolicy(input.trackingPolicyCandidate);
    }
    if (input.trackingPolicy) assertTrackingPolicy(input.trackingPolicy);
    if (input.returnTicket) {
      assertReturnTicket(input.returnTicket.ticket, state, input.receipt);
      const artifact = input.artifacts.find(
        (candidate) => candidate.artifactRef === input.returnTicket?.ticket.ticketId,
      );
      if (!artifact || artifact.artifactKind !== "return_ticket") {
        throw new Error("btcc_return_ticket_artifact_missing");
      }
    }
    assertPhaseCompletionContract(input, state);
  }

  private assertReceiptDependencies(
    state: BtccPhaseStateV1,
    receipt: PhaseReceiptV1,
  ): void {
    const accepted = new Set(state.acceptedReceiptRefs);
    const invalidated = new Set(state.invalidatedReceiptRefs);
    for (const dependency of receipt.dependencyReceiptRefs) {
      if (!accepted.has(dependency) || invalidated.has(dependency)) {
        throw new Error("btcc_phase_receipt_dependency_not_accepted");
      }
    }
  }

  private assertReceiptOutputsExist(receipt: PhaseReceiptV1): void {
    for (const ref of receipt.outputArtifactRefs) {
      const exists = this.db.query<
        { present: number },
        [string, string, string, string, string, string, string, string, string]
      >(`
        SELECT 1 AS present FROM btcc_phase_artifacts
        WHERE artifact_ref = ? AND turn_id = ? AND attempt_id = ?
        UNION ALL SELECT 1 FROM btcc_goal_contracts
        WHERE goal_contract_ref = ? AND turn_id = ? AND attempt_id = ?
        UNION ALL SELECT 1 FROM btcc_conception_checkpoints
        WHERE checkpoint_ref = ? AND turn_id = ? AND attempt_id = ?
        LIMIT 1
      `).get(
        ref,
        receipt.turnId,
        receipt.attemptId,
        ref,
        receipt.turnId,
        receipt.attemptId,
        ref,
        receipt.turnId,
        receipt.attemptId,
      );
      if (!exists) throw new Error("btcc_phase_receipt_output_missing");
    }
  }

  private insertConceptionCheckpoint(
    checkpoint: ConceptionCheckpointV1,
    createdAt: string,
  ): void {
    this.db.query(`
      INSERT INTO btcc_conception_checkpoints (
        checkpoint_ref, turn_id, attempt_id, phase_generation, round_index,
        working_goal_draft_json, open_evidence_needs_json, observation_refs_json,
        pending_tool_call_ref, last_input_fingerprint, public_progress_ref,
        status, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.checkpointRef,
      checkpoint.turnRef,
      checkpoint.attemptRef,
      checkpoint.phaseGeneration,
      checkpoint.roundIndex,
      checkpoint.workingGoalDraft
        ? stableJson(checkpoint.workingGoalDraft)
        : null,
      stableJson(checkpoint.openEvidenceNeeds),
      stableJson(checkpoint.observationRefs),
      checkpoint.pendingToolCallRef ?? null,
      checkpoint.lastInputFingerprint,
      checkpoint.publicProgressRef ?? null,
      checkpoint.status,
      hashBtccPayload(checkpoint),
      createdAt,
    );
  }

  private insertGoalContract(contract: GoalContractV1, createdAt: string): void {
    this.db.query(`
      INSERT INTO btcc_goal_contracts (
        goal_contract_ref, turn_id, attempt_id, revision,
        conception_model_call_id, contract_json, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contract.goalContractRef,
      contract.turnRef,
      this.requirePhaseState(contract.turnRef).attemptId,
      contract.revision,
      contract.conceptionModelCallId,
      stableJson(contract),
      hashBtccPayload(contract),
      createdAt,
    );
  }

  private insertArtifact(artifact: BtccPhaseArtifactV1): void {
    this.db.query(`
      INSERT INTO btcc_phase_artifacts (
        artifact_ref, turn_id, attempt_id, phase, phase_generation,
        artifact_kind, artifact_schema_version, task_ref, payload_json,
        content_hash, provenance_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.artifactRef,
      artifact.turnId,
      artifact.attemptId,
      artifact.phase,
      artifact.phaseGeneration,
      artifact.artifactKind,
      artifact.artifactSchemaVersion,
      artifact.taskRef ?? null,
      stableJson(artifact.payload),
      artifact.contentHash,
      stableJson(uniqueRefs(artifact.provenanceRefs)),
      artifact.createdAt,
    );
  }

  private insertPhaseReceipt(receipt: PhaseReceiptV1): void {
    this.db.query(`
      INSERT INTO btcc_phase_receipts (
        receipt_id, turn_id, attempt_id, phase, phase_generation, task_ref,
        input_fingerprint, phase_prompt_id, phase_prompt_version, phase_prompt_hash,
        output_artifact_refs_json, evidence_refs_json,
        dependency_receipt_refs_json, status, next_state, payload_json,
        content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?, ?, ?)
    `).run(
      receipt.receiptId,
      receipt.turnId,
      receipt.attemptId,
      receipt.phase,
      receipt.phaseGeneration,
      receipt.taskRef ?? null,
      receipt.inputFingerprint,
      receipt.phasePromptId,
      receipt.phasePromptVersion,
      receipt.phasePromptHash,
      stableJson(uniqueRefs(receipt.outputArtifactRefs)),
      stableJson(uniqueRefs(receipt.evidenceRefs)),
      stableJson(uniqueRefs(receipt.dependencyReceiptRefs)),
      receipt.nextState,
      receipt.payload === undefined ? null : stableJson(receipt.payload),
      hashBtccPayload(receipt),
      receipt.createdAt,
    );
  }

  private findAcceptedReceiptRefsForPhases(
    state: BtccPhaseStateV1,
    phases: ReadonlySet<BtccPhase>,
  ): string[] {
    if (phases.size === 0 || state.acceptedReceiptRefs.length === 0) return [];
    const rows = this.db.query<{ receipt_id: string; phase: BtccPhase }, [string]>(`
      SELECT receipt_id, phase FROM btcc_phase_receipts WHERE turn_id = ?
    `).all(state.turnId);
    const accepted = new Set(state.acceptedReceiptRefs);
    return rows
      .filter((row) => phases.has(row.phase))
      .map((row) => row.receipt_id)
      .filter((ref) => accepted.has(ref));
  }

  private assertCanonicalRefs(
    state: BtccPhaseStateV1,
    refs: Required<BtccPhaseStateRefsPatch>,
  ): void {
    if (refs.activeConceptionCheckpointRef) {
      const checkpoint = this.db.query<{ present: number }, [string, string, string]>(`
        SELECT 1 AS present FROM btcc_conception_checkpoints
        WHERE checkpoint_ref = ? AND turn_id = ? AND attempt_id = ?
      `).get(
        refs.activeConceptionCheckpointRef,
        state.turnId,
        state.attemptId,
      );
      if (!checkpoint) throw new Error("btcc_active_conception_checkpoint_missing");
    }
    const artifactRefs: Array<readonly [string | null, readonly BtccPhaseArtifactKind[]]> = [
      [refs.activePlanningCheckpointRef, ["planning_checkpoint"]],
      [refs.activeExecutionCheckpointRef, ["execution_checkpoint"]],
      [refs.activeReviewCheckpointRef, ["review_checkpoint"]],
      [refs.activeConsolidationCheckpointRef, ["consolidation_checkpoint"]],
      [refs.activeReportingCheckpointRef, ["reporting_checkpoint"]],
      [refs.activeConsolidationTargetRef, ["review_candidate"]],
      [refs.activeFinalDossierRef, ["final_dossier"]],
      [refs.activeTrackingAttemptRef, ["tracking_materialization"]],
      [refs.activeExecutionOperationRef, ["execution_operation"]],
      [refs.activeReviewTargetRef, ["execution_candidate"]],
      [refs.planRevisionRef, ["task_graph"]],
      [refs.activeReturnTicketRef, ["return_ticket"]],
    ];
    for (const [ref, kinds] of artifactRefs) {
      if (!ref) continue;
      const artifact = this.db.query<
        { artifact_kind: BtccPhaseArtifactKind },
        [string, string, string]
      >(`
        SELECT artifact_kind FROM btcc_phase_artifacts
        WHERE artifact_ref = ? AND turn_id = ? AND attempt_id = ?
      `).get(ref, state.turnId, state.attemptId);
      if (!artifact || !kinds.includes(artifact.artifact_kind)) {
        throw new Error("btcc_active_phase_artifact_ref_invalid");
      }
    }
  }

  private resolveActiveReturnTicketRef(
    state: BtccPhaseStateV1,
    input: BtccPhaseCommitInput,
    patchedRef: string | null,
  ): string | null {
    if (input.returnTicket) return input.returnTicket.ticket.ticketId;
    if (!patchedRef || input.receipt.nextState === state.currentPhase) return patchedRef;
    if (
      input.receipt.nextState === "waiting_user" ||
      input.receipt.nextState === "waiting_external" ||
      input.receipt.nextState === "waiting_runtime" ||
      input.receipt.nextState === "scheduled_continuation" ||
      input.receipt.nextState === "kernel_delivery"
    ) {
      return patchedRef;
    }
    const row = this.db.query<{ payload_json: string }, [string]>(`
      SELECT payload_json FROM btcc_phase_artifacts
      WHERE artifact_ref = ? AND artifact_kind = 'return_ticket'
    `).get(patchedRef);
    if (!row) throw new Error("btcc_active_return_ticket_missing");
    const ticket = JSON.parse(row.payload_json) as ReturnTicketV1;
    if (ticket.ownerPhase !== state.currentPhase) return patchedRef;
    const acknowledged = input.receipt.dependencyReceiptRefs.some((dependencyRef) => {
      const dependency = this.readPhaseReceipt(dependencyRef);
      return dependency?.outputArtifactRefs.includes(patchedRef) ?? false;
    });
    if (!acknowledged) throw new Error("btcc_return_ticket_dependency_missing");
    return null;
  }

  private requirePhaseState(turnId: string): BtccPhaseStateV1 {
    const state = this.readPhaseState(turnId);
    if (!state) throw new Error("btcc_phase_state_missing");
    return state;
  }

  private enqueuePhaseProjection(
    state: BtccPhaseStateV1,
    kind: string,
    payloadRef: string,
  ): void {
    const seq = this.db.query<{ seq: number }, [string]>(`
      SELECT seq FROM conversation_turns WHERE id = ?
    `).get(state.turnId)?.seq ?? 0;
    const outboxId = `btcc-${hashBtccPayload({
      turnId: state.turnId,
      rowVersion: state.rowVersion,
      kind,
      payloadRef,
    }).slice(0, 24)}`;
    this.db.query(`
      INSERT OR IGNORE INTO conversation_projection_outbox (
        outbox_id, conversation_session_id, seq, kind, payload_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      outboxId,
      state.sessionId,
      seq,
      kind,
      payloadRef,
      state.updatedAt,
    );
  }
}

export function hashBtccPayload(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function hydratePhaseState(row: BtccPhaseStateRow): BtccPhaseStateV1 {
  const projectPolicy = JSON.parse(row.project_policy_json) as ProjectPolicy;
  assertProjectPolicy(projectPolicy);
  const trackingPolicyCandidate = row.tracking_policy_candidate_json
    ? JSON.parse(row.tracking_policy_candidate_json) as TrackingPolicy
    : undefined;
  const trackingPolicy = row.tracking_policy_json
    ? JSON.parse(row.tracking_policy_json) as TrackingPolicy
    : undefined;
  if (trackingPolicyCandidate) assertTrackingPolicy(trackingPolicyCandidate);
  if (trackingPolicy) assertTrackingPolicy(trackingPolicy);
  return {
    schemaVersion: BTCC_PHASE_STATE_SCHEMA,
    turnId: row.turn_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    projectPolicy,
    ...(trackingPolicyCandidate ? { trackingPolicyCandidate } : {}),
    ...(trackingPolicy ? { trackingPolicy } : {}),
    acceptedControlsRef: row.accepted_controls_ref,
    lifecycleStatus: row.lifecycle_status,
    currentPhase: row.current_phase,
    phaseGeneration: row.phase_generation,
    rowVersion: row.row_version,
    ...optionalRef("goalContractRef", row.goal_contract_ref),
    ...optionalRef(
      "activeConceptionCheckpointRef",
      row.active_conception_checkpoint_ref,
    ),
    ...optionalRef("activePlanningCheckpointRef", row.active_planning_checkpoint_ref),
    ...optionalRef("activeExecutionCheckpointRef", row.active_execution_checkpoint_ref),
    ...optionalRef("activeReviewCheckpointRef", row.active_review_checkpoint_ref),
    ...optionalRef(
      "activeConsolidationCheckpointRef",
      row.active_consolidation_checkpoint_ref,
    ),
    ...optionalRef("activeReportingCheckpointRef", row.active_reporting_checkpoint_ref),
    ...optionalRef("activeConsolidationTargetRef", row.active_consolidation_target_ref),
    ...optionalRef("activeFinalDossierRef", row.active_final_dossier_ref),
    ...optionalRef("activeTrackingAttemptRef", row.active_tracking_attempt_ref),
    ...optionalRef("activeExecutionOperationRef", row.active_execution_operation_ref),
    ...optionalRef("activeReviewTargetRef", row.active_review_target_ref),
    ...optionalRef("openToolCallRef", row.open_tool_call_ref),
    ...optionalRef("planRevisionRef", row.plan_revision_ref),
    ...optionalRef("activeTrackingWorkRef", row.active_tracking_work_ref),
    ...optionalRef("activeTaskRef", row.active_task_ref),
    ...optionalRef("activeReturnTicketRef", row.active_return_ticket_ref),
    ...optionalRef("pendingCloseoutRef", row.pending_closeout_ref),
    ...optionalRef(
      "activeContinuationOwnerRef",
      row.active_continuation_owner_ref,
    ),
    acceptedReceiptRefs: parseStringArray(row.accepted_receipt_refs_json),
    invalidatedReceiptRefs: parseStringArray(row.invalidated_receipt_refs_json),
    lastStableInputFingerprint: row.last_stable_input_fingerprint,
    updatedAt: row.updated_at,
  };
}

function optionalRef<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  return value ? { [key]: value } as Partial<Record<K, string>> : {};
}

function assertConceptionCheckpoint(
  checkpoint: ConceptionCheckpointV1,
  state: BtccPhaseStateV1,
): void {
  if (
    checkpoint.schemaVersion !== BTCC_CONCEPTION_CHECKPOINT_SCHEMA ||
    checkpoint.turnRef !== state.turnId ||
    checkpoint.attemptRef !== state.attemptId ||
    checkpoint.phaseGeneration !== state.phaseGeneration ||
    state.currentPhase !== "conception"
  ) {
    throw new Error("btcc_conception_checkpoint_target_mismatch");
  }
  assertNonEmpty(checkpoint.checkpointRef, "btcc_conception_checkpoint_ref_missing");
  assertNonEmpty(
    checkpoint.lastInputFingerprint,
    "btcc_conception_checkpoint_fingerprint_missing",
  );
}

function assertGoalContract(contract: GoalContractV1, state: BtccPhaseStateV1): void {
  if (
    contract.schemaVersion !== BTCC_GOAL_CONTRACT_SCHEMA ||
    contract.turnRef !== state.turnId ||
    state.currentPhase !== "conception"
  ) {
    throw new Error("btcc_goal_contract_target_mismatch");
  }
  assertNonEmpty(contract.goalContractRef, "btcc_goal_contract_ref_missing");
  assertNonEmpty(contract.requestedOutcome, "btcc_goal_contract_outcome_missing");
  assertNonEmpty(
    contract.conceptionModelCallId,
    "btcc_goal_contract_model_call_missing",
  );
}

function assertReturnTicket(
  ticket: ReturnTicketV1,
  state: BtccPhaseStateV1,
  receipt: PhaseReceiptV1,
): void {
  if (
    ticket.schemaVersion !== BTCC_RETURN_TICKET_SCHEMA ||
    ticket.turnId !== state.turnId ||
    ticket.sourcePhase !== state.currentPhase ||
    receipt.nextState !== ticket.ownerPhase ||
    ticket.authoritativeInputGeneration !== state.phaseGeneration
  ) {
    throw new Error("btcc_return_ticket_target_mismatch");
  }
  assertNonEmpty(ticket.gapFingerprint, "btcc_return_ticket_fingerprint_missing");
  assertNonEmpty(ticket.requiredChange, "btcc_return_ticket_change_missing");
}

const NORMAL_FORWARD_PHASE: Partial<Record<BtccPhase, BtccPhase>> = {
  conception: "planning",
  planning: "execution",
  execution: "review",
  review: "consolidation",
  consolidation: "reporting",
};

const REQUIRED_FORWARD_ARTIFACTS: Partial<
  Record<BtccPhase, readonly BtccPhaseArtifactKind[]>
> = {
  conception: ["opening_decision"],
  planning: ["planning_checkpoint", "task_graph", "tracking_materialization"],
  execution: ["execution_input", "execution_checkpoint", "execution_candidate"],
  review: ["review_input", "review_checkpoint", "review_candidate"],
  consolidation: [
    "consolidation_input",
    "consolidation_checkpoint",
    "final_dossier",
  ],
  reporting: [
    "reporting_input",
    "reporting_checkpoint",
    "report_candidate",
    "report_validation_receipt",
    "report_guard_receipt",
  ],
};

function assertPhaseCompletionContract(
  input: BtccPhaseCommitInput,
  state: BtccPhaseStateV1,
): void {
  const outputs = new Set(input.receipt.outputArtifactRefs);
  for (const artifact of input.artifacts) {
    if (!outputs.has(artifact.artifactRef)) {
      throw new Error("btcc_phase_artifact_not_receipted");
    }
  }
  if (input.conceptionCheckpoint && !outputs.has(input.conceptionCheckpoint.checkpointRef)) {
    throw new Error("btcc_conception_checkpoint_not_receipted");
  }
  if (input.goalContract && !outputs.has(input.goalContract.goalContractRef)) {
    throw new Error("btcc_goal_contract_not_receipted");
  }
  if (input.receipt.evidenceRefs.length === 0) {
    throw new Error("btcc_phase_receipt_evidence_missing");
  }

  const nextState = input.receipt.nextState;
  const nextIsPhase = BTCC_PHASES.includes(nextState as BtccPhase);
  const normalForward = NORMAL_FORWARD_PHASE[state.currentPhase];
  if (nextIsPhase && nextState !== normalForward) {
    if (!input.returnTicket) throw new Error("btcc_return_ticket_required");
    return;
  }
  if (input.returnTicket) {
    throw new Error("btcc_return_ticket_not_a_forward_transition");
  }

  const completesPhase = nextState === normalForward || nextState === "kernel_delivery";
  if (completesPhase) {
    const kinds = new Set(input.artifacts.map((artifact) => artifact.artifactKind));
    for (const required of REQUIRED_FORWARD_ARTIFACTS[state.currentPhase] ?? []) {
      if (!kinds.has(required)) {
        throw new Error(`btcc_phase_required_artifact_missing:${required}`);
      }
    }
  }
  if (state.currentPhase === "conception" && nextState === "planning") {
    if (
      !input.goalContract ||
      !input.conceptionCheckpoint ||
      input.conceptionCheckpoint.status !== "finalized" ||
      !input.trackingPolicyCandidate
    ) {
      throw new Error("btcc_conception_completion_contract_incomplete");
    }
  }
  if (state.currentPhase === "planning" && nextState === "execution") {
    if (!input.trackingPolicy) {
      throw new Error("btcc_planning_tracking_policy_missing");
    }
  }
  if (
    nextState === "waiting_user" ||
    nextState === "waiting_external" ||
    nextState === "scheduled_continuation"
  ) {
    const checkpointKind = `${state.currentPhase}_checkpoint`;
    const hasCheckpoint = state.currentPhase === "conception"
      ? Boolean(input.conceptionCheckpoint || state.activeConceptionCheckpointRef)
      : input.artifacts.some((artifact) => artifact.artifactKind === checkpointKind);
    if (!hasCheckpoint) throw new Error("btcc_phase_wait_checkpoint_missing");
  }
}

function assertProjectPolicy(policy: ProjectPolicy): void {
  if (policy.kind === "unbound") return;
  if (
    policy.kind !== "project_bound" ||
    !policy.projectId?.trim() ||
    !policy.ledgerProjectRef?.trim() ||
    !policy.workspaceRef?.trim()
  ) {
    throw new Error("btcc_project_policy_invalid");
  }
}

function assertTrackingPolicy(policy: TrackingPolicy): void {
  switch (policy.kind) {
    case "turn_local":
      return;
    case "workstream":
      assertNonEmpty(policy.workstreamRef, "btcc_workstream_ref_missing");
      return;
    case "project_ledger":
      assertNonEmpty(policy.projectId, "btcc_tracking_project_id_missing");
      assertNonEmpty(policy.ledgerProjectRef, "btcc_tracking_ledger_ref_missing");
      assertNonEmpty(policy.workspaceRef, "btcc_tracking_workspace_ref_missing");
      return;
  }
}

function assertActiveVersion(state: BtccPhaseStateV1, rowVersion: number): void {
  if (state.lifecycleStatus !== "active") {
    throw new Error(`btcc_phase_state_not_active:${state.lifecycleStatus}`);
  }
  if (state.rowVersion !== rowVersion) {
    throw new Error("btcc_phase_state_cas_conflict");
  }
}

function assertWaitIdentity(
  lifecycle: BtccPhaseLifecycleStatus,
  input: BtccPhaseCommitInput,
): void {
  if (
    (lifecycle === "waiting_user" || lifecycle === "waiting_external") &&
    !input.waitOwnerRef?.trim()
  ) {
    throw new Error("btcc_phase_wait_owner_missing");
  }
  if (lifecycle === "waiting_external" && !input.wakeRevisionRef?.trim()) {
    throw new Error("btcc_phase_wake_revision_missing");
  }
  if (lifecycle === "scheduled_continuation" && !input.waitOwnerRef?.trim()) {
    throw new Error("btcc_phase_continuation_owner_missing");
  }
}

function compatibilityStateForLifecycle(
  lifecycle: BtccPhaseLifecycleStatus,
): string {
  switch (lifecycle) {
    case "waiting_user":
    case "waiting_external":
      return lifecycle;
    case "waiting_runtime":
      throw new Error("btcc_runtime_wait_requires_recovery_case");
    case "cancelled":
    case "delivered":
      throw new Error("btcc_phase_receipt_cannot_finalize_turn");
    case "active":
    case "scheduled_continuation":
      return "continuing";
  }
}

function mergeRefs(
  state: BtccPhaseStateV1,
  patch: BtccPhaseStateRefsPatch | undefined,
): Required<BtccPhaseStateRefsPatch> {
  const value = <K extends keyof BtccPhaseStateRefsPatch>(key: K): string | null =>
    patch && key in patch ? patch[key] ?? null : state[key] ?? null;
  return {
    activeConceptionCheckpointRef: value("activeConceptionCheckpointRef"),
    activePlanningCheckpointRef: value("activePlanningCheckpointRef"),
    activeExecutionCheckpointRef: value("activeExecutionCheckpointRef"),
    activeReviewCheckpointRef: value("activeReviewCheckpointRef"),
    activeConsolidationCheckpointRef: value("activeConsolidationCheckpointRef"),
    activeReportingCheckpointRef: value("activeReportingCheckpointRef"),
    activeConsolidationTargetRef: value("activeConsolidationTargetRef"),
    activeFinalDossierRef: value("activeFinalDossierRef"),
    activeTrackingAttemptRef: value("activeTrackingAttemptRef"),
    activeExecutionOperationRef: value("activeExecutionOperationRef"),
    activeReviewTargetRef: value("activeReviewTargetRef"),
    openToolCallRef: value("openToolCallRef"),
    planRevisionRef: value("planRevisionRef"),
    activeTrackingWorkRef: value("activeTrackingWorkRef"),
    activeTaskRef: value("activeTaskRef"),
    activeReturnTicketRef: value("activeReturnTicketRef"),
    pendingCloseoutRef: value("pendingCloseoutRef"),
  };
}

function deriveRefs(
  refs: Required<BtccPhaseStateRefsPatch>,
  artifacts: readonly BtccPhaseArtifactV1[],
): Required<BtccPhaseStateRefsPatch> {
  const next = { ...refs };
  for (const artifact of artifacts) {
    switch (artifact.artifactKind) {
      case "planning_checkpoint":
        next.activePlanningCheckpointRef = artifact.artifactRef;
        break;
      case "execution_checkpoint":
        next.activeExecutionCheckpointRef = artifact.artifactRef;
        break;
      case "review_checkpoint":
        next.activeReviewCheckpointRef = artifact.artifactRef;
        break;
      case "consolidation_checkpoint":
        next.activeConsolidationCheckpointRef = artifact.artifactRef;
        break;
      case "reporting_checkpoint":
        next.activeReportingCheckpointRef = artifact.artifactRef;
        break;
      case "task_graph":
        next.planRevisionRef = artifact.artifactRef;
        break;
      case "tracking_materialization":
        next.activeTrackingAttemptRef = artifact.artifactRef;
        break;
      case "execution_operation":
        next.activeExecutionOperationRef = artifact.artifactRef;
        break;
      case "execution_candidate":
        next.activeReviewTargetRef = artifact.artifactRef;
        break;
      case "review_candidate":
        next.activeConsolidationTargetRef = artifact.artifactRef;
        break;
      case "final_dossier":
        next.activeFinalDossierRef = artifact.artifactRef;
        break;
      default:
        break;
    }
  }
  return next;
}

function clearRefsForReturnTicket(
  refs: Required<BtccPhaseStateRefsPatch>,
  ticket: ReturnTicketV1 | undefined,
): Required<BtccPhaseStateRefsPatch> {
  if (!ticket) return refs;
  const next = { ...refs };
  const clearReporting = (): void => {
    next.activeReportingCheckpointRef = null;
    next.pendingCloseoutRef = null;
  };
  const clearConsolidation = (): void => {
    next.activeConsolidationCheckpointRef = null;
    next.activeFinalDossierRef = null;
    clearReporting();
  };
  const clearReview = (): void => {
    next.activeReviewCheckpointRef = null;
    next.activeConsolidationTargetRef = null;
    clearConsolidation();
  };
  const clearExecution = (): void => {
    next.activeExecutionCheckpointRef = null;
    next.activeExecutionOperationRef = null;
    next.activeReviewTargetRef = null;
    clearReview();
  };
  const clearPlanning = (): void => {
    next.activePlanningCheckpointRef = null;
    next.planRevisionRef = null;
    next.activeTrackingAttemptRef = null;
    next.activeTrackingWorkRef = null;
    next.activeTaskRef = null;
    clearExecution();
  };
  switch (ticket.ownerPhase) {
    case "conception":
      next.activeConceptionCheckpointRef = null;
      clearPlanning();
      break;
    case "planning":
      clearPlanning();
      break;
    case "execution":
      clearExecution();
      break;
    case "review":
      clearReview();
      break;
    case "reporting":
      clearReporting();
      break;
  }
  return next;
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? uniqueRefs(parsed.filter((item): item is string => typeof item === "string"))
    : [];
}

function uniqueRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : stableJson(value);
}

function assertNonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new Error(code);
}
