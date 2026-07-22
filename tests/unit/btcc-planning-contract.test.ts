import { describe, expect, test } from "bun:test";
import {
  authorPlanCandidate,
  authorPlanningProposal,
} from "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import { reviewPlan } from "../../packages/butler-agent/src/agent/btcc/planning/review-plan.ts";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type { PlanningCandidate } from "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";
import {
  feedbackPlanReviewSubmissionSchema,
  planCandidateSubmissionSchema,
} from
  "../../packages/butler-agent/src/agent/btcc/planning/submission-schemas.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

describe("BTCC Planning contract", () => {
  test("binds existing Specs by schema-constrained logical ID and governs authored Specs automatically", () => {
    const existing = ref("spec-existing-revision");
    const selected = authorPlanCandidate({
      ...artifactPlan(),
      governingSpecSelections: ["SPEC-EXISTING"],
    }, {
      ...authoringState(),
      availableSpecs: [{
        logicalId: "SPEC-EXISTING",
        title: "Existing contract",
        status: "specified",
        revisionRef: existing,
      }],
    });
    expect(selected.governingSpecRefs).toEqual([existing]);

    const authored = authorPlanCandidate({
      ...artifactPlan(),
      specifications: [{
        logicalId: "SPEC-AUTHORED",
        title: "Authored contract",
        body: "The requested behavior is normative.",
      }],
    }, authoringState());
    expect(authored.governingSpecRefs).toEqual(authored.authoredSpecRevisionRefs);

    const schema = JSON.stringify(planCandidateSubmissionSchema(["SPEC-EXISTING"]));
    expect(schema).toContain('"enum":["SPEC-EXISTING"]');
  });

  test("constrains feedback review findings by verdict before decoding", () => {
    const schema = JSON.stringify(feedbackPlanReviewSubmissionSchema);
    expect(schema).toContain('"const":"accepted"');
    expect(schema).toContain('"maxItems":0');
    expect(schema).toContain('"const":"revision_required"');
    expect(schema).toContain('"minItems":1');
  });
  test("authors exact risks, assumptions, effects, integration, and contained artifact targets", () => {
    const candidate = authorPlanCandidate(artifactPlan(), authoringState());

    expect(candidate.risks).toHaveLength(1);
    expect(candidate.assumptions).toHaveLength(1);
    expect(candidate.effectIntents).toHaveLength(1);
    expect(candidate.integrationCriteria).toHaveLength(1);
    expect(candidate.artifactLifecycle.effectIntentRefs)
      .toEqual(candidate.effectIntents.map((effect) => effect.ref));
    expect(candidate.artifactLifecycle.integrationCriterionRefs)
      .toEqual(candidate.integrationCriteria.map((criterion) => criterion.ref));

    const promotion = candidate.tasks.find((task) => task.taskLogicalId === "promote")!;
    expect(promotion.artifactPolicy).toEqual({
      kind: "repository_promotion",
      targetPath: "packages/feature",
      targetScopeRef: "workspace:/repo/packages/feature",
    });
    const promotionBinding = candidate.artifactLifecycle.taskPolicies
      .find((binding) => binding.taskRef.id === promotion.ref.id)!;
    expect(promotionBinding.effectIntentRefs).toEqual([candidate.effectIntents[0]!.ref]);
    expect(candidate.integrationCriteria[0]!.sourceGoalFieldIds)
      .toEqual(["request", "intended_result"]);
    expect(candidate.integrationCriteria[0]!.participatingTaskRefs)
      .toEqual(candidate.tasks.slice(0, 2).map((task) => task.ref));
    expect(contentRef("acceptance-criterion", withoutRef(candidate.criteria[0]!)))
      .toEqual(candidate.criteria[0]!.ref);
    expect(contentRef("planning-candidate-bundle", withoutRef(candidate.bundle)))
      .toEqual(candidate.bundle.ref);
  });

  test("rejects missing or duplicate task-bound EffectIntents", () => {
    const missing = artifactPlan();
    missing.effectIntents = [];
    expect(() => authorPlanCandidate(missing, authoringState()))
      .toThrow("External-effect Task has no EffectIntent");

    const duplicate = artifactPlan();
    duplicate.effectIntents.push({ ...duplicate.effectIntents[0]! });
    expect(() => authorPlanCandidate(duplicate, authoringState()))
      .toThrow("Effect occurrence key is not unique");

    const dangling = artifactPlan();
    dangling.effectIntents[0]!.taskId = "missing";
    expect(() => authorPlanCandidate(dangling, authoringState()))
      .toThrow("Planning reference has no Task: missing");
  });

  test("rejects dangling integration refs and incompatible promotion targets", () => {
    const dangling = artifactPlan();
    dangling.integrationCriteria[0]!.participatingTaskIds = ["implement", "missing"];
    expect(() => authorPlanCandidate(dangling, authoringState()))
      .toThrow("Planning reference has no Task: missing");

    const mismatched = artifactPlan();
    const integration = mismatched.works[0]!.tasks[1]!;
    if (integration.artifactPolicy?.kind === "workspace_artifact") {
      integration.artifactPolicy.targetPath = "packages/other";
    }
    expect(() => authorPlanCandidate(mismatched, authoringState()))
      .toThrow("Dependent artifact Tasks must share the exact workspace target");
  });

  test("rejects absolute and escaping artifact targets", () => {
    for (const targetPath of ["/tmp/outside", "../outside", "safe/../outside"]) {
      const submission = artifactPlan();
      const task = submission.works[0]!.tasks[0]!;
      if (task.artifactPolicy?.kind === "workspace_artifact") {
        task.artifactPolicy.targetPath = targetPath;
      }
      expect(() => authorPlanCandidate(submission, authoringState())).toThrow("targetPath");
    }
  });

  test("accepts the exact admitted workspace root for one cohesive lifecycle", () => {
    const submission = artifactPlan();
    for (const task of submission.works[0]!.tasks) {
      if (task.artifactPolicy) task.artifactPolicy.targetPath = ".";
    }
    const candidate = authorPlanCandidate(submission, authoringState());

    expect(candidate.tasks.map((task) => task.artifactPolicy)).toEqual([
      expect.objectContaining({ targetScopeRef: "workspace:/repo", targetPath: "." }),
      expect.objectContaining({ targetScopeRef: "workspace:/repo", targetPath: "." }),
      expect.objectContaining({ targetScopeRef: "workspace:/repo", targetPath: "." }),
    ]);
  });

  test("rejects dependency edges that cannot materialize predecessor workspace bytes", () => {
    const differentTarget = artifactPlan();
    differentTarget.works[0]!.tasks[1]!.artifactPolicy!.targetPath = "packages/other";
    expect(() => authorPlanCandidate(differentTarget, authoringState()))
      .toThrow("Dependent artifact Tasks must share the exact workspace target");

    const nonArtifactSuccessor = artifactPlan();
    const integration = nonArtifactSuccessor.works[0]!.tasks[1]!;
    Reflect.deleteProperty(integration, "artifactPolicy");
    Reflect.set(integration, "targetScopeRefs", ["workspace:/repo"]);
    expect(() => authorPlanCandidate(nonArtifactSuccessor, authoringState()))
      .toThrow("must continue on an artifact target");
  });

  test("binds runtime-owned refs without asking the reviewer to echo them", async () => {
    const candidate = authorPlanCandidate(artifactPlan(), authoringState());
    const accepted = await reviewPlan(reviewInvocation(candidate, {
      kind: "planning_review", verdict: "accepted", findings: [],
    }));
    expect(accepted.kind).toBe("planning_accepted");
    if (accepted.kind !== "planning_accepted") throw new Error("expected accepted plan");
    expect(accepted.review.reviewedEffectIntentRefs)
      .toEqual(candidate.effectIntents.map((effect) => effect.ref));
    expect(accepted.review.reviewedIntegrationCriterionRefs)
      .toEqual(candidate.integrationCriteria.map((item) => item.ref));
  });

  test("routes a structurally invalid proposal through Planning Review revision", async () => {
    const submission = artifactPlan();
    submission.integrationCriteria[0]!.participatingTaskIds = ["implement"];
    const draft = authorPlanningProposal(submission, authoringState());
    expect("validationFindings" in draft).toBe(true);
    if (!("validationFindings" in draft)) throw new Error("expected Planning draft");

    const reviewed = await reviewPlan(reviewInvocation(draft, {
      kind: "planning_review",
      verdict: "revision_required",
      findings: ["Align the participating Task set with the promotion selector."],
    }));
    expect(reviewed.kind).toBe("planning_revision_required");
    if (reviewed.kind !== "planning_revision_required") throw new Error("expected revision");
    expect(reviewed.review.findings.join("\n")).toContain("planned_graph_mismatch");
  });
});

