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
  FeedbackPlanningFindingVerdict,
  FeedbackPlanningReview,
  FeedbackPlanProduct,
  FeedbackPlanningReviewProduct,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import { feedbackPlanReviewSubmissionSchema } from "./submission-schemas.ts";

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
  const priorFindings = requiredFeedbackFindings(prior);
  return withManagedDeferral<FeedbackPlanningReviewProduct>({
  submissionSchema: feedbackPlanReviewSubmissionSchema(
    priorFindings.map((finding) => finding.rootCauseKey),
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
    const decoded = requireFeedbackFindings(value, priorFindings);
    const reviewedFindings = normalizeFeedbackFindings(decoded.findings);
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
      findingVerdicts: decoded.verdicts,
    };
    if (value.verdict === "accepted") {
      const body = { ...reviewBase, verdict: "accepted" as const, findings: [] as [] };
      return {
        kind: "feedback_planning_accepted",
        candidate: candidate.candidate,
        review: { ref: contentRef("feedback-planning-review", body), ...body },
      };
    }
    const findingSetRef = prior?.findingSetRef ??
      contentRef("feedback-planning-finding-set", {
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
  priorFindings: FeedbackPlanningFinding[],
): {
  findings: FeedbackPlanningFinding[];
  verdicts: FeedbackPlanningFindingVerdict[];
} {
  const submission = requireRecord(value, "Feedback Planning Review submission");
  if (!Array.isArray(submission.findings)) {
    throw new Error("Feedback Planning Review findings must be an array");
  }
  if (priorFindings.length > 0) {
    const verdicts = requirePriorFindingVerdicts(
      submission.priorFindingVerdicts,
      priorFindings,
    );
    const backlog = decodeSubmittedFeedbackFindings(submission.findings);
    if (backlog.some((finding) => finding.recommendedDisposition === "required_now")) {
      throw new Error("Feedback Planning re-review cannot submit a new blocker");
    }
    const unresolved = verdicts
      .filter((verdict) => verdict.verdict === "unresolved")
      .map((verdict) => priorFindings.find((finding) =>
        finding.ref.id === verdict.findingRef.id)!);
    return {
      findings: [
        ...unresolved,
        ...backlog,
      ],
      verdicts,
    };
  }
  return {
    findings: decodeSubmittedFeedbackFindings(submission.findings),
    verdicts: [],
  };
}

function decodeSubmittedFeedbackFindings(
  value: unknown[],
): FeedbackPlanningFinding[] {
  return value.map((item, index) => {
    const finding = requireRecord(item, `Feedback Planning finding[${index}]`);
    const rootCauseKey = requireString(
      finding.rootCauseKey,
      "Feedback Planning finding root cause key",
    );
    const statement = requireString(finding.statement, "Feedback Planning finding statement");
    const priority = requirePriority(finding.priority);
    if (finding.recommendedDisposition === "required_now") {
      if (finding.findingOrigin !== "initial_review") {
        throw new Error("Initial Feedback Planning finding origin is invalid");
      }
      const body = {
        rootCauseKey,
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
      rootCauseKey,
      statement,
      priority,
      recommendedDisposition: "backlog" as const,
      origin: { kind: "backlog_candidate" as const },
    };
    return { ref: contentRef("feedback-planning-finding", body), ...body };
  });
}

function requirePriorFindingVerdicts(
  value: unknown,
  priorFindings: FeedbackPlanningFinding[],
): FeedbackPlanningFindingVerdict[] {
  if (!Array.isArray(value) || value.length !== priorFindings.length) {
    throw new Error("Feedback Planning re-review must judge every frozen finding");
  }
  const byRootCause = new Map(priorFindings.map((finding) => [
    finding.rootCauseKey,
    finding,
  ]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const verdict = requireRecord(item, `priorFindingVerdicts[${index}]`);
    const rootCauseKey = requireString(
      verdict.rootCauseKey,
      "Feedback Planning prior root cause key",
    );
    const finding = byRootCause.get(rootCauseKey);
    if (!finding || seen.has(rootCauseKey)) {
      throw new Error("Feedback Planning prior finding verdicts must be exact and unique");
    }
    seen.add(rootCauseKey);
    if (verdict.verdict !== "resolved" && verdict.verdict !== "unresolved") {
      throw new Error("Feedback Planning prior finding verdict is invalid");
    }
    return {
      findingRef: finding.ref,
      verdict: verdict.verdict,
      observation: requireString(
        verdict.observation,
        "Feedback Planning prior finding observation",
      ),
    };
  });
}

function requiredFeedbackFindings(
  prior: FeedbackPlanningReview | undefined,
): FeedbackPlanningFinding[] {
  return (prior?.reviewedFindings ?? []).filter(
    (finding) => finding.recommendedDisposition === "required_now",
  );
}

function normalizeFeedbackFindings(
  findings: FeedbackPlanningFinding[],
): FeedbackPlanningFinding[] {
  const byRootCause = new Map<string, string>();
  for (const finding of findings) {
    const priorRef = byRootCause.get(finding.rootCauseKey);
    if (priorRef && priorRef !== finding.ref.id) {
      throw new Error("Feedback Planning Review redefined one root cause");
    }
    byRootCause.set(finding.rootCauseKey, finding.ref.id);
  }
  const unique = [...new Map(findings.map((finding) => [finding.ref.id, finding])).values()];
  const priority = { P0: 0, P1: 1, P2: 2 };
  return unique.sort((left, right) => priority[left.priority] - priority[right.priority]);
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
