import { describe, expect, test } from "bun:test";
import { contentRef } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type { PhaseInvocation } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { proposePlan } from
  "../../packages/butler-agent/src/agent/btcc/planning/propose-plan.ts";
import { reviewPlan } from
  "../../packages/butler-agent/src/agent/btcc/planning/review-plan.ts";
import { planningReviewSubjects } from
  "../../packages/butler-agent/src/agent/btcc/planning/review-subjects.ts";
import type {
  PlanningCandidate,
  PlanningReview,
} from "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";

describe("BTCC Planning Review convergence", () => {
  test("materializes independent Tasks on one dependency frontier", async () => {
    const product = await proposePlan(planningInvocation(planSubmission()));
    const candidate = requireCandidate(requirePlanProduct(product));

    expect(candidate.tasks.map((task) => ({
      task: task.taskLogicalId,
      ordinal: task.executionOrdinal,
    }))).toEqual([
      { task: "inspect-evidence", ordinal: 1 },
      { task: "inspect-production-path", ordinal: 1 },
      { task: "classify-status", ordinal: 2 },
    ]);
  });

  test("persists the revised structured candidate into frozen-finding re-review", async () => {
    const continuation = {
      kind: "deferred_goal",
      ref: ref("continuation-binding"),
      sourceTurnId: "source-turn",
      anchorRef: ref("deferred-anchor"),
    };
    const authored = requireCandidate(
      requirePlanProduct(await proposePlan(planningInvocation(
        planSubmission(),
        { continuation },
      ))),
    );
    const rejected = capturedSequentialCandidate(authored);
    const initialReview = await rejectOrdinalMismatch(rejected);
    const finding = initialReview.findingSet!.findings[0]!;

    const revisedProduct = await proposePlan(planningInvocation(planSubmission(), {
      previousPlanCandidate: rejected,
      previousCandidateRef: rejected.ref,
      findingSetRef: initialReview.findingSetRef,
      priorPlanningReview: initialReview,
      continuation,
    }, [{
      findingId: finding.ref.id,
      decision: "apply_now",
      rationale: "Keep both dependency-free investigations on the first frontier.",
    }]));
    const revised = requireCandidate(requirePlanProduct(revisedProduct));

    expect(revised.revisionOrigin).toEqual({
      kind: "deferred_continuation",
      continuationBindingRef: continuation.ref,
      sourceTurnId: continuation.sourceTurnId,
      deferredAnchorRef: continuation.anchorRef,
    });
    expect(revised.reviewRevision).toMatchObject({
      previousCandidateRef: rejected.ref,
      findingSetRef: initialReview.findingSetRef,
    });
    expect(revised.tasks.map((task) => task.executionOrdinal)).toEqual([1, 1, 2]);
    expect(revised.tasks[1]!.ref).not.toEqual(rejected.tasks[1]!.ref);

    const accepted = await reviewPlan(reviewInvocation(revised, {
      kind: "planning_review",
      verdict: "accepted",
      findings: [],
      priorFindingVerdicts: [{
        rootCauseKey: finding.rootCauseKey,
        verdict: "resolved",
        observation: "Both independent investigations now share frontier ordinal 1.",
      }],
    }, initialReview));

    expect(accepted.kind).toBe("planning_accepted");
    if (accepted.kind !== "planning_accepted") throw new Error("expected accepted Plan");
    expect(accepted.candidate.ref).toEqual(revised.ref);
    expect(accepted.review.findingVerdicts).toEqual([{
      findingRef: finding.ref,
      verdict: "resolved",
      observation: "Both independent investigations now share frontier ordinal 1.",
    }]);
  });

  test("leaves unchanged finding judgment to the semantic re-review", async () => {
    const candidate = requireCandidate(
      requirePlanProduct(await proposePlan(planningInvocation(planSubmission()))),
    );
    const initialReview = await rejectOrdinalMismatch(candidate);
    const finding = initialReview.findingSet!.findings[0]!;

    await expect(proposePlan(planningInvocation(planSubmission(), {
      previousPlanCandidate: candidate,
      previousCandidateRef: candidate.ref,
      findingSetRef: initialReview.findingSetRef,
      priorPlanningReview: initialReview,
    }, [{
      findingId: finding.ref.id,
      decision: "apply_now",
      rationale: "Apply the frozen correction.",
    }]))).resolves.toMatchObject({ kind: "plan_candidate" });
  });
});

async function rejectOrdinalMismatch(candidate: PlanningCandidate): Promise<PlanningReview> {
  const subjects = planningReviewSubjects(candidate).map((subject) => ({
    subjectId: subject.subjectId,
    verdict: subject.subjectId === "task:inspect-evidence" ||
        subject.subjectId === "task:inspect-production-path"
      ? "failed" as const
      : "passed" as const,
  }));
  const coverage = reviewDimensions().map((dimension) => ({
    dimension,
    verdict: dimension === "dependencies" ? "failed" as const : "passed" as const,
  }));
  const product = await reviewPlan(reviewInvocation(candidate, {
    kind: "planning_review",
    verdict: "revision_required",
    coverage,
    subjects,
    findings: [{
      rootCauseKey: "independent-investigation-frontier",
      affectedSubjectIds: ["task:inspect-evidence", "task:inspect-production-path"],
      dimension: "dependencies",
      message: "Independent investigations must share the same first frontier.",
      priority: "P1",
      scopeRelation: "current_plan",
      recommendedDisposition: "required_now",
      dispositionRationale: "The structured graph contradicts the accepted parallel frontier.",
      findingOrigin: "initial_review",
    }],
  }));
  if (product.kind !== "planning_revision_required") throw new Error("expected revision");
  return product.review as PlanningReview;
}

