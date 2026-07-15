import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgentConversationStore,
  conversationStorePath,
} from "../../packages/butler-agent/src/agent/conversation/store.ts";
import {
  BtccPhaseStore,
  hashBtccPayload,
} from "../../packages/butler-agent/src/agent/turn/btcc/phase-store.ts";
import {
  BTCC_CONCEPTION_CHECKPOINT_SCHEMA,
  BTCC_GOAL_CONTRACT_SCHEMA,
  BTCC_PHASE_ARTIFACT_SCHEMA,
  BTCC_PHASE_RECEIPT_SCHEMA,
  BTCC_RETURN_TICKET_SCHEMA,
  type BtccPhaseArtifactKind,
  type BtccPhaseArtifactV1,
  type BtccPhaseReceiptNextState,
  type BtccPhaseStateV1,
  type ConceptionCheckpointV1,
  type GoalContractV1,
  type PhaseReceiptV1,
  type ReturnTicketV1,
} from "../../packages/butler-agent/src/agent/turn/btcc/phase-types.ts";
import { routeTurnInterruption } from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-router.ts";
import { TURN_INTERRUPTION_ENVELOPE_SCHEMA } from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-types.ts";

const tempDirs: string[] = [];
const NOW = "2026-07-15T03:00:00.000Z";

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tempData(): string {
  const path = mkdtempSync(join(tmpdir(), "butler-btcc-phase-"));
  tempDirs.push(path);
  return path;
}

function beginTurn(
  conversations: AgentConversationStore,
  turnId = "turn-1",
  sessionId = "session-1",
): void {
  conversations.beginTurn({
    gateway: "app",
    externalSessionId: sessionId,
    sessionId,
    workspaceId: "workspace-1",
    projectId: "butler",
    actor: "user",
    turnId,
    now: NOW,
  });
}

function admit(
  store: BtccPhaseStore,
  turnId = "turn-1",
  sessionId = "session-1",
): BtccPhaseStateV1 {
  return store.admitPhaseTurn({
    turnId,
    sessionId,
    attemptId: `attempt:${turnId}`,
    projectPolicy: {
      kind: "project_bound",
      projectId: "butler",
      ledgerProjectRef: "ledger:butler",
      workspaceRef: "/workspace/butler",
    },
    acceptedControlsRef: `controls:${turnId}:accepted`,
    inputFingerprint: `input:${turnId}:1`,
    now: NOW,
  });
}

function checkpoint(
  state: BtccPhaseStateV1,
  ref: string,
  status: ConceptionCheckpointV1["status"] = "finalized",
): ConceptionCheckpointV1 {
  return {
    schemaVersion: BTCC_CONCEPTION_CHECKPOINT_SCHEMA,
    checkpointRef: ref,
    turnRef: state.turnId,
    attemptRef: state.attemptId,
    phaseGeneration: state.phaseGeneration,
    roundIndex: 1,
    openEvidenceNeeds: [],
    observationRefs: ["observation:user-message"],
    lastInputFingerprint: `fingerprint:${ref}`,
    status,
  };
}

function goal(state: BtccPhaseStateV1, ref = "goal-1"): GoalContractV1 {
  return {
    schemaVersion: BTCC_GOAL_CONTRACT_SCHEMA,
    goalContractRef: ref,
    turnRef: state.turnId,
    revision: 1,
    conceptionModelCallId: "model-call:conception:1",
    requestedOutcome: "Implement and verify the BTCC state machine",
    problemFrame: "The turn must progress only through accepted phase receipts.",
    deliverables: [{
      key: "implementation",
      kind: "code",
      description: "A durable phase state machine",
      required: true,
    }],
    bindingConstraints: ["No failed lifecycle state"],
    nonGoals: ["Heuristic text classification"],
    acceptanceIntents: [{
      key: "state-machine",
      statement: "Every transition has a passed receipt",
      evidenceClass: "validation",
    }],
    ambiguityDecisions: [],
    currentStateNeeds: [],
    evidenceNeeds: ["simulation"],
    downstreamAuthorityNeeds: ["Turn Kernel"],
    applicableAdaptationHints: [],
    workShape: {
      workDisposition: "managed_work",
      custody: "durable",
      requiredEffects: ["repository change"],
      deliverableKinds: ["code", "tests"],
      requiresCurrentState: true,
      requiresTools: true,
    },
    semanticAuthorityRefs: [state.acceptedControlsRef],
  };
}

