import { describe, expect, test } from "bun:test";
import {
  authorPlanCandidate,
  authorPlanningProposal,
} from "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import { reviewPlan } from "../../packages/butler-agent/src/agent/btcc/planning/review-plan.ts";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type {
  PlanningCandidate,
  PlanningContinuation,
  PlanningReviewDimension,
} from "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";
import { planningReviewSubjects } from
  "../../packages/butler-agent/src/agent/btcc/planning/review-subjects.ts";
import { requiredSubjectFindingRefs } from
  "../../packages/butler-agent/src/agent/btcc/planning/finding-decisions.ts";
import {
  feedbackPlanReviewSubmissionSchema,
  planCandidateSubmissionSchema,
  planReviewSubmissionSchema,
} from
  "../../packages/butler-agent/src/agent/btcc/planning/submission-schemas.ts";
import { PLANNING_AUTHORING_CONTRACTS } from
  "../../packages/butler-agent/src/agent/btcc/planning/authoring-contracts.ts";
import { preserveAcceptedTaskDrafts } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-revision/preserve-unaffected-tasks.ts";
import { rejectHistoricalTaskReferences } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-revision/reject-historical-task-references.ts";
import { artifactTask } from "./support/btcc-planning-fixture.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

describe("BTCC Planning contract", () => {
  test("injects only current authoring contracts with semantic Task boundaries", () => {
    expect(PLANNING_AUTHORING_CONTRACTS.map((contract) => contract.contractId)).toEqual([
      "SPEC-BTCC-WORK-AUTHORING-CONTRACT",
      "SPEC-BTCC-WORK-LEDGER-STATE-AND-MUTATION-CONTRACT",
    ]);
    expect(PLANNING_AUTHORING_CONTRACTS[0]?.applicableRules.join("\n"))
      .toContain("never collapse a layered feature");
    expect(PLANNING_AUTHORING_CONTRACTS[0]?.applicableRules.join("\n"))
      .toContain("Never encode discovery as a Task inside a graph");
    expect(PLANNING_AUTHORING_CONTRACTS[0]?.applicableRules.join("\n"))
      .toContain("Only an accepted continuation binding");
  });

  test("binds existing Specs by schema-constrained logical ID and governs authored Specs automatically", () => {
    const existing = ref("spec-existing-revision");
    const selected = authorPlanCandidate({
      ...artifactPlan(),
      governingSpecSelections: ["SPEC-EXISTING"],
    }, {
      ...authoringState(),
      governingSpecRefs: [existing],
      availableSpecs: [{
        logicalId: "SPEC-EXISTING",
        parentId: "project-1",
        concernId: "existing-concern",
        title: "Existing contract",
        status: "specified",
        revisionRef: existing,
      }],
    });
    expect(selected.governingSpecRefs).toEqual([existing]);

    expect(() => authorPlanCandidate({
      ...artifactPlan(),
      governingSpecSelections: ["SPEC-EXISTING"],
    }, {
      ...authoringState(),
      governingSpecRefs: [],
      availableSpecs: [{
        logicalId: "SPEC-EXISTING",
        parentId: "project-1",
        concernId: "existing-concern",
        title: "Existing contract",
        status: "specified",
        revisionRef: existing,
      }],
    })).toThrow("governingSpecSelections contains an unavailable Spec");

    const authored = authorPlanCandidate({
      ...artifactPlan(),
      specifications: [{
        logicalId: "SPEC-AUTHORED",
        parentId: "project-1",
        concernId: "authored-concern",
        title: "Authored contract",
        body: "The requested behavior is normative.",
      }],
    }, authoringState());
    expect(authored.governingSpecRefs).toEqual(authored.authoredSpecRevisionRefs);
    expect(authored.authoredSpecs[0]).toMatchObject({
      parentId: "project-1",
      concernId: "authored-concern",
    });

    const schema = JSON.stringify(planCandidateSubmissionSchema(["SPEC-EXISTING"]));
    expect(schema).toContain('"enum":["SPEC-EXISTING"]');
  });

  test("uses one canonical Planning submission shape for optional collections", () => {
    const schema = planCandidateSubmissionSchema(["SPEC-EXISTING"]) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      anyOf?: unknown[];
    };

    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.required).toEqual(expect.arrayContaining([
      "specifications",
      "governingSpecSelections",
      "promotionSelectors",
      "risks",
      "assumptions",
      "effectIntents",
      "integrationCriteria",
    ]));
    expect(schema.properties).toHaveProperty("specifications");
    expect(schema.properties).toHaveProperty("promotionSelectors");
  });

  test("reuses the exact unaffected Task record across a governing Spec revision", () => {
    const accepted = authorPlanCandidate(artifactPlan(), authoringState());
    const revisedSubmission = artifactPlan();
    revisedSubmission.works[0]!.tasks[1]!.intendedOutcome =
      "Integrate the revised governing behavior.";
    const revised = authorPlanCandidate(revisedSubmission, {
      ...authoringState(),
      governingSpecRefs: [ref("spec-v2")],
      preservedPlan: accepted,
      preservedTaskLogicalIds: ["implement"],
    });

    expect(revised.tasks.find((task) => task.taskLogicalId === "implement")?.ref)
      .toEqual(accepted.tasks.find((task) => task.taskLogicalId === "implement")?.ref);
    expect(revised.tasks.find((task) => task.taskLogicalId === "integrate")?.ref)
      .not.toEqual(accepted.tasks.find((task) => task.taskLogicalId === "integrate")?.ref);
    expect(revised.criteria).toEqual(expect.arrayContaining(
      accepted.criteria.filter((criterion) =>
        accepted.tasks[0]!.criterionRefs.some((ref) => ref.id === criterion.ref.id)),
    ));
  });

  test("restores an accepted Task from any provisional Work placement", () => {
    const accepted = authorPlanCandidate(artifactPlan(), authoringState());
    const revised = artifactPlan();
    const acceptedWork = revised.works[0]!;
    const movedTask = acceptedWork.tasks.shift()!;
    revised.works.push({
      logicalId: "provisional",
      outcome: "A provisional model grouping that runtime will normalize.",
      dependencyWorkIds: [],
      tasks: [movedTask],
    });

    const normalized = preserveAcceptedTaskDrafts({
      revisedPlan: revised,
      taskLogicalIds: ["implement"],
      acceptedPlan: accepted,
    }) as typeof revised;

    expect(normalized.works[0]!.tasks[0]!.logicalId).toBe("implement");
    expect(normalized.works[1]!.tasks).toEqual([]);
  });

  test("keeps accepted historical Tasks outside a revised Plan", () => {
    const accepted = authorPlanCandidate(artifactPlan(), authoringState());
    const revised = artifactPlan();
    revised.promotionSelectors[0]!.implementationTaskIds.push("historical-implementation");

    expect(() => rejectHistoricalTaskReferences({
      revisedPlan: revised,
      acceptedPlan: accepted,
      taskImpactIndex: [
        ...accepted.tasks.map((task) => ({ task, status: "planned" })),
        {
          task: { ref: ref("historical"), taskLogicalId: "historical-implementation" },
          status: "accepted",
        },
      ],
    })).toThrow("Historical accepted Task historical-implementation is not current Plan authority");
  });

  test("stopped ResultCandidate Planning exposes only the typed resume decision", () => {
    const schema = planCandidateSubmissionSchema([], [], true) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(schema.required).toEqual(["kind"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["kind"]);
    expect(JSON.stringify(schema)).toContain('"const":"stopped_plan_resume"');
    expect(JSON.stringify(schema)).not.toContain('"works"');
  });

  test("a rejected stopped Plan revision uses the submitted Plan instead of replaying resume", () => {
    const accepted = authorPlanCandidate(artifactPlan(), authoringState());
    const revisedSubmission = artifactPlan();
    revisedSubmission.strategy = "Apply the frozen review findings before continuing.";
    revisedSubmission.works[0]!.tasks[0]!.intendedOutcome =
      "A model rewrite that must not replace a stopped Task dependency.";
    revisedSubmission.works[0]!.tasks[1]!.intendedOutcome =
      "A model rewrite that must not replace the stopped Result Task.";
    revisedSubmission.works[0]!.tasks[1]!.dependencyTaskIds = [];
    const continuation = {
      kind: "stopped_program",
      ref: ref("continuation"),
      sourceTurnId: "turn-stopped",
      anchorRef: ref("stopped-anchor"),
      context: {
        acceptedPlan: accepted,
        frontier: {
          interruptedTask: {
            task: accepted.tasks[1]!,
            resultRef: ref("stopped-result"),
          },
        },
      },
    } as unknown as PlanningContinuation;

    const revised = authorPlanCandidate(revisedSubmission, {
      ...authoringState(),
      continuation,
      previousCandidateRef: accepted.ref,
      findingSetRef: ref("finding-set"),
      findingDecisions: [],
    });

    expect(revised.plan.strategy).toBe(revisedSubmission.strategy);
    expect(revised.reviewRevision?.previousCandidateRef).toEqual(accepted.ref);
    expect(revised.tasks.find((task) => task.taskLogicalId === "implement")?.ref)
      .toEqual(accepted.tasks[0]!.ref);
    expect(revised.tasks.find((task) => task.taskLogicalId === "integrate")?.ref)
      .toEqual(accepted.tasks[1]!.ref);
  });

  test("requires a compact Task display title separately from its full outcome", () => {
    const candidate = authorPlanCandidate(artifactPlan(), authoringState());
    expect(candidate.tasks[0]?.displayTitle).toBe("implement task");
    expect(candidate.tasks[0]?.intendedOutcome).toBe("implement outcome");

    const plan = artifactPlan();
    plan.works[0]!.tasks[0]!.displayTitle = "가".repeat(33);
    expect(() => authorPlanCandidate(plan, authoringState()))
      .toThrow("displayTitle must not exceed 32 Unicode characters");
  });

  test("constrains feedback review findings by priority, scope, and frozen identity", () => {
    const planningRevision = JSON.stringify(
      planReviewSubmissionSchema(["task:one"], ["planning-root-cause-1"]),
    );
    expect(planningRevision).toContain('"priorFindingVerdicts"');
    expect(planningRevision).toContain('"enum":["resolved","unresolved"]');
    expect(planningRevision).toContain('"enum":["planning-root-cause-1"]');
    expect(planningRevision).not.toContain('"const":"initial_review"');
    expect(planningRevision).not.toContain('"coverage"');
    expect(planningRevision).not.toContain('"subjects"');

    const schema = JSON.stringify(feedbackPlanReviewSubmissionSchema([]));
    expect(schema).toContain('"const":"accepted"');
    expect(schema).toContain('"const":"revision_required"');
    expect(schema).toContain('"enum":["P0","P1","P2"]');
    expect(schema).toContain('"const":"required_now"');
    expect(schema).toContain('"const":"backlog"');
    expect(schema).toContain('"const":"initial_review"');

    const revised = JSON.stringify(feedbackPlanReviewSubmissionSchema(["root-cause-1"]));
    expect(revised).toContain('"priorFindingVerdicts"');
    expect(revised).toContain('"enum":["resolved","unresolved"]');
    expect(revised).toContain('"enum":["root-cause-1"]');
    expect(revised).not.toContain('"const":"initial_review"');
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

    const implementation = candidate.tasks.find((task) => task.taskLogicalId === "implement")!;
    const integration = candidate.tasks.find((task) => task.taskLogicalId === "integrate")!;
    expect(implementation.artifactPolicy).toEqual(expect.objectContaining({
      kind: "workspace_artifact",
      workspacePath: "packages/feature",
      workspaceScopeRef: "workspace:/repo/packages/feature",
      mutationScope: { kind: "contained_paths", writablePaths: ["src/feature.ts"] },
    }));
    expect(integration.artifactPolicy).toEqual(expect.objectContaining({
      kind: "workspace_artifact",
      workspaceScopeRef: "workspace:/repo/packages/feature",
      mutationScope: { kind: "read_only" },
    }));

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
    expect(candidate.bundle).not.toHaveProperty("entries");
    expect(JSON.stringify(candidate)).not.toContain("\"semanticBytes\"");
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
      integration.artifactPolicy.workspacePath = "packages/other";
    }
    expect(() => authorPlanCandidate(mismatched, authoringState()))
      .toThrow("Dependent artifact Tasks must share the exact artifact workspace root");
  });

  test("rejects absolute and escaping artifact targets", () => {
    for (const targetPath of ["/tmp/outside", "../outside", "safe/../outside"]) {
      const submission = artifactPlan();
      const task = submission.works[0]!.tasks[0]!;
      if (task.artifactPolicy?.kind === "workspace_artifact") {
        task.artifactPolicy.workspacePath = targetPath;
      }
      expect(() => authorPlanCandidate(submission, authoringState())).toThrow("workspacePath");
    }
  });

  test("accepts the exact admitted workspace root for one cohesive lifecycle", () => {
    const submission = artifactPlan();
    for (const task of submission.works[0]!.tasks) {
      if (task.artifactPolicy?.kind === "workspace_artifact") {
        task.artifactPolicy.workspacePath = ".";
      } else if (task.artifactPolicy) task.artifactPolicy.targetPath = ".";
    }
    const candidate = authorPlanCandidate(submission, authoringState());

    expect(candidate.tasks.map((task) => task.artifactPolicy)).toEqual([
      expect.objectContaining({ workspaceScopeRef: "workspace:/repo", workspacePath: "." }),
      expect.objectContaining({ workspaceScopeRef: "workspace:/repo", workspacePath: "." }),
      expect.objectContaining({ targetScopeRef: "workspace:/repo", targetPath: "." }),
    ]);
  });

  test("rejects dependency edges that cannot materialize predecessor workspace bytes", () => {
    const differentTarget = artifactPlan();
    const policy = differentTarget.works[0]!.tasks[1]!.artifactPolicy!;
    if (policy.kind === "workspace_artifact") policy.workspacePath = "packages/other";
    expect(() => authorPlanCandidate(differentTarget, authoringState()))
      .toThrow("Dependent artifact Tasks must share the exact artifact workspace root");

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
      kind: "planning_review",
      verdict: "accepted",
      coverage: acceptedCoverage(),
      subjects: acceptedSubjects(candidate),
    }));
    expect(accepted.kind).toBe("planning_accepted");
    if (accepted.kind !== "planning_accepted") throw new Error("expected accepted plan");
    expect(accepted.review.reviewedEffectIntentRefs)
      .toEqual(candidate.effectIntents.map((effect) => effect.ref));
    expect(accepted.review.reviewedIntegrationCriterionRefs)
      .toEqual(candidate.integrationCriteria.map((item) => item.ref));
  });

  test("requires one unique verdict for every Planning Review dimension", async () => {
    const candidate = authorPlanCandidate(artifactPlan(), authoringState());
    const duplicate = acceptedCoverage();
    duplicate[7] = { ...duplicate[0]! };
    expect(reviewPlan(reviewInvocation(candidate, {
      kind: "planning_review",
      verdict: "accepted",
      coverage: duplicate,
      subjects: acceptedSubjects(candidate),
    }))).rejects.toThrow("provider_phase_submission_invalid");

    const failed = acceptedCoverage();
    failed[1] = {
      dimension: "governing_specs",
      verdict: "failed",
    };
    const subjects = acceptedSubjects(candidate);
    const plan = subjects.find((item) => item.subjectId === "plan:strategy")!;
    plan.verdict = "failed";
    plan.findings = [{
      dimension: "governing_specs",
      message: "The candidate omits one governing requirement.",
      priority: "P0",
      recommendedDisposition: "required_now",
      findingOrigin: "initial_review",
    }];
    const reviewed = await reviewPlan(reviewInvocation(candidate, {
      kind: "planning_review",
      verdict: "revision_required",
      coverage: failed,
      subjects,
    }));
    expect(reviewed.kind).toBe("planning_revision_required");
    if (reviewed.kind !== "planning_revision_required") throw new Error("expected revision");
    expect(reviewed.review.findings).toEqual([
      "The candidate omits one governing requirement.",
    ]);
    expect(reviewed.review.coverage).toEqual(failed.map((item) => ({
      ...item,
      findings: item.dimension === "governing_specs"
        ? ["The candidate omits one governing requirement."]
        : [],
    })));
  });

  test("rejects finding drip by requiring one judgment for every candidate subject", async () => {
    const candidate = authorPlanCandidate(artifactPlan(), authoringState());
    const incomplete = acceptedSubjects(candidate)
      .filter((item) => !item.subjectId.startsWith("assumption:"));
    expect(reviewPlan(reviewInvocation(candidate, {
      kind: "planning_review",
      verdict: "accepted",
      coverage: acceptedCoverage(),
      subjects: incomplete,
    }))).rejects.toThrow("provider_phase_submission_invalid");

    const subjects = acceptedSubjects(candidate);
    const task = subjects.find((item) => item.subjectId === "task:integrate")!;
    task.verdict = "failed";
    task.findings = [{
      dimension: "task_executability",
      message: "Integration combines independent implementation responsibilities.",
      priority: "P1",
      recommendedDisposition: "required_now",
      findingOrigin: "initial_review",
    }];
    const assumption = subjects.find((item) => item.subjectId === "assumption:target-present")!;
    assumption.verdict = "failed";
    assumption.findings = [{
      dimension: "dependencies",
      message: "The target-presence assumption is unresolved before execution.",
      priority: "P0",
      recommendedDisposition: "required_now",
      findingOrigin: "initial_review",
    }];
    const coverage = acceptedCoverage();
    coverage.find((item) => item.dimension === "task_executability")!.verdict = "failed";
    coverage.find((item) => item.dimension === "dependencies")!.verdict = "failed";

    const reviewed = await reviewPlan(reviewInvocation(candidate, {
      kind: "planning_review",
      verdict: "revision_required",
      coverage,
      subjects,
    }));
    expect(reviewed.kind).toBe("planning_revision_required");
    if (reviewed.kind !== "planning_revision_required") throw new Error("expected revision");
    expect(reviewed.review.findings).toEqual([
      "The target-presence assumption is unresolved before execution.",
      "Integration combines independent implementation responsibilities.",
    ]);
    expect(reviewed.review.reviewedSubjects).toHaveLength(planningReviewSubjects(candidate).length);
  });

  test("freezes one root finding for a correction affecting several subjects", async () => {
    const candidate = authorPlanCandidate(artifactPlan(), authoringState());
    const subjects = acceptedSubjects(candidate);
    const task = subjects.find((item) => item.subjectId === "task:integrate")!;
    const assumption = subjects.find(
      (item) => item.subjectId === "assumption:target-present",
    )!;
    const affectedSubjectIds = [assumption.subjectId, task.subjectId].sort();
    const rootFinding = {
      rootCauseKey: "integration-boundary",
      affectedSubjectIds,
      dimension: "task_executability",
      message: "One missing integration boundary affects the Task and its assumption.",
      priority: "P1" as const,
      recommendedDisposition: "required_now" as const,
      findingOrigin: "initial_review" as const,
    };
    task.verdict = "failed";
    task.findings = [{ ...rootFinding }];
    assumption.verdict = "failed";
    assumption.findings = [{ ...rootFinding }];
    const coverage = acceptedCoverage();
    coverage.find((item) => item.dimension === "task_executability")!.verdict = "failed";

    const reviewed = await reviewPlan(reviewInvocation(candidate, {
      kind: "planning_review",
      verdict: "revision_required",
      coverage,
      subjects,
    }));
    if (reviewed.kind !== "planning_revision_required") throw new Error("expected revision");
    expect(reviewed.review.findingSet.findings).toHaveLength(1);
    expect(reviewed.review.findingSet.findings[0]?.affectedSubjectIds)
      .toEqual(affectedSubjectIds);
    expect(reviewed.review.findings).toEqual([rootFinding.message]);
  });

  test("freezes the first blocker set and gives re-review no new finding surface", async () => {
    const candidate = authorPlanCandidate(artifactPlan(), authoringState());
    const firstSubjects = acceptedSubjects(candidate);
    const original = firstSubjects.find((item) => item.subjectId === "task:integrate")!;
    original.verdict = "failed";
    original.findings = [{
      dimension: "task_executability",
      message: "Integration owns two separable contributions.",
      priority: "P1",
      recommendedDisposition: "required_now",
      findingOrigin: "initial_review",
    }];
    const firstCoverage = acceptedCoverage();
    firstCoverage.find((item) => item.dimension === "task_executability")!.verdict = "failed";
    const first = await reviewPlan(reviewInvocation(candidate, {
      kind: "planning_review",
      verdict: "revision_required",
      coverage: firstCoverage,
      subjects: firstSubjects,
    }));
    if (first.kind !== "planning_revision_required") throw new Error("expected revision");
    if (!first.review.reviewedSubjects) throw new Error("expected reviewed subjects");
    const originalFinding = first.review.reviewedSubjects
      .flatMap((subject) => subject.findings)
      .find((finding) => finding.recommendedDisposition === "required_now")!;
    const revised = authorPlanCandidate(artifactPlan(), {
      ...authoringState(),
      previousCandidateRef: candidate.ref,
      findingSetRef: first.review.findingSetRef,
      findingDecisions: [{
        findingRef: originalFinding.ref,
        decision: "split_to_backlog",
        rationale: "The concern is useful but does not block the requested outcome.",
      }],
    });

    const expanded = acceptedSubjects(revised);
    const unchanged = expanded.find((item) => item.subjectId === "assumption:target-present")!;
    unchanged.verdict = "failed";
    unchanged.findings = [{
      dimension: "dependencies",
      message: "A new blocker was discovered on an unchanged assumption.",
      priority: "P1",
      recommendedDisposition: "required_now",
      findingOrigin: "prior_finding",
      priorFindingId: originalFinding.ref.id,
    }];
    const expandedCoverage = acceptedCoverage();
    expandedCoverage.find((item) => item.dimension === "dependencies")!.verdict = "failed";
    expect(reviewPlan(reviewInvocation(revised, {
      kind: "planning_review",
      verdict: "revision_required",
      coverage: expandedCoverage,
      subjects: expanded,
      priorFindingVerdicts: [{
        rootCauseKey: originalFinding.rootCauseKey,
        verdict: "unresolved",
        observation: "The frozen concern remains unresolved.",
      }],
    }, first.review))).rejects.toThrow("provider_phase_submission_invalid");

    unchanged.verdict = "passed";
    unchanged.findings = [];
    const accepted = await reviewPlan(reviewInvocation(revised, {
      kind: "planning_review",
      verdict: "accepted",
      findings: [],
      priorFindingVerdicts: [{
        rootCauseKey: originalFinding.rootCauseKey,
        verdict: "resolved",
        observation: "The revised plan no longer blocks the requested outcome.",
      }],
    }, first.review));
    expect(accepted.kind).toBe("planning_accepted");
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
      findings: [{
        dimension: "verification_integration",
        message: "Align the participating Task set with the promotion selector.",
        priority: "P1",
        recommendedDisposition: "required_now",
        findingOrigin: "initial_review",
      }],
    }));
    expect(reviewed.kind).toBe("planning_revision_required");
    if (reviewed.kind !== "planning_revision_required") throw new Error("expected revision");
    expect(reviewed.review.findings.join("\n")).toContain("planned_graph_mismatch");
    expect(reviewed.review.findingSet.findings.map((finding) => finding.priority))
      .toEqual(["P0", "P1"]);

    const findingRefs = requiredSubjectFindingRefs(reviewed.review);
    const revised = authorPlanCandidate(artifactPlan(), {
      ...authoringState(),
      previousCandidateRef: draft.ref,
      findingSetRef: reviewed.review.findingSetRef,
      findingDecisions: findingRefs.map((findingRef) => ({
        findingRef,
        decision: "apply_now" as const,
        rationale: "The revised candidate resolves this exact frozen finding.",
      })),
    });
    const accepted = await reviewPlan(reviewInvocation(revised, {
      kind: "planning_review",
      verdict: "accepted",
      findings: [],
      priorFindingVerdicts: reviewed.review.findingSet.findings
        .filter((finding) => finding.recommendedDisposition === "required_now")
        .map((finding) => ({
          rootCauseKey: finding.rootCauseKey,
          verdict: "resolved",
          observation: "The revised candidate resolves this frozen finding.",
        })),
    }, reviewed.review));
    expect(accepted.kind).toBe("planning_accepted");
  });
});

