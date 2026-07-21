import {
  contentRef,
  requireRecord,
  requireStringArray,
  runPhaseConversation,
  stableJson,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  PlanningCandidateProduct,
  PlanningReviewProduct,
} from "./contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "planning_review",
  objective: "independently_review_the_exact_complete_plan_graph",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_exact_candidate_bytes", "review_goal_coverage",
    "review_work_cohesion", "review_task_executability", "review_dependencies",
    "review_verification_completeness", "review_effect_authority",
    "review_every_task_artifact_policy", "request_revision_when_needed",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair", "no_partial_graph_acceptance",
  ],
};

const codec: PhaseCodec<PlanningReviewProduct> = {
  decode(submission, envelope) {
    const candidate = loadCandidate(envelope.context.stateInput);
    const value = requireRecord(submission, "Planning Review submission");
    if (value.kind !== "planning_review") throw new Error("Planning Review kind is invalid");
    if (value.verdict !== "accepted" && value.verdict !== "revision_required") {
      throw new Error("Planning Review verdict is invalid");
    }
    assertExactRef(value.candidateRef, candidate.candidate.ref, "candidate");
    assertExactRef(value.reviewedBundleRef, candidate.candidate.bundle.ref, "bundle");
    assertExactRef(value.reviewedWorkGraphRef, candidate.candidate.workGraph.ref, "Work graph");
    assertExactRefs(value.reviewedWorkRefs, candidate.candidate.works.map((item) => item.ref), "Works");
    assertExactRefs(value.reviewedTaskRefs, candidate.candidate.tasks.map((item) => item.ref), "Tasks");
    assertExactRefs(
      value.reviewedCriterionRefs,
      candidate.candidate.criteria.map((item) => item.ref),
      "criteria",
    );
    assertExactRefs(
      value.reviewedVerificationQuestionRefs,
      candidate.candidate.verificationQuestions.map((item) => item.ref),
      "verification questions",
    );
    assertExactRef(
      value.reviewedArtifactLifecycleRef,
      candidate.candidate.artifactLifecycle.ref,
      "artifact lifecycle",
    );
    assertGoalCoverage(value, candidate);
    const findings = requireStringArray(value.findings, "Planning Review findings");
    if (value.verdict === "accepted" && findings.length > 0) {
      throw new Error("Accepted Planning Review cannot carry findings");
    }
    if (value.verdict === "revision_required" && findings.length === 0) {
      throw new Error("Planning revision requires findings");
    }
    const reviewBase = {
      candidateRef: candidate.candidate.ref,
      originalGoalContractRef: candidate.candidate.goalContractRef,
      reviewedBundleRef: candidate.candidate.bundle.ref,
      reviewedWorkGraphRef: candidate.candidate.workGraph.ref,
      reviewedWorkRefs: candidate.candidate.works.map((item) => item.ref),
      reviewedTaskRefs: candidate.candidate.tasks.map((item) => item.ref),
      reviewedCriterionRefs: candidate.candidate.criteria.map((item) => item.ref),
      reviewedVerificationQuestionRefs: candidate.candidate.verificationQuestions.map((item) => item.ref),
      reviewedArtifactLifecycleRef: candidate.candidate.artifactLifecycle.ref,
    };
    if (value.verdict === "accepted") {
      const body = { ...reviewBase, verdict: "accepted" as const, findings: [] as [] };
      return {
        kind: "planning_accepted",
        candidate: candidate.candidate,
        review: { ref: contentRef("planning-review", body), ...body },
      };
    }
    const findingSetRef = contentRef("planning-finding-set", {
      candidateRef: candidate.candidate.ref,
      findings,
    });
    const body = {
      ...reviewBase,
      verdict: "revision_required" as const,
      findings: findings as [string, ...string[]],
      findingSetRef,
    };
    return {
      kind: "planning_revision_required",
      candidate: candidate.candidate,
      review: { ref: contentRef("planning-review", body), ...body },
    };
  },
};

export function reviewPlan(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function loadCandidate(input: unknown): PlanningCandidateProduct {
  const state = requireRecord(input, "Planning Review state");
  const candidate = state.planCandidate as PlanningCandidateProduct | undefined;
  if (candidate?.kind !== "plan_candidate") {
    throw new Error("Planning Review is missing the exact candidate");
  }
  return candidate;
}

function assertGoalCoverage(
  value: Record<string, unknown>,
  candidate: PlanningCandidateProduct,
): void {
  const fieldIds = requireStringArray(value.reviewedGoalFieldIds, "reviewedGoalFieldIds");
  if (stableJson([...new Set(fieldIds)].sort()) !== stableJson(["intended_result", "request"])) {
    throw new Error("Planning Review did not cover every required Goal field");
  }
  const expectedOutcomes = [...new Set(candidate.candidate.criteria.flatMap(
    (criterion) => criterion.sourceRequiredOutcomeRefs,
  ))].sort();
  const outcomes = [...new Set(requireStringArray(
    value.reviewedRequiredOutcomeRefs,
    "reviewedRequiredOutcomeRefs",
  ))].sort();
  if (stableJson(outcomes) !== stableJson(expectedOutcomes)) {
    throw new Error("Planning Review did not cover every required outcome");
  }
}

function assertExactRefs(actual: unknown, expected: ContentRef[], label: string): void {
  if (!Array.isArray(actual) || stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Planning Review did not review the exact ${label}`);
  }
}

function assertExactRef(actual: unknown, expected: ContentRef, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Planning Review did not review the exact ${label}`);
  }
}
