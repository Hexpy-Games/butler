import { expect, test } from "bun:test";
import { projectFeedbackPlanningContext } from
  "../../packages/butler-agent/src/agent/btcc/planning/feedback-planning-context.ts";
import { feedbackPlanSubmissionSchema } from
  "../../packages/butler-agent/src/agent/btcc/planning/submission-schemas.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

test("implementation repair projects only the exact current correction authority", () => {
  const fixture = feedbackFixture("implementation_repair");
  const context = projectFeedbackPlanningContext(fixture);
  const serialized = JSON.stringify(context);

  expect(context.currentTask).toEqual(fixture.program.currentTask.task);
  expect(context.correctionSource).toEqual(fixture.program.currentTask.currentReview);
  expect(context.governingSpecs).toEqual([fixture.program.governingSpecs[0]]);
  expect(context.reviewValidationSource).toEqual(
    fixture.program.currentTask.currentResult.result.workspaceRevision,
  );
  expect(serialized).not.toContain("UNRELATED_RESULT_BODY");
  expect(serialized).not.toContain("FULL_ACCEPTED_PLAN");
  expect(context).not.toHaveProperty("taskImpactIndex");
  expect(context).not.toHaveProperty("availableSpecs");
});

test("governing revision projects the accepted Plan and compact all-Task impact index", () => {
  const fixture = feedbackFixture("governing_revision");
  const context = projectFeedbackPlanningContext(fixture);
  const index = context.taskImpactIndex as Array<Record<string, unknown>>;

  expect(context.acceptedPlan).toEqual(fixture.managed.planningAcceptance.candidate);
  expect(index).toHaveLength(11);
  expect(index[0]).toEqual({
    task: { ref: ref("task-1"), taskLogicalId: "task-1" },
    status: "accepted",
    hasCurrentResult: true,
  });
  expect(JSON.stringify(index)).not.toContain("UNRELATED_RESULT_BODY");
});

test("implementation repair schema cannot request a replacement Program", () => {
  const schema = feedbackPlanSubmissionSchema([], "implementation_repair");
  const serialized = JSON.stringify(schema);

  expect(serialized).toContain("implementation_repair");
  expect(serialized).not.toContain("governing_revision");
  expect(serialized).not.toContain("revisedPlan");
  expect(serialized).not.toContain("impactMap");
});

function feedbackFixture(
  correctionKind: "implementation_repair" | "governing_revision",
): any {
  const tasks = Array.from({ length: 11 }, (_, index) => ({
    task: {
      ref: ref(`task-${index + 1}`),
      taskLogicalId: `task-${index + 1}`,
      governingSpecRefs: index === 4 ? [ref("spec-current")] : [ref("spec-other")],
    },
    status: index < 4 ? "accepted" : index === 4 ? "review_failed" : "planned",
    attempts: [],
    currentResult: index === 4
      ? {
          result: {
            kind: "workspace_artifact",
            workspaceRevisionRef: ref("current-workspace-revision"),
            workspaceRevision: {
              ref: ref("current-workspace-revision"),
              workspaceRef: ref("current-workspace"),
              targetSnapshotRef: ref("current-snapshot"),
            },
          },
        }
      : index < 4
        ? { result: `UNRELATED_RESULT_BODY_${index}_${"x".repeat(10_000)}` }
        : undefined,
    currentReview: index === 4 ? { review: { findings: ["idempotency defect"] } } : undefined,
  }));
  const program = {
    planningState: "reviewed",
    ledgerId: "ledger-1",
    programId: "program-1",
    manifestRevision: 7,
    goalContractRef: ref("goal"),
    authorityRef: ref("authority"),
    requiredOutcomeId: "outcome-1",
    plan: { ref: ref("plan") },
    works: [{ work: { ref: ref("work"), workLogicalId: "work-1" }, status: "active" }],
    currentWork: { work: { ref: ref("work"), workLogicalId: "work-1" }, status: "active" },
    tasks,
    currentTask: tasks[4],
    governingSpecRefs: [ref("spec-current"), ref("spec-other")],
    governingSpecs: [
      { logicalId: "SPEC-CURRENT", revisionRef: ref("spec-current"), body: "current body" },
      { logicalId: "SPEC-OTHER", revisionRef: ref("spec-other"), body: "other body" },
    ],
    availableSpecs: [],
    artifactLifecycle: {
      ref: ref("lifecycle"),
      taskPolicies: tasks.map((state) => ({
        taskRef: state.task.ref,
        policy: { kind: "non_artifact", targetScopeRefs: [] },
        effectIntentRefs: [],
      })),
    },
  };
  const managed = {
    feedbackIntent: {
      kind: "feedback_intent",
      feedbackIntent: {
        ref: ref("feedback-intent"),
        correctionScopeRef: ref("correction-scope"),
        correctionKind,
      },
    },
    planningAcceptance: {
      candidate: { marker: `FULL_ACCEPTED_PLAN_${"p".repeat(100_000)}` },
    },
  };
  const accepted = {
    goalContract: { artifactPersistence: "required" },
    authority: {
      ledgerScope: { kind: "project", projectRef: "project-1" },
    },
  };
  return { accepted, managed, program };
}
