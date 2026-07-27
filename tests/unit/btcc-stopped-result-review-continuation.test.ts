import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteWorkLedgerStorage } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/work-ledger/index.ts";
import { discoverContinuationCandidates } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { review } from "../../packages/butler-agent/src/agent/btcc/review/review.ts";
import { taskReviewAuthority } from "../../packages/butler-agent/src/agent/btcc/review/source-authority.ts";
import { work } from "../../packages/butler-agent/src/agent/btcc/work/work.ts";
import { acceptedGoalFixture, bindAndContinue, freshContinuationCommand } from "./support/btcc-stopped-work-fixture.ts";
import { seedResultSubmittedStoppedProgram, seedSingleResultSubmittedStoppedProgram, seedSingleWorkspaceResultSubmittedStoppedProgram } from "./support/btcc-stopped-result-fixture.ts";

test("stopped ResultCandidate resumes the exact Task at Review without Execution", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const stopped = storage.loadProgram(continuation.programId);
  if (!stopped || stopped.planningState !== "reviewed") throw new Error("Reviewed Program expected");
  const prior = stopped.currentTask;
  expect(prior.status).toBe("result_submitted");

  bindAndContinue(storage, continuation);

  const resumed = storage.loadProgram(continuation.programId);
  if (!resumed || resumed.planningState !== "reviewed") throw new Error("Reviewed Program expected");
  expect(resumed.currentTask.task.ref).toEqual(prior.task.ref);
  expect(resumed.currentTask.attempts.at(-1)?.attemptRecord.ref)
    .toEqual(prior.attempts.at(-1)?.attemptRecord.ref);
  expect(resumed.currentTask.currentResult?.result.ref).toEqual(prior.currentResult?.result.ref);
  expect(resumed.currentTask.currentResult?.result.operationResultRefs).toHaveLength(2);
  expect(resumed.currentTask.currentResult?.result.resultSummary.content)
    .toContain("exactly once");
  const result = resumed.currentTask.currentResult?.result;
  if (!result) throw new Error("Current ResultCandidate expected");
  expect(taskReviewAuthority({
    baseline: {
      observationScopeRefs: ["baseline:review"],
      mutation: { kind: "forbidden" },
    },
    result,
  })).toEqual({
    observationScopeRefs: [
      "baseline:review",
      "operation-result:read:first",
      "operation-result:read:second",
    ],
    mutation: { kind: "forbidden" },
  });
  const event = await work({
    turn: {
      turnId: "turn-fresh-continuation",
      revision: 9,
      semanticState: "work_frontier",
      managed: { program: resumed },
    } as never,
    artifacts: new Proxy({}, {
      get() { throw new Error("Execution artifact preparation must not run"); },
    }) as never,
  });
  expect(event).toEqual({ kind: "WorkTaskReadyForReview" });
  db.close();
});

test("a one-Task stopped ResultCandidate permits an empty continuation Plan", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedSingleResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const before = storage.loadProgram(continuation.programId);
  if (!before || before.planningState !== "reviewed") throw new Error("Reviewed Program expected");

  bindAndContinue(storage, continuation);

  const after = storage.loadProgram(continuation.programId);
  if (!after || after.planningState !== "reviewed") throw new Error("Reviewed Program expected");
  expect(after.tasks).toHaveLength(1);
  expect(after.works).toHaveLength(1);
  expect(after.currentTask.task.ref).toEqual(before.currentTask.task.ref);
  expect(after.currentTask.status).toBe("result_submitted");
  expect(after.currentTask.currentResult?.result.ref).toEqual(before.currentTask.currentResult?.result.ref);
  const reviewEvent = await review({
    turn: {
      turnId: "turn-fresh-continuation",
      revision: 10,
      semanticState: "task_review",
      checkpoint: { checkpointId: "checkpoint-resumed-review" },
      managed: {
        program: after,
        goalAcceptance: acceptedGoalFixture(),
      },
    } as never,
    phase: reviewPhase(after) as never,
  });
  expect(reviewEvent.kind).toBe("TaskReviewFailed");
  if (reviewEvent.kind !== "TaskReviewFailed") throw new Error("Failed Review expected");
  expect(reviewEvent.product.review.findings[0]?.statement)
    .toContain("two completed operation results");
  db.close();
});

