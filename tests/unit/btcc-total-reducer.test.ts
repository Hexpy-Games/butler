import { expect, test } from "bun:test";
import {
  createBtccTurnRuntime,
  isBtccOperationalInterruption,
  type BtccRuntimeDependencies,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";
import {
  decideTransition,
  type StateExecutionClaim,
  type TurnEvent,
  type TurnRecord,
  type TurnSemanticState,
  type TurnStateRepository,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";

const semanticStates = [
  "admitted",
  "conception_opening",
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
    await createBtccTurnRuntime(dependencies).handle({ kind: "resume", turnId: turn.turnId });
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
