import {
  contentRef,
  requireRecord,
  runPhaseConversation,
  type PhaseContract,
  type PhaseCodec,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  PlanningCandidate,
  PlanningCandidateProduct,
  PlanningDraftCandidate,
  PlanningReview,
  PlanningReviewSubjectCoverage,
  PlanningReviewProduct,
} from "./contracts.ts";
import {
  planReviewSubmissionSchema,
} from "./submission-schemas.ts";
import { planDraftReviewSubmissionSchema } from "./draft-review-submission-schema.ts";
import { attestCandidateBundle } from "./review-plan-attestation.ts";
import { PLANNING_AUTHORING_CONTRACTS } from "./authoring-contracts.ts";
import {
  planningReviewSubjects,
  projectDimensionCoverage,
  projectSubjectCoverage,
  requireDimensionCoverage,
  requireSubjectCoverage,
  resolvePlanningReviewFindings,
} from "./review-subjects.ts";
import {
  createPlanningFindingSet,
  draftReviewFindings,
  requiredPlanningFindings,
} from "./review-finding-set.ts";
import {
  applyPlanningDeferralPolicy,
  type PlanningDeferralPolicy,
} from "./deferral-policy.ts";

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

const CORRECTION_VERIFICATION_CONTRACT: PhaseContract = {
  ...CONTRACT,
  objective: "verify_the_frozen_planning_findings_against_the_exact_revision",
};

function reviewCodec(
  candidate: PlanningCandidateProduct,
  prior?: PlanningReview,
  deferralPolicy: PlanningDeferralPolicy = "allow",
) {
  const subjects = isDraft(candidate.candidate)
    ? []
    : planningReviewSubjects(candidate.candidate);
  const priorBlocking = requiredPlanningFindings(prior);
  const codec: PhaseCodec<PlanningReviewProduct> = {
    submissionSchema: isDraft(candidate.candidate)
      ? planDraftReviewSubmissionSchema
      : planReviewSubmissionSchema(
          subjects.map((item) => item.subjectId),
          priorBlocking.map((finding) => finding.rootCauseKey),
        ),
    decode(submission, envelope) {
      const loaded = loadCandidate(envelope.context.stateInput);
      const value = requireRecord(submission, "Planning Review submission");
      if (value.kind !== "planning_review") throw new Error("Planning Review kind is invalid");
      if (value.verdict !== "accepted" && value.verdict !== "revision_required") {
        throw new Error("Planning Review verdict is invalid");
      }
      if (isDraft(loaded.candidate)) {
        return requireDraftRevision(
          loaded.candidate,
          value.findings,
          loaded.observationResultIndex,
        );
      }
      const materialized = loaded.candidate;
      const decodedFindings = resolvePlanningReviewFindings(
        value.findings,
        value.priorFindingVerdicts,
        subjects,
        priorBlocking,
      );
      const reviewedSubjects = priorBlocking.length > 0
        ? projectSubjectCoverage(subjects, decodedFindings.findings)
        : requireSubjectCoverage(value.subjects, subjects, decodedFindings.findings);
      preserveRevisionReviewScope(
        materialized,
        reviewedSubjects,
        envelope.context.stateInput,
      );
      const coverage = priorBlocking.length > 0
        ? projectDimensionCoverage(reviewedSubjects)
        : requireDimensionCoverage(value.coverage, reviewedSubjects);
      const blockingFindings = orderedBlockingFindings(reviewedSubjects);
      const submittedFindings = blockingFindings.map((finding) => finding.message);
      const reviewBase = exactReviewBase(
        materialized,
        coverage,
        reviewedSubjects,
        decodedFindings.verdicts,
      );
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
      return requireMaterializedRevision(
        { ...loaded, candidate: materialized },
        reviewBase,
        submittedFindings,
      );
    },
  };
  return applyPlanningDeferralPolicy(codec, deferralPolicy);
}

function exactReviewBase(
  candidate: PlanningCandidate,
  coverage: ReturnType<typeof requireDimensionCoverage>,
  reviewedSubjects: ReturnType<typeof requireSubjectCoverage>,
  findingVerdicts: PlanningReview["findingVerdicts"],
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
    reviewedSubjects,
    coverage,
    findingVerdicts,
  };
}

function requireMaterializedRevision(
  product: PlanningCandidateProduct & { candidate: PlanningCandidate },
  reviewBase: ReturnType<typeof exactReviewBase>,
  submittedFindings: string[],
): PlanningReviewProduct {
  const candidate = product.candidate;
  const allFindings = reviewBase.reviewedSubjects
    .flatMap((subject) => subject.findings);
  const findingSet = createPlanningFindingSet(candidate.ref, allFindings);
  const findings = requireFindings(submittedFindings);
  const findingSetRef = findingSet.ref;
  const body = {
    ...reviewBase,
    verdict: "revision_required" as const,
    findings: findings as [string, ...string[]],
    findingSet,
    findingSetRef,
  };
  return {
    kind: "planning_revision_required",
    candidate,
    observationResultIndex: product.observationResultIndex,
    review: { ref: contentRef("planning-review", body), ...body },
  };
}

