import {
  contentRef,
  requireRecord,
  requireStringArray,
  runPhaseConversation,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  PlanningCandidateProduct,
  PlanningReviewProduct,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import { planReviewSubmissionSchema } from "./submission-schemas.ts";
import { attestReviewedPlanReferences } from "./review-plan-attestation.ts";

const CONTRACT: PhaseContract = {
  phase: "planning_review",
  objective: "independently_review_the_exact_complete_plan_graph",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_plan_exactly", "review_work_cohesion", "review_executability",
    "review_dependencies", "review_verification_integration",
    "review_effect_authority", "review_artifact_lifecycle",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

const codec = withManagedDeferral<PlanningReviewProduct>({
  submissionSchema: planReviewSubmissionSchema,
  decode(submission, envelope) {
    const candidate = loadCandidate(envelope.context.stateInput);
    const value = requireRecord(submission, "Planning Review submission");
    if (value.kind !== "planning_review") throw new Error("Planning Review kind is invalid");
    if (value.verdict !== "accepted" && value.verdict !== "revision_required") {
      throw new Error("Planning Review verdict is invalid");
    }
    const findings = requireStringArray(value.findings, "Planning Review findings");
    if (value.verdict === "accepted") {
      attestReviewedPlanReferences(value, candidate.candidate);
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
      reviewedEffectIntentRefs: candidate.candidate.effectIntents.map((item) => item.ref),
      reviewedIntegrationCriterionRefs: candidate.candidate.integrationCriteria.map((item) => item.ref),
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
});

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
