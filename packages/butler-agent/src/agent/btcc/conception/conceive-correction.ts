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
import { feedbackIntentSubmissionSchema } from "./submission-schemas.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_conception",
  operationSurface: "authorized",
  objective: "understand_the_review_finding_and_scope_the_correction",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "conceive_scoped_correction", "classify_correction_kind", "author_managed_deferral",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
};

function correctionCodec(findingRefs: ContentRef[]) {
  return withManagedDeferral<FeedbackIntentProduct>({
  submissionSchema: feedbackIntentSubmissionSchema(findingRefs.map((ref) => ref.id)),
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
      findingDecisions: requireFindingDecisions(value.findingDecisions, findingRefs),
    };
    return {
      kind: "feedback_intent",
      feedbackIntent: { ref: contentRef("feedback-intent", body), ...body },
    };
  },
});
}

export function conceiveCorrection(command: PhaseInvocation) {
  const state = requireRecord(command.context.stateInput, "Feedback Conception state");
  const findingRefs = correctionFindingRefs(state.correctionSource);
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: correctionCodec(findingRefs),
  });
}

function correctionFindingRefs(value: unknown): ContentRef[] {
  const source = requireRecord(value, "correctionSource");
  const review = source.review && typeof source.review === "object"
    ? requireRecord(source.review, "correctionSource.review")
    : undefined;
  if (!review || !Array.isArray(review.findings)) return [];
  return review.findings.flatMap((item, index) => {
    const finding = requireRecord(item, `correctionSource finding[${index}]`);
    return finding.recommendedDisposition === "required_now"
      ? [requireContentRef(finding.ref, `correctionSource finding[${index}].ref`)]
      : [];
  });
}

function requireFindingDecisions(
  value: unknown,
  findingRefs: ContentRef[],
): FeedbackIntentProduct["feedbackIntent"]["findingDecisions"] {
  if (findingRefs.length === 0) return [];
  if (!Array.isArray(value) || value.length !== findingRefs.length) {
    throw new Error("Feedback Conception must decide every required finding");
  }
  const byId = new Map(findingRefs.map((ref) => [ref.id, ref]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const decision = requireRecord(item, `findingDecisions[${index}]`);
    const findingId = requireString(decision.findingId, "findingDecision.findingId");
    const findingRef = byId.get(findingId);
    if (!findingRef || seen.has(findingId)) {
      throw new Error("Feedback finding decisions must be exact, unique, and complete");
    }
    seen.add(findingId);
    if (
      decision.decision !== "apply_now" &&
      decision.decision !== "dispute" &&
      decision.decision !== "split_to_backlog"
    ) {
      throw new Error("Feedback finding decision is invalid");
    }
    return {
      findingRef,
      decision: decision.decision,
      rationale: requireString(decision.rationale, "findingDecision.rationale"),
    };
  });
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
