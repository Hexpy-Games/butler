import { expect, test } from "bun:test";
import { preserveUnaffectedTaskDrafts } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-revision/preserve-unaffected-tasks.ts";
import type { PlanningCandidate } from
  "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

test("materializes an unaffected Task from the accepted Plan", () => {
  const acceptedPlan = {
    tasks: [{
      ref: ref("task-stable"),
      taskLogicalId: "T-STABLE",
      workLogicalId: "W-MAIN",
      intendedOutcome: "Preserve the accepted behavior.",
      dependencyTaskRefs: [],
      effectClass: "none",
      targetScopeRefs: ["workspace:/repo"],
      artifactPolicy: {
        kind: "workspace_artifact",
        workspaceScopeRef: "workspace:/repo",
        workspacePath: ".",
        mutationScope: { kind: "contained_paths", writablePaths: ["src"] },
        baselinePolicy: "capture_at_workspace_provision",
      },
      criterionRefs: [ref("criterion-stable")],
      verificationQuestionRefs: [ref("question-stable")],
    }],
    works: [{ workLogicalId: "W-MAIN" }],
    criteria: [{
      ref: ref("criterion-stable"),
      statement: "The accepted behavior remains unchanged.",
      sourceGoalFieldIds: ["request"],
      sourceRequiredOutcomeRefs: ["required-outcome"],
    }],
    verificationQuestions: [{
      ref: ref("question-stable"),
      criterionRef: ref("criterion-stable"),
      question: "Does the behavior remain unchanged?",
    }],
  } as unknown as PlanningCandidate;
  const revisedPlan = {
    works: [{
      logicalId: "W-MAIN",
      tasks: [{
        logicalId: "T-STABLE",
        intendedOutcome: "Accidentally rewritten wording.",
        criteria: [{ statement: "Accidentally rewritten criterion." }],
      }],
    }],
  };

  const preserved = preserveUnaffectedTaskDrafts({
    revisedPlan,
    impactMap: [{
      priorTaskLogicalId: "T-STABLE",
      disposition: "unaffected",
      successorTaskLogicalId: "T-STABLE",
      reason: "This Task is outside the governing correction.",
    }],
    acceptedPlan,
  });
  const works = preserved.works as Array<{ tasks: Array<Record<string, unknown>> }>;
  const task = works[0]!.tasks[0]!;

  expect(task.intendedOutcome).toBe("Preserve the accepted behavior.");
  expect(task.criteria).toEqual([{
    statement: "The accepted behavior remains unchanged.",
    question: "Does the behavior remain unchanged?",
    sourceGoalFieldIds: ["request"],
    sourceRequiredOutcomeRefs: ["required-outcome"],
  }]);
  expect(task.artifactPolicy).toEqual({
    kind: "workspace_artifact",
    workspacePath: ".",
    mutationScope: { kind: "contained_paths", writablePaths: ["src"] },
  });
});

test("does not silently move an unaffected Task to another Work", () => {
  const acceptedPlan = {
    tasks: [{
      ref: ref("task-stable"),
      taskLogicalId: "T-STABLE",
      workLogicalId: "W-ORIGINAL",
    }],
    works: [],
    criteria: [],
    verificationQuestions: [],
  } as unknown as PlanningCandidate;

  expect(() => preserveUnaffectedTaskDrafts({
    revisedPlan: {
      works: [{ logicalId: "W-MOVED", tasks: [{ logicalId: "T-STABLE" }] }],
    },
    impactMap: [{
      priorTaskLogicalId: "T-STABLE",
      disposition: "unaffected",
    }],
    acceptedPlan,
  })).toThrow("Unaffected Task T-STABLE must remain in Work W-ORIGINAL");
});
