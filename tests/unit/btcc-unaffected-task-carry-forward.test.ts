import { expect, test } from "bun:test";
import { preserveUnaffectedTaskDrafts } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-revision/preserve-unaffected-tasks.ts";
import type { PlanningCandidate } from
  "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

test("materializes an unaffected Task from the accepted Plan", () => {
  const acceptedPlan = stableAcceptedPlan();
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

test("inserts an omitted unaffected Task without asking the model to rewrite it", () => {
  const preserved = preserveUnaffectedTaskDrafts({
    revisedPlan: {
      strategy: "Repair only the affected Task.",
      works: [{ logicalId: "W-MAIN", outcome: "Complete the work.", tasks: [] }],
    },
    impactMap: [{
      priorTaskLogicalId: "T-STABLE",
      disposition: "unaffected",
      successorTaskLogicalId: "T-STABLE",
      reason: "This Task is outside the correction.",
    }],
    acceptedPlan: stableAcceptedPlan(),
  });

  expect((preserved.works as Array<{ tasks: unknown[] }>)[0]?.tasks).toHaveLength(1);
});

test("restores an omitted Work that owns an unaffected Task", () => {
  const preserved = preserveUnaffectedTaskDrafts({
    revisedPlan: { strategy: "Repair another Work.", works: [] },
    impactMap: [{
      priorTaskLogicalId: "T-STABLE",
      disposition: "unaffected",
      successorTaskLogicalId: "T-STABLE",
      reason: "The accepted Work remains unchanged.",
    }],
    acceptedPlan: stableAcceptedPlan(),
  });

  expect(preserved.works).toMatchObject([{
    logicalId: "W-MAIN",
    outcome: "Complete the accepted behavior.",
    dependencyWorkIds: [],
    tasks: [{ logicalId: "T-STABLE" }],
  }]);
});

test("does not reinsert an unaffected historical Task outside the current accepted Plan", () => {
  const revisedPlan = {
    strategy: "Repair the current Plan only.",
    works: [{ logicalId: "W-MAIN", outcome: "Complete the work.", tasks: [] }],
  };
  const preserved = preserveUnaffectedTaskDrafts({
    revisedPlan,
    impactMap: [{
      priorTaskLogicalId: "T-HISTORICAL",
      disposition: "unaffected",
      successorTaskLogicalId: "T-HISTORICAL",
      reason: "The accepted historical result remains valid.",
    }],
    acceptedPlan: stableAcceptedPlan(),
  });

  expect(preserved).toEqual(revisedPlan);
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

function stableAcceptedPlan(): PlanningCandidate {
  return {
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
    works: [{
      ref: ref("work-main"),
      workLogicalId: "W-MAIN",
      outcome: "Complete the accepted behavior.",
      dependencyWorkRefs: [],
      taskRefs: [ref("task-stable")],
    }],
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
}