test("a stopped workspace ResultCandidate preserves lifecycle authority through Review", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedSingleWorkspaceResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const before = storage.loadProgram(continuation.programId);
  if (!before || before.planningState !== "reviewed") throw new Error("Reviewed Program expected");

  bindAndContinue(storage, continuation);

  const after = storage.loadProgram(continuation.programId);
  if (!after || after.planningState !== "reviewed") throw new Error("Reviewed Program expected");
  expect(after.plan.ref).toEqual(before.plan.ref);
  expect(after.artifactLifecycle.ref).toEqual(before.artifactLifecycle.ref);
  expect(after.currentTask.task.ref).toEqual(before.currentTask.task.ref);
  expect(after.currentTask.attempts.at(-1)?.attemptRecord.ref)
    .toEqual(before.currentTask.attempts.at(-1)?.attemptRecord.ref);
  expect(after.currentTask.currentResult?.result.ref).toEqual(before.currentTask.currentResult?.result.ref);
  const event = await review({
    turn: {
      turnId: "turn-fresh-continuation",
      revision: 10,
      semanticState: "task_review",
      checkpoint: { checkpointId: "checkpoint-resumed-review" },
      managed: { program: after, goalAcceptance: acceptedGoalFixture() },
    } as never,
    phase: reviewPhase(after) as never,
  });
  expect(event.kind).toBe("TaskReviewFailed");
  db.close();
});

function reviewPhase(
  program: Extract<NonNullable<ReturnType<SqliteWorkLedgerStorage["loadProgram"]>>, {
    planningState: "reviewed";
  }>,
) {
  const result = program.currentTask.currentResult?.result;
  const criterionRef = program.currentTask.task.criterionRefs[0];
  if (!result || !criterionRef) throw new Error("Review fixture authority expected");
  const identity = {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    controlsHash: "fresh-controls-hash",
  };
  const operationResults = result.operationResultRefs.map((resultRef, index) => ({
    resultRef,
    requestRef: { id: `read-request-${index}`, sha256: `read-request-${index}-sha` },
    requestId: `read-${index}`,
    request: {
      requestId: `read-${index}`,
      publicTitle: "Read immutable operation result",
      kind: "observe",
      capabilityRef: "read_operation_result",
      scopeRef: result.operationResultReadScopeRefs[index],
      input: { resultRef },
    },
    capabilityRef: "read_operation_result",
    outcome: "observed",
    completeness: "complete",
    byteLength: 24,
    observationRef: { id: `read-observation-${index}`, sha256: `read-observation-${index}-sha` },
    preview: `completed occurrence ${index + 1}`,
    content: `completed occurrence ${index + 1}`,
    omittedBytes: 0,
    readScopeRef: result.operationResultReadScopeRefs[index],
  }));
  const binding = {
    turnId: "turn-fresh-continuation",
    turnRevision: 10,
    semanticState: "task_review",
    checkpointId: "checkpoint-resumed-review",
    checkpointRevision: 1,
    claimId: "claim-resumed-review",
    executionFence: 1,
  };
  return {
    binding,
    modelSelection: identity,
    context: {
      originalMessageId: "message-fresh-continuation",
      originalMessage: "Continue the work",
      sessionId: "session-fixture",
      userRef: "user:fixture",
      profileRefs: [], recentFeedbackRefs: [], mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [], baselineObservationScopeRefs: [],
    },
    store: {
      restore: async () => ({ binding, acceptedProduct: null, operationResults }),
      appendOperationRound: async () => { throw new Error("unexpected operation round"); },
      appendOperationResults: async () => { throw new Error("unexpected operation results"); },
      appendPhaseSubmission: async ({ binding: current }: { binding: typeof binding }) => ({
        ...current, checkpointRevision: current.checkpointRevision + 1,
      }),
      acceptPhaseProduct: async ({ binding: current }: { binding: typeof binding }) => ({
        ...current, checkpointRevision: current.checkpointRevision + 1,
      }),
    },
    model: {
      runRound: async (envelope: {
        operationAuthority: {
          observationScopeRefs: string[];
          mutation: { kind: string; reviewSourceRef?: { id: string; sha256: string } };
        };
      }) => {
        expect([...new Set(envelope.operationAuthority.observationScopeRefs)]).toEqual(
          result.operationResultReadScopeRefs,
        );
        if (result.kind === "workspace_artifact") {
          expect(envelope.operationAuthority.mutation).toEqual({
            kind: "validation_overlay_only",
            reviewSourceRef: result.workspaceRevisionRef,
          });
        }
        return {
          kind: "phase_submission",
          submission: {
            kind: "task_review",
            criterionVerdicts: [{
              criterionRef,
              observation: "Two immutable completed operation results contradict exactly-once.",
              verdict: "not_satisfied",
            }],
            findings: [{
              rootCauseKey: "false-exactly-once-claim",
              affectedCriterionRefs: [criterionRef],
              findingCategory: "implementation_nonconformance",
              finding: "The summary claims exactly once, but two completed operation results exist.",
              priority: "P0",
              scopeRelation: "current_task",
              recommendedDisposition: "required_now",
              dispositionRationale: "The immutable evidence contradicts the submitted summary.",
              findingOrigin: "initial_review",
            }],
          },
          actualIdentity: identity,
        };
      },
    },
    operations: { perform: async () => { throw new Error("unexpected operation request"); } },
    operationAuthority: { observationScopeRefs: [], mutation: { kind: "forbidden" } },
    executionPermit: {
      signal: new AbortController().signal,
      assertActive() {},
    },
  };
}