function acceptedCoverage(): Array<{
  dimension: PlanningReviewDimension;
  verdict: "passed" | "failed";
}> {
  const dimensions = [
    "original_goal",
    "governing_specs",
    "work_cohesion",
    "task_executability",
    "dependencies",
    "verification_integration",
    "effect_authority",
    "artifact_lifecycle",
  ] as const;
  return dimensions.map((dimension) => ({
    dimension,
    verdict: "passed",
  }));
}

function acceptedSubjects(candidate: PlanningCandidate) {
  return planningReviewSubjects(candidate).map(({ subjectId }) => ({
    subjectId,
    verdict: "passed" as "passed" | "failed",
    findings: [] as Array<{
      dimension: string;
      message: string;
      priority: "P0" | "P1" | "P2";
      recommendedDisposition: "required_now" | "backlog";
      findingOrigin: "initial_review" | "prior_finding" | "backlog_candidate";
      priorFindingId?: string;
    }>,
  }));
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

function reviewInvocation(
  candidate: PlanningCandidate | ReturnType<typeof authorPlanningProposal>,
  submission: Record<string, unknown>,
  priorPlanningReview?: unknown,
) {
  const normalizedSubmission = normalizeReviewRootFindings(submission);
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
      stateInput: {
        planCandidate: { kind: "plan_candidate", candidate },
        ...(priorPlanningReview ? { priorPlanningReview } : {}),
      },
    },
    store: {
      restore: async (binding: any) => ({ binding, acceptedProduct: null, operationResults: [] }),
      appendOperationRound: async () => { throw new Error("unexpected operation round"); },
      appendOperationResults: async () => { throw new Error("unexpected operation results"); },
      appendProviderProductRejection: async ({ binding }: any) => ({
        ...binding,
        checkpointRevision: binding.checkpointRevision + 1,
      }),
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
        submission: normalizedSubmission,
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

function normalizeReviewRootFindings(
  submission: Record<string, unknown>,
): Record<string, unknown> {
  if (Array.isArray(submission.subjects)) {
    const rootFindings = new Map<string, Record<string, unknown>>();
    const subjects = submission.subjects.map((value) => {
      const subject = value as {
        subjectId: string;
        findings: Array<Record<string, unknown>>;
      };
      subject.findings.forEach((finding) => {
        const rootCauseKey = String(
          finding.rootCauseKey ?? finding.priorFindingId ?? finding.message,
        );
        rootFindings.set(rootCauseKey, {
          rootCauseKey,
          affectedSubjectIds: [subject.subjectId],
          scopeRelation: finding.scopeRelation ?? "current_plan",
          dispositionRationale: finding.dispositionRationale ??
            "The finding is evaluated against the current Plan subject.",
          ...finding,
        });
      });
      const { findings: _findings, ...coverage } = subject;
      return coverage;
    });
    return {
      ...submission,
      findings: [...rootFindings.values()],
      subjects,
    };
  }
  if (Array.isArray(submission.findings)) {
    return {
      ...submission,
      findings: submission.findings.map((value) => {
        const finding = value as Record<string, unknown>;
        return {
          rootCauseKey: finding.message,
          scopeRelation: finding.scopeRelation ?? "current_plan",
          dispositionRationale: finding.dispositionRationale ??
            "The finding is evaluated against the current Plan subject.",
          ...finding,
        };
      }),
    };
  }
  return submission;
}

function withoutRef<T extends { ref: { id: string; sha256: string } }>(record: T): Omit<T, "ref"> {
  const { ref: _ref, ...body } = record;
  return body;
}
