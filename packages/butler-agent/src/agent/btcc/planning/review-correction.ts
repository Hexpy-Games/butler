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
import type {
  FeedbackPlanningFinding,
  FeedbackPlanningReview,
  FeedbackPlanProduct,
  FeedbackPlanningReviewProduct,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import { feedbackPlanReviewSubmissionSchema } from "./submission-schemas.ts";
import { requiredFeedbackFindingRefs } from "./finding-decisions.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_planning_review",
  operationSurface: "authorized",
  objective: "independently_review_the_exact_scoped_correction",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_correction_exactly", "review_dependencies", "review_verification_integration",
    "review_effect_authority", "review_artifact_lifecycle",
    "author_managed_deferral",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

function correctionReviewCodec(prior?: FeedbackPlanningReview) {
  const priorFindingRefs = requiredFeedbackFindingRefs(prior);
  return withManagedDeferral<FeedbackPlanningReviewProduct>({
  submissionSchema: feedbackPlanReviewSubmissionSchema(
    priorFindingRefs.map((ref) => ref.id),
  ),
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Feedback Planning Review state");
    const candidate = state.feedbackPlan as FeedbackPlanProduct | undefined;
    if (candidate?.kind !== "feedback_plan_candidate") {
      throw new Error("Feedback Planning Review is missing its exact candidate");
    }
    const goalRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const value = requireRecord(submission, "Feedback Planning Review submission");
    requireLiteral(value.kind, "feedback_planning_review", "Feedback Planning Review kind");
    if (value.verdict !== "accepted" && value.verdict !== "revision_required") {
      throw new Error("Feedback Planning Review verdict is invalid");
    }
    const reviewedFindings = requireFeedbackFindings(value.findings, prior);
    const blocking = reviewedFindings
      .filter((finding) => finding.recommendedDisposition === "required_now");
    const findings = blocking.map((finding) => finding.statement);
    if (value.verdict === "accepted" && blocking.length > 0) {
      throw new Error("Accepted Feedback Planning Review cannot carry findings");
    }
    if (value.verdict === "revision_required" && blocking.length === 0) {
      throw new Error("Feedback Planning revision requires findings");
    }
    const reviewBase = {
      candidateRef: candidate.candidate.ref,
      originalGoalContractRef: goalRef,
      correctionKind: candidate.candidate.correctionKind,
      reviewedFindings,
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
      findingRefs: blocking.map((finding) => finding.ref),
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
}

export function reviewCorrection(command: PhaseInvocation) {
  const state = requireRecord(command.context.stateInput, "Feedback Planning Review state");
  const prior = state.previousFeedbackPlanningReview as FeedbackPlanningReview | undefined;
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: correctionReviewCodec(prior),
  });
}

function requireFeedbackFindings(
  value: unknown,
  prior?: FeedbackPlanningReview,
): FeedbackPlanningFinding[] {
  if (!Array.isArray(value)) {
    throw new Error("Feedback Planning Review findings must be an array");
  }
  const priorById = new Map((prior?.reviewedFindings ?? [])
    .filter((finding) => finding.recommendedDisposition === "required_now")
    .map((finding) => [finding.ref.id, finding]));
  return value.map((item, index) => {
    const finding = requireRecord(item, `Feedback Planning finding[${index}]`);
    const statement = requireString(finding.statement, "Feedback Planning finding statement");
    const priority = requirePriority(finding.priority);
    if (finding.recommendedDisposition === "required_now") {
      if (prior) {
        const previous = priorById.get(
          requireString(finding.priorFindingId, "prior Feedback Planning finding id"),
        );
        if (
          finding.findingOrigin !== "prior_finding" ||
          !previous ||
          previous.statement !== statement ||
          previous.priority !== priority
        ) {
          throw new Error("Feedback Planning re-review changed its frozen finding");
        }
        return previous;
      }
      if (finding.findingOrigin !== "initial_review") {
        throw new Error("Initial Feedback Planning finding origin is invalid");
      }
      const body = {
        statement,
        priority,
        recommendedDisposition: "required_now" as const,
        origin: { kind: "initial_review" as const },
      };
      return { ref: contentRef("feedback-planning-finding", body), ...body };
    }
    if (
      finding.recommendedDisposition !== "backlog" ||
      finding.findingOrigin !== "backlog_candidate"
    ) {
      throw new Error("Feedback Planning backlog finding is invalid");
    }
    const body = {
      statement,
      priority,
      recommendedDisposition: "backlog" as const,
      origin: { kind: "backlog_candidate" as const },
    };
    return { ref: contentRef("feedback-planning-finding", body), ...body };
  });
}

function requirePriority(value: unknown): "P0" | "P1" | "P2" {
  if (value !== "P0" && value !== "P1" && value !== "P2") {
    throw new Error("Feedback Planning finding priority is invalid");
  }
  return value;
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
