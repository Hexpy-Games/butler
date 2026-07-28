import { expect, test } from "bun:test";
import {
  createBtccTurnRuntime,
  type BtccRuntimeDependencies,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";
import { isBtccOperationalInterruption } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";
import {
  decideTransition,
  type StateExecutionClaim,
  type TurnEvent,
  type TurnRecord,
  type TurnSemanticState,
  type TurnStateRepository,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { advanceTurn } from
  "../../packages/butler-agent/src/agent/btcc/turn/advance-turn.ts";
import { createTurnExecutionSupervisor } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

const semanticStates = [
  "admitted",
  "conception_opening",
  "assisted_answer",
  "conception_deliberation",
  "contract_review",
  "planning",
  "planning_review",
  "work_frontier",
  "task_execution",
  "task_review",
  "feedback_conception",
  "feedback_planning",
  "feedback_planning_review",
  "consolidation",
  "reporting",
  "delivery_committed",
  "delivered",
  "cancelled",
] as const satisfies readonly TurnSemanticState[];

test("the public Turn reducer returns a decision for every semantic state", () => {
  const event: TurnEvent = { kind: "TurnActivated" };

  for (const state of semanticStates) {
    const decision = decideTransition(turnIn(state), event);
    if (state === "admitted") {
      expect(decision).toMatchObject({
        kind: "accepted",
        transition: { kind: "activate_opening", successor: "conception_opening" },
      });
      continue;
    }
    expect(decision).toEqual({
      kind: "rejected_unchanged",
      reason: { kind: "state_event_mismatch", state, event: "TurnActivated" },
    });
  }
});

test("delivery observation accepts only the immutable Outbox message binding", () => {
  const turn = turnIn("delivery_committed");

  expect(decideTransition(turn, {
    kind: "DeliveryObserved",
    assistantMessageId: "wrong-message",
  })).toEqual({
    kind: "rejected_unchanged",
    reason: {
      kind: "delivery_message_mismatch",
      expectedMessageId: "expected-message",
      observedMessageId: "wrong-message",
    },
  });

  expect(decideTransition(turn, {
    kind: "DeliveryObserved",
    assistantMessageId: "expected-message",
  })).toEqual({
    kind: "accepted",
    transition: {
      kind: "observe_delivery",
      successor: "delivered",
      assistantMessageId: "expected-message",
    },
  });
});

test("Goal Contract Review returns a typed revision to Conception", () => {
  const product = {} as never;
  expect(decideTransition(turnIn("contract_review"), {
    kind: "GoalContractRevisionRequested",
    product,
  })).toEqual({
    kind: "accepted",
    transition: {
      kind: "request_goal_revision",
      successor: "conception_deliberation",
      product,
    },
  });
});

test("a closed promotion frontier returns to final Consolidation", () => {
  const turn = turnIn("work_frontier");
  turn.managed = {
    program: {
      ledgerId: "ledger-final-promotion",
      programId: "program-final-promotion",
      manifestRevision: 12,
    } as never,
  };

  expect(decideTransition(turn, {
    kind: "PromotionFrontierClosed",
    closure: { kind: "promoted" },
  })).toMatchObject({
    kind: "accepted",
    transition: {
      kind: "complete_promoted_work",
      successor: "consolidation",
      ledgerCommit: {
        mutation: {
          kind: "close_promotion_frontier",
          cursor: {
            ledgerId: "ledger-final-promotion",
            programId: "program-final-promotion",
            expectedManifestRevision: 12,
          },
        },
      },
    },
  });
});

test("runtime hands a rejected internal event to recovery without committing it", async () => {
  const turn = turnIn("delivery_committed");
  const claim: StateExecutionClaim = {
    claimId: "claim-7",
    turnId: turn.turnId,
    turnRevision: turn.revision,
    semanticState: turn.semanticState,
    checkpointId: "checkpoint-7",
    checkpointRevision: 3,
    executionFence: turn.executionFence,
  };
  let commits = 0;
  const turns: TurnStateRepository = {
    async findTurn() { return turn; },
    async activateCommittedSuccessor() { return turn; },
    async acquireStateExecutionClaim() { return claim; },
    async commitTransition() { commits += 1; },
    async stopTurn() { throw new Error("not used"); },
  };
  const dependencies = {
    turns,
    messages: {
      async insertCanonicalAssistantMessage() {
        return { messageId: "wrong-message" };
      },
    },
    admission: null as never,
    phaseConversations: null as never,
    model: null as never,
    operations: null as never,
    artifacts: null as never,
    retrospective: null as never,
  } satisfies BtccRuntimeDependencies;

  try {
    await createBtccTurnRuntime(dependencies).runTurn({ kind: "resume", turnId: turn.turnId });
    throw new Error("expected operational interruption");
  } catch (error) {
    expect(isBtccOperationalInterruption(error)).toBe(true);
    if (!isBtccOperationalInterruption(error)) throw error;
    expect(error.code).toBe("turn_transition_rejected_delivery_message_mismatch");
    expect(error.anchor as unknown).toEqual({
      turnId: turn.turnId,
      turnRevision: turn.revision,
      semanticState: "delivery_committed",
      checkpointId: claim.checkpointId,
      checkpointRevision: claim.checkpointRevision,
      claimId: claim.claimId,
      executionFence: claim.executionFence,
    });
    expect(error.activation).toEqual({ kind: "runtime_remediation" });
  }

  expect(commits).toBe(0);
  expect(turn.semanticState).toBe("delivery_committed");
  expect(turn.revision).toBe(7);
});

test("runtime normalizes a post-claim persistence defect before it reaches ingress", async () => {
  const turn = turnIn("admitted");
  const claim: StateExecutionClaim = {
    claimId: "claim-persistence",
    turnId: turn.turnId,
    turnRevision: turn.revision,
    semanticState: turn.semanticState,
    checkpointId: turn.checkpoint!.checkpointId,
    checkpointRevision: turn.checkpoint!.checkpointRevision,
    executionFence: turn.executionFence,
  };
  const turns: TurnStateRepository = {
    async findTurn() { return turn; },
    async activateCommittedSuccessor() { return turn; },
    async acquireStateExecutionClaim() { return claim; },
    async commitTransition() { throw new Error("project publication defect"); },
    async stopTurn() { throw new Error("not used"); },
  };
  const dependencies = {
    turns,
    admission: null as never,
    phaseConversations: null as never,
    model: null as never,
    operations: null as never,
    artifacts: null as never,
    messages: null as never,
    retrospective: null as never,
  } satisfies BtccRuntimeDependencies;

  await expect(createBtccTurnRuntime(dependencies).runTurn({
    kind: "resume",
    turnId: turn.turnId,
  })).rejects.toMatchObject({
    name: "OperationalInterruptionError",
    code: "runtime_unclassified_interruption",
    activation: { kind: "runtime_remediation" },
    anchor: { claimId: claim.claimId, checkpointId: claim.checkpointId },
  });
});

test("post-commit storage recovery activates the successor without replaying its predecessor", async () => {
  const turn = turnIn("admitted");
  const successor = {
    ...turn,
    semanticState: "conception_opening" as const,
    checkpoint: {
      checkpointId: "checkpoint-successor",
      checkpointRevision: 0,
      kind: "phase" as const,
      semanticState: "conception_opening" as const,
    },
    revision: turn.revision + 1,
  };
  const claim: StateExecutionClaim = {
    claimId: "claim-post-commit",
    turnId: turn.turnId,
    turnRevision: turn.revision,
    semanticState: turn.semanticState,
    checkpointId: turn.checkpoint!.checkpointId,
    checkpointRevision: turn.checkpoint!.checkpointRevision,
    executionFence: turn.executionFence,
  };
  let claims = 0;
  let commits = 0;
  let activations = 0;
  let readinessWaits = 0;
  const notices: string[] = [];
  const sqliteLock = Object.assign(new Error("database is locked"), {
    name: "SQLiteError",
  });
  const turns: TurnStateRepository = {
    async findTurn() { return successor; },
    async activateCommittedSuccessor() {
      activations += 1;
      if (activations === 1) throw sqliteLock;
      return successor;
    },
    async acquireStateExecutionClaim() {
      claims += 1;
      return claim;
    },
    async commitTransition() { commits += 1; },
    async stopTurn() { throw new Error("not used"); },
  };
  const dependencies = {
    turns,
    committedSuccessorReadiness: {
      async waitForStorageReadiness() { readinessWaits += 1; },
    },
    progress: {
      async stateChanged() {},
      async operationalNoticeChanged(update) { notices.push(update.status); },
    },
    admission: null as never,
    phaseConversations: null as never,
    model: null as never,
    operations: null as never,
    artifacts: null as never,
    messages: null as never,
    retrospective: null as never,
  } satisfies BtccRuntimeDependencies;

  await expect(advanceTurn(
    turn,
    dependencies,
    createTurnExecutionSupervisor(),
  )).resolves.toEqual(successor);

  expect({ claims, commits, activations, readinessWaits }).toEqual({
    claims: 1,
    commits: 1,
    activations: 2,
    readinessWaits: 1,
  });
  expect(notices).toEqual(["recovering", "cleared"]);
});

test("a normalized persistence interruption retains canonical Stop ownership", async () => {
  const turn = turnIn("admitted");
  const claim: StateExecutionClaim = {
    claimId: "claim-owned-persistence",
    turnId: turn.turnId,
    turnRevision: turn.revision,
    semanticState: turn.semanticState,
    checkpointId: turn.checkpoint!.checkpointId,
    checkpointRevision: turn.checkpoint!.checkpointRevision,
    executionFence: turn.executionFence,
  };
  let capturedCode = "";
  const notices: string[] = [];
  let recoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
  const turns: TurnStateRepository = {
    async findTurn() { return turn; },
    async activateCommittedSuccessor() { return turn; },
    async acquireStateExecutionClaim() { return claim; },
    async commitTransition() { throw new Error("project publication defect"); },
    async stopTurn() {
      turn.semanticState = "cancelled";
      turn.revision += 1;
      return { kind: "cancelled", turnId: turn.turnId };
    },
  };
  const dependencies = {
    turns,
    operationalRecovery: {
      async awaitReentry(interruption, signal) {
        capturedCode = interruption.code;
        recoveryStarted();
        await new Promise((_, reject) => signal.addEventListener(
          "abort", () => reject(new Error("stopped")), { once: true },
        ));
      },
      async pending() { return null; },
      async resolve() { return false; },
      async pendingTurnIds() { return []; },
    },
    progress: {
      async stateChanged() {},
      async operationalNoticeChanged(update) { notices.push(update.status); },
    },
    admission: null as never,
    phaseConversations: null as never,
    model: null as never,
    operations: null as never,
    artifacts: null as never,
    messages: null as never,
    retrospective: null as never,
  } satisfies BtccRuntimeDependencies;
  const runtime = createBtccTurnRuntime(dependencies);
  const running = runtime.runTurn({ kind: "resume", turnId: turn.turnId });

  await started;
  expect(capturedCode).toBe("runtime_unclassified_interruption");
  expect(notices).toEqual(["interrupted"]);
  expect(await runtime.stopTurn({ kind: "stop", turnId: turn.turnId })).toEqual({
    kind: "cancelled",
    turnId: turn.turnId,
  });
  expect(await running).toEqual({ kind: "cancelled", turnId: turn.turnId });
});

function turnIn(semanticState: TurnSemanticState): TurnRecord {
  return {
    turnId: "turn-total-reducer",
    sessionId: "session-total-reducer",
    inboxId: "inbox-total-reducer",
    triggerKey: "trigger-total-reducer",
    originalMessageId: "message-user",
    originalMessage: "Complete the accepted work.",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: {},
      controlsHash: "controls-hash",
    },
    context: {
      userRef: "user-1",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
    continuationCandidates: [],
    semanticState,
    checkpoint: {
      checkpointId: "checkpoint-7",
      checkpointRevision: 3,
      kind: "runtime",
      semanticState,
    },
    finalPayload: {
      ref: { id: "payload-1", sha256: "payload-hash" },
      content: "Completed.",
      contentSha256: "payload-hash",
    },
    deliveryOutbox: {
      outboxId: "outbox-1",
      finalPayloadRef: { id: "payload-1", sha256: "payload-hash" },
      expectedMessageId: "expected-message",
      content: "Completed.",
      status: "inserted",
    },
    revision: 7,
    executionFence: 2,
  };
}
