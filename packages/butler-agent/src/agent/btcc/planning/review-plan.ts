import {
  contentRef,
  requireRecord,
  requireStringArray,
  runPhaseConversation,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  PlanningCandidate,
  PlanningCandidateProduct,
  PlanningDraftCandidate,
  PlanningReviewProduct,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import {
  planReviewSubmissionSchema,
  planRevisionReviewSubmissionSchema,
} from "./submission-schemas.ts";
import { attestCandidateBundle } from "./review-plan-attestation.ts";
import { PLANNING_AUTHORING_CONTRACTS } from "./authoring-contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "planning_review",
  objective: "independently_review_the_exact_complete_plan_graph",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_plan_exactly", "review_work_cohesion", "review_executability",
    "review_dependencies", "review_verification_integration",
    "review_effect_authority", "review_artifact_lifecycle",
    "review_goal_artifact_persistence",
    "author_managed_deferral",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
  authoringContractRefs: PLANNING_AUTHORING_CONTRACTS.map((contract) => contract.contractId),
  authoringContracts: PLANNING_AUTHORING_CONTRACTS,
};

function reviewCodec(candidate: PlanningCandidateProduct) {
  return withManagedDeferral<PlanningReviewProduct>({
    submissionSchema: isDraft(candidate.candidate)
      ? planRevisionReviewSubmissionSchema
      : planReviewSubmissionSchema,
    decode(submission, envelope) {
      const loaded = loadCandidate(envelope.context.stateInput);
      const value = requireRecord(submission, "Planning Review submission");
      if (value.kind !== "planning_review") throw new Error("Planning Review kind is invalid");
      if (value.verdict !== "accepted" && value.verdict !== "revision_required") {
        throw new Error("Planning Review verdict is invalid");
      }
      const submittedFindings = requireStringArray(value.findings, "Planning Review findings");
      if (isDraft(loaded.candidate)) {
        return requireDraftRevision(loaded.candidate, submittedFindings);
      }
      const materialized = loaded.candidate;
      const reviewBase = exactReviewBase(materialized);
      if (value.verdict === "accepted") {
        attestCandidateBundle(materialized);
        const body = { ...reviewBase, verdict: "accepted" as const, findings: [] as [] };
        return {
          kind: "planning_accepted" as const,
          candidate: materialized,
          review: { ref: contentRef("planning-review", body), ...body },
        };
      }
      return requireMaterializedRevision(materialized, reviewBase, submittedFindings);
    },
  });
}

function exactReviewBase(candidate: PlanningCandidate) {
  return {
    candidateRef: candidate.ref,
    originalGoalContractRef: candidate.goalContractRef,
    reviewedBundleRef: candidate.bundle.ref,
    reviewedWorkGraphRef: candidate.workGraph.ref,
    reviewedWorkRefs: candidate.works.map((item) => item.ref),
    reviewedTaskRefs: candidate.tasks.map((item) => item.ref),
    reviewedCriterionRefs: candidate.criteria.map((item) => item.ref),
    reviewedVerificationQuestionRefs: candidate.verificationQuestions.map((item) => item.ref),
    reviewedEffectIntentRefs: candidate.effectIntents.map((item) => item.ref),
    reviewedIntegrationCriterionRefs: candidate.integrationCriteria.map((item) => item.ref),
    reviewedArtifactLifecycleRef: candidate.artifactLifecycle.ref,
    reviewedSpecRevisionRefs: candidate.authoredSpecRevisionRefs,
  };
}

function requireMaterializedRevision(
  candidate: PlanningCandidate,
  reviewBase: ReturnType<typeof exactReviewBase>,
  submittedFindings: string[],
): PlanningReviewProduct {
  const findings = requireFindings(submittedFindings);
  const findingSetRef = contentRef("planning-finding-set", {
    candidateRef: candidate.ref,
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
    candidate,
    review: { ref: contentRef("planning-review", body), ...body },
  };
}

function requireDraftRevision(
  candidate: PlanningDraftCandidate,
  submittedFindings: string[],
): PlanningReviewProduct {
  const findings = requireFindings([
    ...candidate.validationFindings.map((finding) => `${finding.code}: ${finding.message}`),
    ...submittedFindings,
  ]);
  const findingSetRef = contentRef("planning-finding-set", {
    candidateRef: candidate.ref,
    findings,
  });
  const body = {
    candidateRef: candidate.ref,
    originalGoalContractRef: candidate.goalContractRef,
    verdict: "revision_required" as const,
    findings,
    findingSetRef,
  };
  return {
    kind: "planning_revision_required",
    candidate,
    review: { ref: contentRef("planning-review", body), ...body },
  };
}

function requireFindings(findings: string[]): [string, ...string[]] {
  const unique = [...new Set(findings.map((finding) => finding.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error("Planning revision requires findings");
  return unique as [string, ...string[]];
}

function isDraft(candidate: PlanningCandidateProduct["candidate"]): candidate is PlanningDraftCandidate {
  return "kind" in candidate && candidate.kind === "planning_draft";
}

export function reviewPlan(command: PhaseInvocation) {
  const candidate = loadCandidate(command.context.stateInput);
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: reviewCodec(candidate),
  });
}

function loadCandidate(input: unknown): PlanningCandidateProduct {
  const state = requireRecord(input, "Planning Review state");
  const candidate = state.planCandidate as PlanningCandidateProduct | undefined;
  if (candidate?.kind !== "plan_candidate") {
    throw new Error("Planning Review is missing the exact candidate");
  }
  return candidate;
}
