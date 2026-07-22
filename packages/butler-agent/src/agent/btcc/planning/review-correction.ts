import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireStringArray,
  runPhaseConversation,
  stableJson,
  type ContentRef,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  FeedbackPlanProduct,
  FeedbackPlanningReviewProduct,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import { feedbackPlanReviewSubmissionSchema } from "./submission-schemas.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_planning_review",
  objective: "independently_review_the_exact_scoped_correction",
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

const codec = withManagedDeferral<FeedbackPlanningReviewProduct>({
  submissionSchema: feedbackPlanReviewSubmissionSchema,
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Feedback Planning Review state");
    const candidate = state.feedbackPlan as FeedbackPlanProduct | undefined;
    if (candidate?.kind !== "feedback_plan_candidate") {
      throw new Error("Feedback Planning Review is missing its exact candidate");
    }
    const goalRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const value = requireRecord(submission, "Feedback Planning Review submission");
    requireLiteral(value.kind, "feedback_planning_review", "Feedback Planning Review kind");
    if (value.correctionKind !== candidate.candidate.correctionKind) {
      throw new Error("Feedback Planning Review changed the correction kind");
    }
    if (value.verdict !== "accepted" && value.verdict !== "revision_required") {
      throw new Error("Feedback Planning Review verdict is invalid");
    }
    if (stableJson(value.candidateRef) !== stableJson(candidate.candidate.ref)) {
      throw new Error("Feedback Planning Review did not review the exact candidate");
    }
    assertReviewedRevision(value, candidate);
    const findings = requireStringArray(value.findings, "Feedback Planning Review findings");
    if (value.verdict === "accepted" && findings.length > 0) {
      throw new Error("Accepted Feedback Planning Review cannot carry findings");
    }
    if (value.verdict === "revision_required" && findings.length === 0) {
      throw new Error("Feedback Planning revision requires findings");
    }
    const reviewBase = {
      candidateRef: candidate.candidate.ref,
      originalGoalContractRef: goalRef,
      correctionKind: candidate.candidate.correctionKind,
    };
    if (value.verdict === "accepted") {
      const body = { ...reviewBase, verdict: "accepted" as const, findings: [] as [] };
      return {
        kind: "feedback_planning_accepted",
        candidate: candidate.candidate,
        review: { ref: contentRef("feedback-planning-review", body), ...body },
      };
    }
    const findingSetRef = contentRef("feedback-planning-finding-set", {
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
      kind: "feedback_planning_revision_required",
      candidate: candidate.candidate,
      review: { ref: contentRef("feedback-planning-review", body), ...body },
    };
  },
});

export function reviewCorrection(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function assertReviewedRevision(
  value: Record<string, unknown>,
  candidate: FeedbackPlanProduct,
): void {
  if (stableJson(value.reviewedCorrectionPlanRef) !== stableJson(candidate.candidate.correctionPlan.ref)) {
    throw new Error("Feedback Planning Review did not review the exact correction Plan");
  }
  if (candidate.candidate.correctionKind === "implementation_repair") return;
  if (
    stableJson(value.reviewedNextPlanCandidateRef) !==
      stableJson(candidate.candidate.nextPlanCandidate.ref) ||
    stableJson(value.reviewedImpactMap) !== stableJson(candidate.candidate.impactMap)
  ) {
    throw new Error("Feedback Planning Review did not review the exact graph impact");
  }
  if (
    candidate.candidate.correctionKind === "authority_scope_revision" &&
    stableJson(value.reviewedAuthorityRef) !== stableJson(candidate.candidate.proposedAuthority.ref)
  ) {
    throw new Error("Feedback Planning Review did not review the exact Authority revision");
  }
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