function authoringState() {
  return {
    ledgerId: "ledger-1",
    programId: "program-1",
    observedManifestRevision: 1,
    goalContractRef: ref("goal"),
    authorityRef: ref("authority"),
    governingSpecRefs: [ref("spec")],
    requiredOutcomeId: "required-outcome-1",
    workspaceScopeRef: "workspace:/repo",
  };
}

function artifactPlan() {
  return {
    strategy: "Implement in isolation, integrate, then promote once.",
    works: [{
      logicalId: "feature",
      outcome: "The requested feature is complete in the target package.",
      dependencyWorkIds: [],
      tasks: [
        artifactTask("implement", [], "request", "workspace_artifact"),
        artifactTask("integrate", ["implement"], "intended_result", "workspace_artifact"),
        artifactTask("promote", ["implement", "integrate"], "request", "repository_promotion"),
      ],
    }],
    risks: [{
      logicalId: "compatibility",
      statement: "The package may have callers outside its directory.",
      affectedTaskIds: ["integrate"],
      mitigation: "Run integration checks before promotion.",
    }],
    assumptions: [{
      logicalId: "target-present",
      statement: "The admitted package target exists.",
      affectedTaskIds: ["implement"],
      validationQuestion: "Does the package target exist in the baseline?",
      invalidationConsequence: "Defer without mutating the original target.",
    }],
    effectIntents: [{
      occurrenceKey: "promote-feature-once",
      taskId: "promote",
      actionKind: "repository_promotion" as const,
      action: "Replace the reviewed package target.",
      payload: "The complete reviewed package snapshot.",
      desiredOutcome: "The original package equals the reviewed snapshot.",
      sourceGoalFieldIds: ["request", "intended_result"] as Array<"request" | "intended_result">,
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
    }],
    integrationCriteria: [{
      logicalId: "package-compatible",
      statement: "The complete package remains compatible with its callers.",
      sourceGoalFieldIds: ["request", "intended_result"] as Array<"request" | "intended_result">,
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
      participatingTaskIds: ["implement", "integrate"],
      integrationTaskId: "integrate",
      promotionTaskId: "promote",
      observableCompatibility: "The isolated integration checks pass for the complete package.",
    }],
    promotionSelectors: [{
      implementationTaskIds: ["implement"],
      integrationTaskId: "integrate",
      promotionTaskId: "promote",
    }],
  };
}

