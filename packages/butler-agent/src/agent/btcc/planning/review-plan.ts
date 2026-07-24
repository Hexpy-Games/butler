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
  PlanningReviewCoverage,
  PlanningReviewDimension,
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
  operationSurface: "authorized",
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
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
  authoringContractRefs: PLANNING_AUTHORING_CONTRACTS.map((contract) => contract.contractId),
  authoringContracts: PLANNING_AUTHORING_CONTRACTS,
};

const REVIEW_DIMENSIONS: readonly PlanningReviewDimension[] = [
  "original_goal",
  "governing_specs",
  "work_cohesion",
  "task_executability",
  "dependencies",
  "verification_integration",
  "effect_authority",
  "artifact_lifecycle",
];

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
      if (isDraft(loaded.candidate)) {
        const submittedFindings = requireStringArray(value.findings, "Planning Review findings");
        return requireDraftRevision(loaded.candidate, submittedFindings);
      }
      const materialized = loaded.candidate;
      const coverage = requireReviewCoverage(value.coverage);
      const submittedFindings = coverage.flatMap((item) => item.findings);
      const reviewBase = exactReviewBase(materialized, coverage);
      if (value.verdict === "accepted") {
        if (submittedFindings.length > 0) {
          throw new Error("Accepted Planning Review cannot contain failed coverage");
        }
        attestCandidateBundle(materialized);
        const body = { ...reviewBase, verdict: "accepted" as const, findings: [] as [] };
        return {
          kind: "planning_accepted" as const,
          candidate: materialized,
          review: { ref: contentRef("planning-review", body), ...body },
        };
      }
      if (submittedFindings.length === 0) {
        throw new Error("Planning revision requires failed coverage");
      }
      return requireMaterializedRevision(materialized, reviewBase, submittedFindings);
    },
  });
}

function exactReviewBase(
  candidate: PlanningCandidate,
  coverage: PlanningReviewCoverage[],
) {
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
    coverage,
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

function requireReviewCoverage(value: unknown): PlanningReviewCoverage[] {
  if (!Array.isArray(value) || value.length !== REVIEW_DIMENSIONS.length) {
    throw new Error("Planning Review must cover every review dimension");
  }
  const coverage = value.map((item, index) => {
    const entry = requireRecord(item, `Planning Review coverage[${index}]`);
    const dimension = entry.dimension;
    if (!REVIEW_DIMENSIONS.includes(dimension as PlanningReviewDimension)) {
      throw new Error("Planning Review coverage dimension is invalid");
    }
    if (entry.verdict !== "passed" && entry.verdict !== "failed") {
      throw new Error("Planning Review coverage verdict is invalid");
    }
    const findings = requireStringArray(
      entry.findings,
      `Planning Review ${String(dimension)} findings`,
    );
    if (entry.verdict === "passed" && findings.length > 0) {
      throw new Error("Passed Planning Review coverage cannot contain findings");
    }
    if (entry.verdict === "failed" && findings.length === 0) {
      throw new Error("Failed Planning Review coverage requires findings");
    }
    return {
      dimension: dimension as PlanningReviewDimension,
      verdict: entry.verdict as "passed" | "failed",
      findings,
    };
  });
  const dimensions = coverage.map((item) => item.dimension);
  if (new Set(dimensions).size !== REVIEW_DIMENSIONS.length ||
    REVIEW_DIMENSIONS.some((dimension) => !dimensions.includes(dimension))) {
    throw new Error("Planning Review coverage dimensions must be unique and complete");
  }
  return coverage;
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
