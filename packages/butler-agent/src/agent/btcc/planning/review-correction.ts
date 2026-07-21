import {
  contentRef,
  requireLiteral,
  requireRecord,
  runPhaseConversation,
  stableJson,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { FeedbackPlanProduct, FeedbackPlanningAcceptedProduct } from "./contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_planning_review",
  objective: "independently_review_the_scoped_correction",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_correction_exactly", "review_dependencies", "review_verification_integration",
    "review_effect_authority", "review_artifact_lifecycle",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

const codec: PhaseCodec<FeedbackPlanningAcceptedProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Feedback Planning Review state");
    const candidate = state.feedbackPlan as FeedbackPlanProduct | undefined;
    if (candidate?.kind !== "feedback_plan_candidate") {
      throw new Error("Feedback Planning Review is missing its exact candidate");
    }
    const goalRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const value = requireRecord(submission, "Feedback Planning Review submission");
    requireLiteral(value.kind, "feedback_planning_review", "Feedback Planning Review kind");
    requireLiteral(value.verdict, "accepted", "Feedback Planning Review verdict");
    requireLiteral(value.correctionKind, "implementation_repair", "correction kind");
    if (stableJson(value.candidateRef) !== stableJson(candidate.candidate.ref)) {
      throw new Error("Feedback Planning Review did not review the exact candidate");
    }
    const body = {
      candidateRef: candidate.candidate.ref,
      originalGoalContractRef: goalRef,
      correctionKind: "implementation_repair" as const,
      verdict: "accepted" as const,
    };
    return {
      kind: "feedback_planning_accepted",
      candidate: candidate.candidate,
      review: { ref: contentRef("feedback-planning-review", body), ...body },
    };
  },
};

export function reviewCorrection(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  const id = record.id;
  const sha256 = record.sha256;
  if (typeof id !== "string" || typeof sha256 !== "string") {
    throw new Error(`${label} is invalid`);
  }
  return { id, sha256 };
}