function requireDraftRevision(
  candidate: PlanningDraftCandidate,
  submittedFindings: unknown,
  observationResultIndex: PlanningCandidateProduct["observationResultIndex"] = [],
): PlanningReviewProduct {
  const findingSet = createPlanningFindingSet(
    candidate.ref,
    draftReviewFindings(candidate, submittedFindings),
  );
  const findings = requireFindings(
    findingSet.findings
      .filter((finding) => finding.recommendedDisposition === "required_now")
      .map((finding) => finding.message),
  );
  const findingSetRef = findingSet.ref;
  const body = {
    candidateRef: candidate.ref,
    originalGoalContractRef: candidate.goalContractRef,
    verdict: "revision_required" as const,
    findings,
    findingVerdicts: [],
    findingSet,
    findingSetRef,
  };
  return {
    kind: "planning_revision_required",
    candidate,
    observationResultIndex,
    review: { ref: contentRef("planning-review", body), ...body },
  };
}

function requireFindings(findings: string[]): [string, ...string[]] {
  const unique = [...new Set(findings.map((finding) => finding.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error("Planning revision requires findings");
  return unique as [string, ...string[]];
}

function preserveRevisionReviewScope(
  candidate: PlanningCandidate,
  current: PlanningReviewSubjectCoverage[],
  stateInput: unknown,
): void {
  if (candidate.revisionOrigin.kind !== "review_revision") return;
  const state = requireRecord(stateInput, "Planning Review state");
  const prior = state.priorPlanningReview as PlanningReview | undefined;
  if (!prior || prior.verdict !== "revision_required" || !prior.findingSetRef) {
    throw new Error("Planning revision Review is missing its frozen prior finding set");
  }
  if (
    !sameRef(prior.findingSetRef, candidate.revisionOrigin.findingSetRef) ||
    !sameRef(prior.candidateRef, candidate.revisionOrigin.previousCandidateRef)
  ) {
    throw new Error("Planning revision changed its frozen review lineage");
  }
  const priorBlocking = requiredPlanningFindings(prior);
  const decisions = candidate.revisionOrigin.findingDecisions;
  if (
    decisions.length !== priorBlocking.length ||
    !priorBlocking.every((finding) =>
      decisions.some((decision) => sameRef(decision.findingRef, finding.ref)))
  ) {
    throw new Error("Planning revision did not decide the frozen finding set");
  }
  const currentBlocking = orderedBlockingFindings(current);
  const priorFindingIds = new Set(priorBlocking.map((finding) => finding.ref.id));
  const currentFindingIds = currentBlocking.map((finding) => finding.ref.id);
  if (
    new Set(currentFindingIds).size !== currentFindingIds.length ||
    currentFindingIds.some((findingId) => !priorFindingIds.has(findingId))
  ) {
    throw new Error("Planning re-review can only retain frozen prior blockers");
  }
}

function orderedBlockingFindings(subjects: PlanningReviewSubjectCoverage[]) {
  const order = { P0: 0, P1: 1, P2: 2 };
  const findings = subjects
    .flatMap((subject) => subject.findings)
    .filter((finding) => finding.recommendedDisposition === "required_now");
  return [...new Map(findings.map((finding) => [finding.ref.id, finding])).values()]
    .sort((left, right) => order[left.priority] - order[right.priority]);
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function isDraft(candidate: PlanningCandidateProduct["candidate"]): candidate is PlanningDraftCandidate {
  return "kind" in candidate && candidate.kind === "planning_draft";
}

export function reviewPlan(
  command: PhaseInvocation,
  deferralPolicy: PlanningDeferralPolicy = "allow",
) {
  const state = requireRecord(command.context.stateInput, "Planning Review state");
  const candidate = loadCandidate(command.context.stateInput);
  const prior = state.priorPlanningReview as PlanningReview | undefined;
  const requiredReviewSubjects = isDraft(candidate.candidate)
    ? []
    : planningReviewSubjects(candidate.candidate);
  const priorBlocking = requiredPlanningFindings(prior);
  return runPhaseConversation({
    ...command,
    context: {
      ...command.context,
      stateInput: {
        ...requireRecord(command.context.stateInput, "Planning Review state"),
        requiredReviewSubjects,
      },
    },
    phaseContract: priorBlocking.length > 0
      ? CORRECTION_VERIFICATION_CONTRACT
      : CONTRACT,
    codec: reviewCodec(candidate, prior, deferralPolicy),
  });
}

function loadCandidate(input: unknown): PlanningCandidateProduct {
  const state = requireRecord(input, "Planning Review state");
  const candidate = state.planCandidate as PlanningCandidateProduct | undefined;
  if (candidate?.kind !== "plan_candidate") {
    throw new Error("Planning Review is missing the exact candidate");
  }
  return {
    ...candidate,
    observationResultIndex: Array.isArray(candidate.observationResultIndex)
      ? candidate.observationResultIndex
      : [],
  };
}
