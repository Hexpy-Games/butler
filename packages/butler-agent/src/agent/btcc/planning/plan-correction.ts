import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { FeedbackIntentProduct } from "../conception/index.ts";
import type { FeedbackPlanProduct } from "./contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_planning",
  objective: "author_an_attempt_scoped_implementation_correction",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "author_scoped_correction", "author_complete_impact_map",
    "apply_authoring_contracts", "author_artifact_lifecycle", "candidate_revision_lineage",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
  authoringContractRefs: [
    "SPEC-BTCC-WORK-AUTHORING-CONTRACT",
    "SPEC-BTCC-PLANNING-RECORD-CONTRACT",
    "SPEC-BTCC-WORK-LEDGER-STATE-AND-MUTATION-CONTRACT",
  ],
};

const codec: PhaseCodec<FeedbackPlanProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Feedback Planning state");
    const intent = state.feedbackIntent as FeedbackIntentProduct | undefined;
    if (intent?.kind !== "feedback_intent") {
      throw new Error("Feedback Planning is missing its accepted intent");
    }
    const planRef = requireContentRef(state.workPlanRef, "workPlanRef");
    const taskRef = requireContentRef(state.taskRef, "taskRef");
    const lifecycleRef = requireContentRef(state.artifactLifecycleRef, "artifactLifecycleRef");
    const value = requireRecord(submission, "Feedback Planning submission");
    requireLiteral(value.kind, "feedback_plan_candidate", "Feedback Planning kind");
    requireLiteral(value.correctionKind, "implementation_repair", "correction kind");
    const correctionBody = {
      kind: "correction_plan" as const,
      governingWorkPlanRef: planRef,
      targetTaskRef: taskRef,
      correctionAction: requireString(value.correctionAction, "correctionAction"),
      artifactLifecycleRef: lifecycleRef,
    };
    const correctionPlan = {
      ref: contentRef("correction-plan", correctionBody), ...correctionBody,
    };
    const candidateBody = {
      feedbackIntentRef: intent.feedbackIntent.ref,
      correctionScopeRef: intent.feedbackIntent.correctionScopeRef,
      correctionPlan,
    };
    return {
      kind: "feedback_plan_candidate",
      candidate: { ref: contentRef("feedback-plan-candidate", candidateBody), ...candidateBody },
    };
  },
};

export function proposeCorrectionOrRevision(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return { id: requireString(record.id, `${label}.id`), sha256: requireString(record.sha256, `${label}.sha256`) };
}
