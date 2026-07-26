import { expect, test } from "bun:test";
import { projectTaskOutcomes } from
  "../../packages/butler-agent/src/agent/btcc/consolidation/project-task-outcomes.ts";
import type { ManagedTaskState } from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

test("Consolidation projects accepted outcomes without replaying Attempt history", () => {
  const outcomes = projectTaskOutcomes([{
    task: {
      ref: ref("task"),
      taskLogicalId: "task-logical",
      intendedOutcome: "The accepted outcome remains traceable to the Task contract.",
    },
    status: "accepted",
    attempts: [{ transcript: "ATTEMPT_HISTORY_MUST_NOT_REACH_CONSOLIDATION" }],
    currentResult: {
      result: {
        ref: ref("result"),
        kind: "workspace_artifact",
        resultSummary: { ref: ref("summary"), content: "Material outcome summary" },
        unresolvedConditionRefs: [],
        artifactRevisionRefs: [ref("artifact")],
        effectReceiptRefs: [],
        workspaceRevisionRef: ref("workspace-revision"),
        operationResultRefs: [ref("raw-operation")],
      },
    },
    currentReview: {
      review: {
        ref: ref("review"),
        verdict: "passed",
        criterionVerdicts: [{ criterionRef: ref("criterion"), verdict: "satisfied" }],
        observations: [{ ref: ref("observation"), description: "Reviewed outcome" }],
      },
    },
  } as unknown as ManagedTaskState]);

  expect(outcomes as unknown).toEqual([{
    task: expect.objectContaining({ taskLogicalId: "task-logical" }),
    status: "accepted",
    result: {
      ref: ref("result"),
      kind: "workspace_artifact",
      resultSummary: { ref: ref("summary"), content: "Material outcome summary" },
      unresolvedConditionRefs: [],
      artifactRevisionRefs: [ref("artifact")],
      effectReceiptRefs: [],
      workspaceRevisionRef: ref("workspace-revision"),
    },
    review: {
      ref: ref("review"),
      verdict: "passed",
      criterionVerdicts: [{ criterionRef: ref("criterion"), verdict: "satisfied" }],
      observations: [{ ref: ref("observation"), description: "Reviewed outcome" }],
    },
  }]);
  expect(JSON.stringify(outcomes)).not.toContain("ATTEMPT_HISTORY_MUST_NOT_REACH_CONSOLIDATION");
  expect(JSON.stringify(outcomes)).not.toContain("raw-operation");
});

test("Consolidation rejects a Task without an accepted Review boundary", () => {
  expect(() => projectTaskOutcomes([{
    task: { ref: ref("task") },
    status: "result_submitted",
    attempts: [],
    currentResult: { result: { ref: ref("result") } },
  } as unknown as ManagedTaskState])).toThrow(
    "Consolidation requires an accepted result and passed Review per Task",
  );
});