function artifactTask(
  logicalId: string,
  dependencyTaskIds: string[],
  goalField: "request" | "intended_result",
  kind: "workspace_artifact" | "repository_promotion",
) {
  return {
    logicalId,
    intendedOutcome: `${logicalId} outcome`,
    dependencyTaskIds,
    targetScopeRefs: [],
    effectClass: kind === "repository_promotion" ? "external_effect" as const : "none" as const,
    artifactPolicy: { kind, targetPath: "packages/feature" },
    criteria: [{
      statement: `${logicalId} is complete.`,
      question: `Is ${logicalId} complete?`,
      sourceGoalFieldIds: [goalField],
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
    }],
  };
}

function reviewInvocation(
  candidate: PlanningCandidate | ReturnType<typeof authorPlanningProposal>,
  submission: Record<string, unknown>,
) {
  const modelSelection = {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low" as const,
    controls: { reasoningEffort: "low" },
    controlsHash: "controls-sha",
  };
  return {
    binding: {
      turnId: "turn-1", turnRevision: 1, semanticState: "planning_review" as const,
      checkpointId: "checkpoint-1", checkpointRevision: 1, claimId: "claim-1",
      executionFence: 1,
    },
    modelSelection,
    context: {
      originalMessageId: "message-1", originalMessage: "implement feature",
      sessionId: "session-1", userRef: "user-1", profileRefs: [], recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [], optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/repo"],
      stateInput: { planCandidate: { kind: "plan_candidate", candidate } },
    },
    store: {
      restore: async (binding: any) => ({ binding, acceptedProduct: null, operationResults: [] }),
      appendOperationRound: async () => { throw new Error("unexpected operation round"); },
      appendOperationResults: async () => { throw new Error("unexpected operation results"); },
      appendPhaseSubmission: async ({ binding }: any) => ({
        ...binding,
        checkpointRevision: binding.checkpointRevision + 1,
      }),
      acceptPhaseProduct: async ({ binding }: any) => ({
        ...binding,
        checkpointRevision: binding.checkpointRevision + 1,
      }),
    },
    model: {
      runRound: async () => ({
        kind: "phase_submission" as const,
        submission,
        actualIdentity: modelSelection,
      }),
    },
    operations: { perform: async () => { throw new Error("unexpected operation"); } },
    operationAuthority: { observationScopeRefs: [], mutation: { kind: "forbidden" as const } },
    executionPermit: {
      signal: new AbortController().signal,
      assertActive() {},
      close() {},
    },
  };
}

function withoutRef<T extends { ref: { id: string; sha256: string } }>(record: T): Omit<T, "ref"> {
  const { ref: _ref, ...body } = record;
  return body;
}
