import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type ContentRef,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { FeedbackIntentProduct } from "./managed-contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_conception",
  objective: "understand_the_review_finding_and_scope_the_correction",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "conceive_scoped_correction", "classify_correction_kind",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
};

const codec = withManagedDeferral<FeedbackIntentProduct>({
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Feedback Conception state");
    const correctionScopeRef = requireContentRef(state.correctionScopeRef, "correctionScopeRef");
    const goalRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const authorityRef = requireContentRef(state.authorityRef, "authorityRef");
    const value = requireRecord(submission, "Feedback Conception submission");
    requireLiteral(value.kind, "feedback_intent", "Feedback Conception kind");
    const correctionKind = requireCorrectionKind(value.correctionKind);
    const body = {
      correctionScopeRef,
      originalGoalContractRef: goalRef,
      currentAuthorityRef: authorityRef,
      correctionKind,
      intendedCorrection: requireString(value.intendedCorrection, "intendedCorrection"),
    };
    return {
      kind: "feedback_intent",
      feedbackIntent: { ref: contentRef("feedback-intent", body), ...body },
    };
  },
});

export function conceiveCorrection(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function requireCorrectionKind(value: unknown):
  | "implementation_repair"
  | "governing_revision"
  | "authority_scope_revision" {
  if (
    value !== "implementation_repair" &&
    value !== "governing_revision" &&
    value !== "authority_scope_revision"
  ) {
    throw new Error("Feedback Conception correction kind is invalid");
  }
  return value;
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    sha256: requireString(record.sha256, `${label}.sha256`),
  };
}