function capturedSequentialCandidate(candidate: PlanningCandidate): PlanningCandidate {
  const second = candidate.tasks[1]!;
  const revisedSecond = {
    ...second,
    executionOrdinal: 2,
    ref: contentRef("task", { ...withoutRef(second), executionOrdinal: 2 }),
  };
  return {
    ...candidate,
    ref: contentRef("plan-candidate", { captured: "sequential-runtime-authority" }),
    tasks: [candidate.tasks[0]!, revisedSecond, candidate.tasks[2]!],
  };
}

function planSubmission(findingDecisions?: unknown[]) {
  const task = (logicalId: string, dependencies: string[]) => ({
    logicalId,
    intendedOutcome: `${logicalId} is inspected without mutation.`,
    dependencyTaskIds: dependencies,
    targetScopeRefs: ["workspace:/repo"],
    effectClass: "none" as const,
    criteria: [{
      statement: `${logicalId} produces current evidence.`,
      question: `Did ${logicalId} produce current evidence?`,
      sourceGoalFieldIds: ["request", "intended_result"] as const,
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
    }],
  });
  return {
    kind: "plan_candidate",
    strategy: "Inspect two independent sources, then classify their combined status.",
    works: [{
      logicalId: "readonly-closeout",
      outcome: "The current status is classified from two independent observations.",
      dependencyWorkIds: [],
      tasks: [
        task("inspect-evidence", []),
        task("inspect-production-path", []),
        task("classify-status", ["inspect-evidence", "inspect-production-path"]),
      ],
    }],
    risks: [], assumptions: [], effectIntents: [], integrationCriteria: [],
    specifications: [], governingSpecSelections: [], promotionSelectors: [],
    ...(findingDecisions ? { findingDecisions } : {}),
  };
}

function planningInvocation(
  submission: Record<string, unknown>,
  revision: Record<string, unknown> = {},
  findingDecisions?: unknown[],
): PhaseInvocation {
  return invocation("planning", {
    ...submission,
    ...(findingDecisions ? { findingDecisions } : {}),
  }, {
    goalContractRef: ref("goal"), authorityRef: ref("authority"),
    requiredOutcomeId: "required-outcome-1", artifactPersistence: "not_required",
    ledgerId: "ledger-1", programId: "program-1", observedManifestRevision: 1,
    governingSpecRefs: [], availableSpecs: [], requireGoverningSpec: false,
    priorPlanningObservationResultIndex: [], ...revision,
  });
}

function reviewInvocation(
  candidate: PlanningCandidate,
  submission: Record<string, unknown>,
  priorPlanningReview?: PlanningReview,
): PhaseInvocation {
  return invocation("planning_review", submission, {
    planCandidate: { kind: "plan_candidate", candidate, observationResultIndex: [] },
    ...(priorPlanningReview ? { priorPlanningReview } : {}),
  });
}

function invocation(
  phase: "planning" | "planning_review",
  submission: Record<string, unknown>,
  stateInput: Record<string, unknown>,
): PhaseInvocation {
  const modelSelection = {
    provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "low" as const,
    controls: {}, controlsHash: "controls-hash",
  };
  const binding = {
    turnId: "turn-planning-convergence", turnRevision: 1, semanticState: phase,
    checkpointId: `checkpoint-${phase}`, checkpointRevision: 1,
    claimId: "claim-1", executionFence: 1,
  };
  return {
    binding, modelSelection,
    context: {
      originalMessageId: "message-1", originalMessage: "Close the work read-only.",
      sessionId: "session-1", userRef: "user-1", profileRefs: [], recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [], optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/repo"], stateInput,
    },
    store: {
      async restore() { return { binding, acceptedProduct: null, operationResults: [] }; },
      async appendOperationRound() { throw new Error("unexpected operation"); },
      async appendOperationResults() { throw new Error("unexpected operation result"); },
      async appendProviderProductRejection({ binding: current }) {
        return { ...current, checkpointRevision: current.checkpointRevision + 1 };
      },
      async appendPhaseSubmission({ binding: current }) {
        return { ...current, checkpointRevision: current.checkpointRevision + 1 };
      },
      async acceptPhaseProduct({ binding: current }) {
        return { ...current, checkpointRevision: current.checkpointRevision + 1 };
      },
    },
    model: { async runRound() {
      return { kind: "phase_submission" as const, submission, actualIdentity: modelSelection };
    } },
    operations: { async perform() { throw new Error("unexpected operation"); } },
    operationAuthority: { observationScopeRefs: [], mutation: { kind: "forbidden" } },
    executionPermit: {
      signal: new AbortController().signal, assertActive() {}, close() {},
    },
  };
}

function reviewDimensions() {
  return [
    "original_goal", "governing_specs", "work_cohesion", "task_executability",
    "dependencies", "verification_integration", "effect_authority", "artifact_lifecycle",
  ] as const;
}

function requireCandidate(candidate: PlanningCandidate | { kind: "planning_draft" }): PlanningCandidate {
  if ("kind" in candidate) throw new Error("expected materialized candidate");
  return candidate;
}

function requirePlanProduct(
  product: Awaited<ReturnType<typeof proposePlan>>,
): PlanningCandidate | { kind: "planning_draft" } {
  if (product.kind !== "plan_candidate") throw new Error("expected Planning candidate");
  return product.candidate;
}

function ref(id: string) { return { id, sha256: `${id}-sha` }; }

function withoutRef<T extends { ref: unknown }>(value: T): Omit<T, "ref"> {
  const { ref: _ref, ...body } = value;
  return body;
}
