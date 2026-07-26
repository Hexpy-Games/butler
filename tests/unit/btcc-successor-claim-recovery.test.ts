import { expect, test } from "bun:test";
import type { BtccRuntimeDependencies } from "../../packages/butler-agent/src/agent/btcc/contracts.ts";
import { acquireStateExecution } from "../../packages/butler-agent/src/agent/btcc/turn/acquire-state-execution.ts";
import type {
  StateExecutionClaim,
  TurnRecord,
} from "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";

test("successor claim acquisition waits for storage readiness", async () => {
  const events: string[] = [];
  let attempts = 0;
  const turn = successorTurn();
  const expectedClaim: StateExecutionClaim = {
    claimId: "claim-feedback-review",
    turnId: turn.turnId,
    turnRevision: turn.revision,
    semanticState: turn.semanticState,
    checkpointId: turn.checkpoint!.checkpointId,
    checkpointRevision: turn.checkpoint!.checkpointRevision,
    executionFence: turn.executionFence,
  };
  const turns = {
    async findTurn() {
      return turn;
    },
    async activateCommittedSuccessor() {
      return turn;
    },
    async acquireStateExecutionClaim() {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("database is locked"), {
          name: "SQLiteError",
          code: "SQLITE_BUSY",
        });
      }
      events.push("claimed");
      return expectedClaim;
    },
    async commitTransition() {
      throw new Error("transition must not commit");
    },
    async stopTurn() {
      throw new Error("turn must not stop");
    },
  } satisfies BtccRuntimeDependencies["turns"];

  const claim = await acquireStateExecution(
    turn,
    {
      turns,
      committedSuccessorReadiness: {
        async waitForStorageReadiness() {
          events.push("ready");
        },
      },
      progress: {
        async stateChanged() {},
        async operationalNoticeChanged(update) {
          events.push(update.status);
        },
      },
    },
    activePermit(),
  );

  expect(claim).toEqual(expectedClaim);
  expect(events).toEqual(["recovering", "ready", "claimed", "cleared"]);
  expect(attempts).toBe(2);
});

function successorTurn(): TurnRecord {
  return {
    turnId: "turn-feedback-review",
    sessionId: "session-1",
    inboxId: "inbox-1",
    triggerKey: "trigger-1",
    originalMessageId: "message-1",
    originalMessage: "continue the accepted correction",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { reasoningEffort: "low" },
      controlsHash: "controls-sha",
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
    semanticState: "feedback_planning_review",
    checkpoint: {
      checkpointId: "checkpoint-feedback-review",
      checkpointRevision: 1,
      kind: "phase",
      semanticState: "feedback_planning_review",
    },
    route: "managed",
    revision: 26,
    executionFence: 0,
  };
}

function activePermit() {
  return {
    signal: new AbortController().signal,
    assertActive() {},
    close() {},
  };
}
