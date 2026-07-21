import {
  contentRef,
  requireLiteral,
  requireRecord,
  runPhaseConversation,
  stableJson,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { PlanningAcceptedProduct, PlanningCandidateProduct } from "./contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "planning_review",
  objective: "independently_review_the_exact_plan_and_work_graph",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_plan_exactly", "bind_normative_goal_sets", "review_work_cohesion",
    "review_executability", "review_dependencies", "review_verification_integration",
    "review_effect_authority", "review_artifact_lifecycle",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

const codec: PhaseCodec<PlanningAcceptedProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Planning Review state");
    const candidate = state.planCandidate as PlanningCandidateProduct | undefined;
    if (candidate?.kind !== "plan_candidate") {
      throw new Error("Planning Review is missing the exact candidate");
    }
    const value = requireRecord(submission, "Planning Review submission");
    requireLiteral(value.kind, "planning_review", "Planning Review kind");
    requireLiteral(value.verdict, "accepted", "Planning Review verdict");
    if (stableJson(value.candidateRef) !== stableJson(candidate.candidate.ref)) {
      throw new Error("Planning Review did not review the exact Plan candidate");
    }
    assertExactRef(value.reviewedBundleRef, candidate.candidate.bundle.ref, "bundle");
    assertExactRef(value.reviewedWorkRef, candidate.candidate.work.ref, "Work");
    assertExactRef(value.reviewedTaskRef, candidate.candidate.task.ref, "Task");
    assertExactRef(value.reviewedCriterionRef, candidate.candidate.criterion.ref, "criterion");
    assertExactRef(
      value.reviewedVerificationQuestionRef,
      candidate.candidate.verificationQuestion.ref,
      "verification question",
    );
    assertExactRef(
      value.reviewedArtifactLifecycleRef,
      candidate.candidate.artifactLifecycle.ref,
      "artifact lifecycle",
    );
    const body = {
      candidateRef: candidate.candidate.ref,
      originalGoalContractRef: candidate.candidate.goalContractRef,
      reviewedBundleRef: candidate.candidate.bundle.ref,
      reviewedWorkRef: candidate.candidate.work.ref,
      reviewedTaskRef: candidate.candidate.task.ref,
      reviewedCriterionRef: candidate.candidate.criterion.ref,
      reviewedVerificationQuestionRef: candidate.candidate.verificationQuestion.ref,
      reviewedArtifactLifecycleRef: candidate.candidate.artifactLifecycle.ref,
      verdict: "accepted" as const,
    };
    return {
      kind: "planning_accepted",
      candidate: candidate.candidate,
      review: { ref: contentRef("planning-review", body), ...body },
    };
  },
};

export function reviewPlan(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function assertExactRef(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Planning Review did not review the exact ${label}`);
  }
}
