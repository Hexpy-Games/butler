import { describe, expect, test } from "bun:test";
import { authorPlanningProposal } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import { artifactTask } from "./support/btcc-planning-fixture.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

describe("BTCC Planning path diagnostics", () => {
  test("identifies an absolute workspacePath instead of blaming promotion targetPath", () => {
    const submission = artifactPlan();
    const policy = submission.works[0]!.tasks[0]!.artifactPolicy!;
    if (policy.kind !== "workspace_artifact") throw new Error("expected workspace policy");
    policy.workspacePath = "/Users/example/project";

    expect(finding(authorPlanningProposal(submission, authoringState()))).toEqual({
      code: "artifact_workspace_path_invalid",
      message: expect.stringContaining("workspacePath must be relative"),
    });
  });

  test("identifies promotion and writable path categories independently", () => {
    const promotion = artifactPlan();
    const promotionPolicy = promotion.works[0]!.tasks[2]!.artifactPolicy!;
    if (promotionPolicy.kind !== "repository_promotion") {
      throw new Error("expected promotion policy");
    }
    promotionPolicy.targetPath = "/Users/example/project";
    expect(finding(authorPlanningProposal(promotion, authoringState())).code)
      .toBe("artifact_promotion_target_invalid");

    const mutation = artifactPlan();
    const mutationPolicy = mutation.works[0]!.tasks[0]!.artifactPolicy!;
    if (mutationPolicy.kind !== "workspace_artifact" ||
      mutationPolicy.mutationScope.kind !== "contained_paths") {
      throw new Error("expected contained mutation policy");
    }
    mutationPolicy.mutationScope.writablePaths = ["../outside"];
    expect(finding(authorPlanningProposal(mutation, authoringState())).code)
      .toBe("artifact_writable_path_invalid");
  });
});

function finding(candidate: ReturnType<typeof authorPlanningProposal>) {
  if (!("validationFindings" in candidate)) throw new Error("expected Planning draft");
  return candidate.validationFindings[0]!;
}

function authoringState() {
  return {
    ledgerId: "ledger-1",
    programId: "program-1",
    observedManifestRevision: 1,
    goalContractRef: ref("goal"),
    authorityRef: ref("authority"),
    governingSpecRefs: [ref("spec")],
    requiredOutcomeId: "required-outcome-1",
    artifactPersistence: "required" as const,
    workspaceScopeRef: "workspace:/repo",
    specParentRootId: "project-1",
  };
}

function artifactPlan() {
  return {
    strategy: "Implement, integrate, and promote once.",
    works: [{
      logicalId: "feature",
      outcome: "The feature is complete.",
      dependencyWorkIds: [],
      tasks: [
        artifactTask("implement", [], "request", "workspace_artifact"),
        artifactTask("integrate", ["implement"], "intended_result", "workspace_artifact"),
        artifactTask("promote", ["implement", "integrate"], "request", "repository_promotion"),
      ],
    }],
    risks: [],
    assumptions: [],
    effectIntents: [{
      occurrenceKey: "promote-once",
      taskId: "promote",
      actionKind: "repository_promotion" as const,
      action: "Promote the reviewed target.",
      payload: "The complete reviewed snapshot.",
      desiredOutcome: "The target equals the reviewed snapshot.",
      sourceGoalFieldIds: ["request"] as Array<"request" | "intended_result">,
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
    }],
    integrationCriteria: [{
      logicalId: "compatible",
      statement: "The complete target is compatible.",
      sourceGoalFieldIds: ["request"] as Array<"request" | "intended_result">,
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
      participatingTaskIds: ["implement", "integrate"],
      integrationTaskId: "integrate",
      promotionTaskId: "promote",
      observableCompatibility: "The complete isolated checks pass.",
    }],
    promotionSelectors: [{
      implementationTaskIds: ["implement"],
      integrationTaskId: "integrate",
      promotionTaskId: "promote",
    }],
  };
}
