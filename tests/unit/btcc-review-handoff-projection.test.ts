import { expect, test } from "bun:test";
import { contentRef } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { projectDirectSuccessorHandoffs } from
  "../../packages/butler-agent/src/agent/btcc/review/project-successor-handoffs.ts";
import { projectAcceptedPredecessorHandoffs } from
  "../../packages/butler-agent/src/agent/btcc/review/project-predecessor-handoffs.ts";
import type { ReviewedManagedProgramState } from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";

test("Review projects only direct successor verification ownership", () => {
  const currentRef = contentRef("task", { id: "implementation" });
  const testRef = contentRef("task", { id: "tests" });
  const unrelatedRef = contentRef("task", { id: "unrelated" });
  const criterion = {
    ref: contentRef("criterion", { id: "tests-pass" }),
    ordinal: 1,
    taskLogicalId: "TASK-TESTS",
    statement: "Persistent regression tests pass.",
    sourceGoalFieldIds: ["intended_result" as const],
    sourceRequiredOutcomeRefs: ["required-outcome:test"],
  };
  const question = {
    ref: contentRef("verification-question", { id: "tests-pass" }),
    criterionRef: criterion.ref,
    question: "Do the persistent regression tests pass?",
  };
  const program = {
    currentTask: { task: { ref: currentRef } },
    currentWork: { work: { taskRefs: [currentRef, testRef, unrelatedRef] } },
    tasks: [
      { task: { ref: currentRef, dependencyTaskRefs: [], executionOrdinal: 1 } },
      {
        task: {
          ref: testRef,
          taskLogicalId: "TASK-TESTS",
          intendedOutcome: "Own persistent regression tests.",
          executionOrdinal: 2,
          dependencyTaskRefs: [currentRef],
          artifactPolicy: {
            kind: "workspace_artifact",
            workspaceScopeRef: "workspace:test",
            workspacePath: ".",
            mutationScope: {
              kind: "contained_paths",
              writablePaths: ["tests/feature.test.ts"],
            },
            baselinePolicy: "capture_at_workspace_provision",
          },
          criterionRefs: [criterion.ref],
          verificationQuestionRefs: [question.ref],
        },
      },
      {
        task: {
          ref: unrelatedRef,
          dependencyTaskRefs: [],
          executionOrdinal: 3,
        },
      },
    ],
    criteria: [criterion],
    verificationQuestions: [question],
  } as unknown as ReviewedManagedProgramState;

  expect(projectDirectSuccessorHandoffs(program)).toEqual([{
    taskRef: testRef,
    taskLogicalId: "TASK-TESTS",
    intendedOutcome: "Own persistent regression tests.",
    executionOrdinal: 2,
    artifactPolicy: expect.objectContaining({
      mutationScope: {
        kind: "contained_paths",
        writablePaths: ["tests/feature.test.ts"],
      },
    }),
    criteria: [criterion],
    verificationQuestions: [question],
  }]);
});

test("Review receives each direct predecessor's accepted result and review", () => {
  const predecessorRef = contentRef("task", { id: "implementation" });
  const currentRef = contentRef("task", { id: "validation" });
  const predecessorResult = { result: { ref: contentRef("result", { id: "implementation" }) } };
  const predecessorReview = {
    review: { ref: contentRef("review", { id: "implementation" }), verdict: "passed" },
  };
  const program = {
    currentTask: { task: { ref: currentRef, dependencyTaskRefs: [predecessorRef] } },
    tasks: [
      {
        task: { ref: predecessorRef, taskLogicalId: "TASK-IMPLEMENTATION" },
        status: "accepted",
        currentResult: predecessorResult,
        currentReview: predecessorReview,
      },
      { task: { ref: currentRef, dependencyTaskRefs: [predecessorRef] } },
    ],
  } as unknown as ReviewedManagedProgramState;

  const [handoff] = projectAcceptedPredecessorHandoffs(program);
  expect(handoff?.task.ref).toEqual(predecessorRef);
  expect(handoff?.result.ref).toEqual(predecessorResult.result.ref);
  expect(handoff?.review.ref).toEqual(predecessorReview.review.ref);
});