function artifact(
  state: BtccPhaseStateV1,
  artifactRef: string,
  artifactKind: BtccPhaseArtifactKind,
  payload: unknown = { artifactRef },
): BtccPhaseArtifactV1 {
  return {
    schemaVersion: BTCC_PHASE_ARTIFACT_SCHEMA,
    artifactRef,
    turnId: state.turnId,
    attemptId: state.attemptId,
    phase: state.currentPhase,
    phaseGeneration: state.phaseGeneration,
    artifactKind,
    artifactSchemaVersion: `test.${artifactKind}.v1`,
    payload,
    contentHash: hashBtccPayload(payload),
    provenanceRefs: [state.lastStableInputFingerprint],
    createdAt: NOW,
  };
}

function receipt(
  state: BtccPhaseStateV1,
  receiptId: string,
  nextState: BtccPhaseReceiptNextState,
  outputArtifactRefs: string[],
  dependencyReceiptRefs: string[] = [],
): PhaseReceiptV1 {
  return {
    schemaVersion: BTCC_PHASE_RECEIPT_SCHEMA,
    receiptId,
    turnId: state.turnId,
    attemptId: state.attemptId,
    phase: state.currentPhase,
    phaseGeneration: state.phaseGeneration,
    inputFingerprint: `input:${receiptId}`,
    phasePromptId: `prompt:${state.currentPhase}`,
    phasePromptVersion: 1,
    phasePromptHash: `prompt-hash:${state.currentPhase}:1`,
    outputArtifactRefs,
    evidenceRefs: [`evidence:${receiptId}`],
    dependencyReceiptRefs,
    status: "passed",
    nextState,
    createdAt: NOW,
  };
}

function commitConception(
  store: BtccPhaseStore,
  state: BtccPhaseStateV1,
): BtccPhaseStateV1 {
  const finalCheckpoint = checkpoint(state, `checkpoint:${state.turnId}:final`);
  const contract = goal(state, `goal:${state.turnId}:1`);
  const opening = artifact(
    state,
    `opening:${state.turnId}:1`,
    "opening_decision",
    { mode: "managed_work", nextPhase: "planning" },
  );
  return store.commitPhase({
    expectedRowVersion: state.rowVersion,
    receipt: receipt(
      state,
      `receipt:${state.turnId}:conception:1`,
      "planning",
      [finalCheckpoint.checkpointRef, contract.goalContractRef, opening.artifactRef],
    ),
    artifacts: [opening],
    conceptionCheckpoint: finalCheckpoint,
    goalContract: contract,
    trackingPolicyCandidate: {
      kind: "project_ledger",
      projectId: "butler",
      ledgerProjectRef: "ledger:butler",
      workspaceRef: "/workspace/butler",
    },
  });
}

function commitStep(
  store: BtccPhaseStore,
  state: BtccPhaseStateV1,
  input: {
    receiptId: string;
    nextState: BtccPhaseReceiptNextState;
    artifactRef: string;
    artifactKind: BtccPhaseArtifactKind;
    dependencies?: string[];
  },
): BtccPhaseStateV1 {
  const outputs = [artifact(state, input.artifactRef, input.artifactKind)];
  const requiredKinds: Partial<Record<BtccPhaseStateV1["currentPhase"], BtccPhaseArtifactKind[]>> = {
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
  const normalForwardByPhase: Partial<
    Record<BtccPhaseStateV1["currentPhase"], BtccPhaseReceiptNextState>
  > = {
    planning: "execution",
    execution: "review",
    review: "consolidation",
    consolidation: "reporting",
    reporting: "kernel_delivery",
  };
  const normalForward = normalForwardByPhase[state.currentPhase];
  if (input.nextState === normalForward) {
    for (const kind of requiredKinds[state.currentPhase] ?? []) {
      if (!outputs.some((candidate) => candidate.artifactKind === kind)) {
        outputs.push(artifact(state, `${input.receiptId}:${kind}`, kind));
      }
    }
  }
  return store.commitPhase({
    expectedRowVersion: state.rowVersion,
    receipt: receipt(
      state,
      input.receiptId,
      input.nextState,
      outputs.map((output) => output.artifactRef),
      input.dependencies ?? [],
    ),
    artifacts: outputs,
    ...(state.currentPhase === "planning" && input.nextState === "execution"
      ? { trackingPolicy: state.trackingPolicyCandidate ?? { kind: "turn_local" } }
      : {}),
  });
}

function throughReviewInput(
  store: BtccPhaseStore,
  initial: BtccPhaseStateV1,
): BtccPhaseStateV1 {
  let state = commitConception(store, initial);
  state = commitStep(store, state, {
    receiptId: "receipt:planning:1",
    nextState: "execution",
    artifactRef: "task-graph:1",
    artifactKind: "task_graph",
    dependencies: ["receipt:turn-1:conception:1"],
  });
  return commitStep(store, state, {
    receiptId: "receipt:execution:1",
    nextState: "review",
    artifactRef: "execution-candidate:1",
    artifactKind: "execution_candidate",
    dependencies: ["receipt:planning:1"],
  });
}

describe("BtccPhaseStore", () => {
  test("simulates all six phases, restart recovery, kernel delivery, and terminalization", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    beginTurn(conversations);
    let store = new BtccPhaseStore({ butlerData });
    let state = admit(store);
    state = store.commitConceptionCheckpoint({
      expectedRowVersion: state.rowVersion,
      checkpoint: checkpoint(state, "checkpoint:conception:working", "active"),
      now: NOW,
    });
    state = commitConception(store, state);
    expect(state).toMatchObject({
      currentPhase: "planning",
      lifecycleStatus: "active",
      phaseGeneration: 2,
      goalContractRef: "goal:turn-1:1",
    });
    state = commitStep(store, state, {
      receiptId: "receipt:planning:1",
      nextState: "execution",
      artifactRef: "task-graph:1",
      artifactKind: "task_graph",
      dependencies: ["receipt:turn-1:conception:1"],
    });
    expect(state).toMatchObject({
      activePlanningCheckpointRef: "receipt:planning:1:planning_checkpoint",
      planRevisionRef: "task-graph:1",
      activeTrackingAttemptRef: "receipt:planning:1:tracking_materialization",
    });
    state = commitStep(store, state, {
      receiptId: "receipt:execution:1",
      nextState: "review",
      artifactRef: "execution-candidate:1",
      artifactKind: "execution_candidate",
      dependencies: ["receipt:planning:1"],
    });
    expect(state.currentPhase).toBe("review");

    store.close();
    store = new BtccPhaseStore({ butlerData });
    state = store.readPhaseState("turn-1")!;
    expect(state).toMatchObject({
      currentPhase: "review",
      lifecycleStatus: "active",
      phaseGeneration: 4,
    });

    state = commitStep(store, state, {
      receiptId: "receipt:review:1",
      nextState: "consolidation",
      artifactRef: "review-candidate:1",
      artifactKind: "review_candidate",
      dependencies: ["receipt:execution:1"],
    });
    state = commitStep(store, state, {
      receiptId: "receipt:consolidation:1",
      nextState: "reporting",
      artifactRef: "final-dossier:1",
      artifactKind: "final_dossier",
      dependencies: ["receipt:review:1"],
    });
    state = commitStep(store, state, {
      receiptId: "receipt:reporting:1",
      nextState: "kernel_delivery",
      artifactRef: "report-guard:1",
      artifactKind: "report_guard_receipt",
      dependencies: ["receipt:consolidation:1"],
    });
    expect(state).toMatchObject({
      currentPhase: "reporting",
      lifecycleStatus: "active",
      phaseGeneration: 6,
    });

    const kernelState = store.readTurnState("turn-1")!;
    store.acceptReportingReceipt({
      reportingReceiptId: "kernel-reporting-receipt:1",
      turnId: state.turnId,
      attemptId: state.attemptId,
      expectedGeneration: kernelState.generation,
      resultDisposition: "fulfilled",
      publicMessageRef: "assistant-message:1",
      completionEvidenceRefs: ["report-guard:1"],
      createdAt: NOW,
    });
    const delivered = store.readPhaseState("turn-1")!;
    expect(delivered.lifecycleStatus).toBe("delivered");
    expect(delivered.currentPhase).toBe("reporting");
    expect(conversations.readProjectionBatch(null, 100).map((event) => event.kind))
      .toContain("btcc.phase.receipt_accepted");
    const db = new Database(conversationStorePath(butlerData));
    expect(() => db.query(`
      UPDATE btcc_phase_receipts SET phase_prompt_hash = 'rewritten'
      WHERE receipt_id = 'receipt:reporting:1'
    `).run()).toThrow("btcc_phase_receipt_immutable");
    expect(() => db.query(`
      UPDATE btcc_phase_artifacts SET content_hash = 'rewritten'
      WHERE artifact_ref = 'report-guard:1'
    `).run()).toThrow("btcc_phase_artifact_immutable");
    db.close();

    const replayed = store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt: store.readPhaseReceipt("receipt:reporting:1")!,
      artifacts: [],
    });
    expect(replayed.lifecycleStatus).toBe("delivered");

    store.close();
    conversations.close();
  });

  test("uses a typed ReturnTicket to invalidate dependencies and re-enter the owner phase", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    beginTurn(conversations);
    const store = new BtccPhaseStore({ butlerData });
    let state = throughReviewInput(store, admit(store));
    const ticket: ReturnTicketV1 = {
      schemaVersion: BTCC_RETURN_TICKET_SCHEMA,
      ticketId: "return-ticket:execution:1",
      turnId: state.turnId,
      sourcePhase: "review",
      ownerPhase: "execution",
      reasonCode: "execution_evidence_gap",
      authoritativeInputGeneration: state.phaseGeneration,
      artifactRevisionRefs: ["execution-candidate:1"],
      evidenceRefs: ["review-observation:1"],
      requiredChange: "Regenerate the execution candidate with current evidence.",
      gapFingerprint: "gap:execution-evidence:1",
      createdAt: NOW,
    };
    const ticketArtifact = artifact(
      state,
      ticket.ticketId,
      "return_ticket",
      ticket,
    );
    state = store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt: receipt(
        state,
        "receipt:review:return:1",
        "execution",
        [ticket.ticketId],
        ["receipt:execution:1"],
      ),
      artifacts: [ticketArtifact],
      returnTicket: {
        ticket,
        invalidatesAuthority: "task_artifact_or_evidence",
      },
    });
    expect(state).toMatchObject({
      currentPhase: "execution",
      activeReturnTicketRef: ticket.ticketId,
    });
    expect(state.activeReviewTargetRef).toBeUndefined();
    expect(state.acceptedReceiptRefs).toEqual([
      "receipt:turn-1:conception:1",
      "receipt:planning:1",
      "receipt:review:return:1",
    ]);
    expect(state.invalidatedReceiptRefs).toContain("receipt:execution:1");

    expect(() => commitStep(store, state, {
      receiptId: "receipt:execution:stale-dependency",
      nextState: "review",
      artifactRef: "execution-candidate:stale-dependency",
      artifactKind: "execution_candidate",
      dependencies: ["receipt:execution:1"],
    })).toThrow("btcc_phase_receipt_dependency_not_accepted");

    state = commitStep(store, state, {
      receiptId: "receipt:execution:2",
      nextState: "review",
      artifactRef: "execution-candidate:2",
      artifactKind: "execution_candidate",
      dependencies: ["receipt:planning:1", "receipt:review:return:1"],
    });
    expect(state.currentPhase).toBe("review");
    expect(state.activeReturnTicketRef).toBeUndefined();
    expect(state.acceptedReceiptRefs).toContain("receipt:execution:2");
    expect(state.invalidatedReceiptRefs).toContain("receipt:execution:1");

    store.close();
    conversations.close();
  });

  test("persists external and scheduled waits with identity-based resume predicates", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    beginTurn(conversations);
    let store = new BtccPhaseStore({ butlerData });
    let state = commitConception(store, admit(store));
    const external = artifact(
      state,
      "planning-external-operation:1",
      "planning_checkpoint",
    );
    state = store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt: receipt(
        state,
        "receipt:planning:external-wait",
        "waiting_external",
        [external.artifactRef],
        ["receipt:turn-1:conception:1"],
      ),
      artifacts: [external],
      waitOwnerRef: "external-operation:1",
      wakeRevisionRef: "external-revision:1",
    });
    expect(state.lifecycleStatus).toBe("waiting_external");

    store.close();
    store = new BtccPhaseStore({ butlerData });
    state = store.readPhaseState("turn-1")!;
    expect(() => store.resumeAuthorityWait({
      turnId: state.turnId,
      attemptId: state.attemptId,
      expectedRowVersion: state.rowVersion,
      authorityRef: "external-operation:1",
      observedWakeRevisionRef: "external-revision:1",
      inputFingerprint: "input:unchanged-external",
    })).toThrow("btcc_phase_external_revision_not_advanced");
    state = store.resumeAuthorityWait({
      turnId: state.turnId,
      attemptId: state.attemptId,
      expectedRowVersion: state.rowVersion,
      authorityRef: "external-operation:1",
      observedWakeRevisionRef: "external-revision:2",
      inputFingerprint: "input:changed-external",
    });
    expect(state.lifecycleStatus).toBe("active");

    const continuation = artifact(
      state,
      "planning-continuation:1",
      "planning_checkpoint",
    );
    state = store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt: receipt(
        state,
        "receipt:planning:continuation",
        "scheduled_continuation",
        [continuation.artifactRef],
        ["receipt:planning:external-wait"],
      ),
      artifacts: [continuation],
      waitOwnerRef: "continuation:planning:1",
    });
    expect(state).toMatchObject({
      lifecycleStatus: "scheduled_continuation",
      activeContinuationOwnerRef: "continuation:planning:1",
    });
    state = store.resumeAuthorityWait({
      turnId: state.turnId,
      attemptId: state.attemptId,
      expectedRowVersion: state.rowVersion,
      authorityRef: "continuation:planning:1",
      inputFingerprint: "input:continuation-claimed",
    });
    expect(state.lifecycleStatus).toBe("active");
    expect(state.activeContinuationOwnerRef).toBeUndefined();

    store.close();
    conversations.close();
  });

  test("rolls back malformed commits, rejects stale CAS, and makes records immutable", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    beginTurn(conversations);
    const store = new BtccPhaseStore({ butlerData });
    const admitted = admit(store);
    const incompleteOpening = artifact(
      admitted,
      "artifact:incomplete-conception",
      "opening_decision",
    );
    expect(() => store.commitPhase({
      expectedRowVersion: admitted.rowVersion,
      receipt: receipt(
        admitted,
        "receipt:incomplete-conception",
        "planning",
        [incompleteOpening.artifactRef],
      ),
      artifacts: [incompleteOpening],
    })).toThrow("btcc_conception_completion_contract_incomplete");
    const badHash = artifact(admitted, "artifact:bad-hash", "opening_decision");
    badHash.contentHash = "wrong";
    expect(() => store.commitPhase({
      expectedRowVersion: admitted.rowVersion,
      receipt: receipt(
        admitted,
        "receipt:bad-hash",
        "planning",
        [badHash.artifactRef],
      ),
      artifacts: [badHash],
    })).toThrow("btcc_phase_artifact_hash_mismatch");

    const checkpointed = store.commitConceptionCheckpoint({
      expectedRowVersion: admitted.rowVersion,
      checkpoint: checkpoint(admitted, "checkpoint:cas:1", "active"),
    });
    const valid = artifact(
      checkpointed,
      "artifact:rolled-back",
      "opening_decision",
    );
    expect(() => store.commitPhase({
      expectedRowVersion: checkpointed.rowVersion,
      receipt: receipt(
        checkpointed,
        "receipt:missing-output",
        "waiting_user",
        [valid.artifactRef, "artifact:not-present"],
      ),
      artifacts: [valid],
      waitOwnerRef: "user-blocker:missing-output-test",
    })).toThrow("btcc_phase_receipt_output_missing");

    expect(() => store.commitConceptionCheckpoint({
      expectedRowVersion: admitted.rowVersion,
      checkpoint: checkpoint(checkpointed, "checkpoint:cas:2", "active"),
    })).toThrow("btcc_phase_state_cas_conflict");

    const db = new Database(conversationStorePath(butlerData));
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_phase_artifacts
    `).get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_phase_receipts
    `).get()?.count).toBe(0);
    expect(() => db.query(`
      UPDATE btcc_conception_checkpoints SET status = 'finalized'
      WHERE checkpoint_ref = 'checkpoint:cas:1'
    `).run()).toThrow("btcc_conception_checkpoint_immutable");
    expect(() => db.query(`
      UPDATE btcc_turn_states SET lifecycle_status = 'failed'
      WHERE turn_id = 'turn-1'
    `).run()).toThrow();
    expect(() => db.query(`
      UPDATE btcc_turn_states
      SET current_phase = 'planning', phase_generation = phase_generation + 1
      WHERE turn_id = 'turn-1'
    `).run()).toThrow("btcc_phase_receipt_required");
    expect(() => db.query(`
      UPDATE btcc_turn_states
      SET state = 'delivered', lifecycle_status = 'delivered',
          terminal_outcome_id = 'fabricated'
      WHERE turn_id = 'turn-1'
    `).run()).toThrow("btcc_reporting_receipt_required");

    db.close();
    store.close();
    conversations.close();
  });

  test("migrates a v3 nonterminal state without losing wait ownership", () => {
    const butlerData = tempData();
    const dbPath = conversationStorePath(butlerData);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE conversation_sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT,
        gateway_origin TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, status TEXT NOT NULL, schema_version INTEGER NOT NULL
      );
      CREATE TABLE conversation_turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        actor TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT,
        started_at TEXT NOT NULL, completed_at TEXT,
        UNIQUE (session_id, seq)
      );
      CREATE TABLE btcc_turn_states (
        turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        state TEXT NOT NULL, generation INTEGER NOT NULL,
        last_stable_checkpoint_ref TEXT, active_recovery_case_id TEXT,
        active_wait_owner_ref TEXT, active_wake_revision_ref TEXT,
        terminal_outcome_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE conversation_schema_migrations (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
      );
      INSERT INTO conversation_sessions VALUES (
        'session-old', 'workspace-1', 'butler', 'app', '${NOW}', '${NOW}', 'active', 3
      );
      INSERT INTO conversation_turns VALUES (
        'turn-old', 'session-old', 1, 'user', 'running', NULL, '${NOW}', NULL
      );
      INSERT INTO btcc_turn_states VALUES (
        'turn-old', 'session-old', 'attempt-old', 'waiting_external', 7,
        'checkpoint-old', NULL, 'external-owner-old', 'wake-old', NULL,
        '${NOW}', '${NOW}'
      );
      INSERT INTO conversation_schema_migrations VALUES (3, '${NOW}');
    `);
    db.close();

    const store = new BtccPhaseStore({ butlerData });
    const migrated = store.readPhaseState("turn-old")!;
    expect(migrated).toMatchObject({
      lifecycleStatus: "waiting_external",
      currentPhase: "conception",
      phaseGeneration: 1,
      acceptedControlsRef: "controls:turn-old",
    });
    const resumed = store.resumeAuthorityWait({
      turnId: "turn-old",
      attemptId: "attempt-old",
      expectedRowVersion: migrated.rowVersion,
      authorityRef: "external-owner-old",
      observedWakeRevisionRef: "wake-new",
      inputFingerprint: "input:migrated-resume",
    });
    expect(resumed.lifecycleStatus).toBe("active");

    store.close();
  });

  test("Stop remains the only cancellation authority and late phase writes lose CAS", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    beginTurn(conversations);
    const store = new BtccPhaseStore({ butlerData });
    const state = admit(store);
    const kernelState = store.readTurnState(state.turnId)!;
    store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "user_cancellation",
      interruptionId: "stop:turn-1:1",
      turnId: state.turnId,
      attemptId: state.attemptId,
      origin: "admission",
      currentGeneration: kernelState.generation,
      lastStableCheckpointRef: "checkpoint:stop:1",
      createdAt: NOW,
      cancellationGeneration: kernelState.generation,
      cancellationReceiptRef: "stop:turn-1:1",
    }));
    const cancelled = store.readPhaseState(state.turnId)!;
    expect(cancelled.lifecycleStatus).toBe("cancelled");
    expect(() => store.commitConceptionCheckpoint({
      expectedRowVersion: state.rowVersion,
      checkpoint: checkpoint(state, "checkpoint:late-after-stop", "active"),
    })).toThrow("btcc_phase_state_not_active:cancelled");
    const lateArtifact = artifact(state, "artifact:late-after-stop", "opening_decision");
    expect(() => store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt: receipt(
        state,
        "receipt:late-after-stop",
        "planning",
        [lateArtifact.artifactRef],
      ),
      artifacts: [lateArtifact],
    })).toThrow("btcc_phase_state_not_active:cancelled");

    store.close();
    conversations.close();
  });
});
