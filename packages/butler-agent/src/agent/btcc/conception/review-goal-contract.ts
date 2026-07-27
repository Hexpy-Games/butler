import {
  contentRef,
  digest,
  requireLiteral,
  requireRecord,
  runPhaseConversation,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  ConceptionLensId,
  GoalContractCandidateProduct,
  GoalContractRevisionRequiredProduct,
  GoalContractReviewProduct,
  GoalReviewFinding,
  GoalReviewFindingVerdict,
} from "./managed-contracts.ts";
import {
  goalReviewSubmissionSchema,
} from "./submission-schemas.ts";
import {
  decideContinuation,
  openingContinuationProposalId,
} from "./continuation/index.ts";
import { retainConceptionPlanningContext } from "./planning-context.ts";
import {
  decodeGoalSubjectCoverage,
  decodeInitialGoalFindings,
  decodePriorGoalFindingVerdicts,
  preserveGoalReviewLineage,
  requireGoalFindingCoverage,
  unresolvedGoalFindings,
} from "./goal-review-findings.ts";

const CONTRACT: PhaseContract = {
  phase: "contract_review",
  operationSurface: "authorized",
  objective: "independently_review_the_exact_goal_candidate",
  duties: [
    "preserve_selected_model", "state_input_only", "review_goal_contract_exactly",
    "review_continuation_coherence", "review_artifact_persistence",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

function goalReviewCodec(
  prior?: GoalContractRevisionRequiredProduct,
  proposedContinuationCandidateId?: string,
): PhaseCodec<GoalContractReviewProduct> {
  const frozenFindings = prior?.review.findings ?? [];
  return {
  submissionSchema: goalReviewSubmissionSchema(
    frozenFindings.map((finding) => finding.rootCauseKey),
    proposedContinuationCandidateId,
  ),
  decode(submission, envelope) {
    const candidate = loadCandidate(envelope.context.stateInput);
    preserveGoalReviewLineage(candidate, prior);
    const value = requireRecord(submission, "Goal Contract Review submission");
    requireLiteral(value.kind, "goal_contract_review", "Goal Contract Review kind");
    requireLiteral(value.strategy, "managed", "Goal Contract Review strategy");
    const findingVerdicts = decodePriorGoalFindingVerdicts(
      value.priorFindingVerdicts,
      frozenFindings,
    );
    const initialSubjects = prior
      ? []
      : decodeGoalSubjectCoverage(value.subjects);
    if (value.verdict === "revision_required") {
      const findings = prior
        ? unresolvedGoalFindings(frozenFindings, findingVerdicts)
        : decodeInitialGoalFindings(value.findings, candidate);
      if (!prior) requireGoalFindingCoverage(initialSubjects, findings);
      return requireRevision(
        candidate,
        findings,
        findingVerdicts,
        prior?.review.findingSet,
      );
    }
    requireLiteral(value.verdict, "accepted", "Goal Contract Review verdict");
    if (!prior && initialSubjects.some((subject) => subject.verdict !== "passed")) {
      throw new Error("Accepted Goal Contract Review has failed subject coverage");
    }
    if (findingVerdicts.some((verdict) => verdict.verdict !== "resolved")) {
      throw new Error("Accepted Goal Contract re-review has unresolved frozen findings");
    }
    const reviewedLensIds: ConceptionLensId[] = [
      "requested_content", "related_memory", "connected_current_knowledge",
      "user_preferences_and_resolution_style", "expert_perspective",
      "intended_result_and_acceptance",
    ];
    const reviewedFieldIds: ["request", "intended_result"] = ["request", "intended_result"];
    const reviewedOutcomeIds: [string] = [
      candidate.candidate.proposedContract.requiredOutcome.outcomeId,
    ];
    const inboxId = requireStringState(envelope.context.stateInput, "inboxId");
    const sessionId = requireStringState(envelope.context.stateInput, "sessionId");
    const projectRef = optionalStringState(envelope.context.stateInput, "projectRef");
    const continuation = decideContinuation(
      value.continuationDecision,
      envelope.context.stateInput,
      inboxId,
      proposedContinuationCandidateId,
    );
    const reviewBody = {
      candidateRef: candidate.candidate.ref,
      originalMessageId: candidate.candidate.proposedContract.originalMessageId,
      originalMessageSha256: candidate.candidate.proposedContract.originalMessageSha256,
      originalGoalContractRef: candidate.candidate.proposedContract.ref,
      reviewedLensIds,
      reviewedFieldIds,
      reviewedOutcomeIds,
      reviewedArtifactPersistence: candidate.candidate.proposedContract.artifactPersistence,
      continuationBindingRef: continuation.binding.ref,
      continuationDecision: continuation.reviewDecision,
      verdict: "accepted" as const,
      findings: [] as [],
      findingVerdicts,
    };
    const ledgerScope = projectRef
      ? { kind: "project" as const, projectRef }
      : { kind: "session" as const, sessionId };
    const defaultLedgerId = projectRef
      ? digest(`btcc-project-ledger.v1\0${projectRef}`)
      : digest(`btcc-session-ledger.v1\0${sessionId}`);
    const ledgerId = continuation.binding.kind !== "new_request"
      ? continuation.binding.ledgerId
      : defaultLedgerId;
    const programId = continuation.binding.kind !== "new_request"
      ? continuation.binding.programId
      : digest(
          `btcc-program.v1\0${ledgerId}\0${inboxId}\0${envelope.binding.turnId}\0${candidate.candidate.proposedContract.ref.sha256}`,
        );
    const authorityBody = {
      goalContractRef: candidate.candidate.proposedContract.ref,
      route: "managed" as const,
      ledgerScope,
      managedBinding: {
        ledgerId,
        programId,
        expectedManifestRevision: continuation.binding.kind !== "new_request"
          ? continuation.binding.expectedManifestRevision
          : 0,
        source: continuation.binding.kind === "stopped_program"
          ? "stopped_program" as const
          : continuation.binding.kind === "deferred_goal"
            ? "deferred_goal" as const
            : "new_program" as const,
        continuationBinding: continuation.binding,
      },
    };
    return {
      kind: "goal_contract_accepted",
      review: { ref: contentRef("goal-review", reviewBody), ...reviewBody },
      goalContract: candidate.candidate.proposedContract,
      planningContext: retainConceptionPlanningContext(
        envelope.operationResults,
        candidate.candidate.planningContext,
      ),
      authority: { ref: contentRef("authority-revision", authorityBody), ...authorityBody },
    };
  },
};
}

function requireRevision(
  product: GoalContractCandidateProduct,
  findings: GoalReviewFinding[],
  findingVerdicts: GoalReviewFindingVerdict[],
  priorFindingSet?: GoalContractRevisionRequiredProduct["review"]["findingSet"],
): GoalContractReviewProduct {
  if (findings.length === 0) throw new Error("Goal Contract revision requires findings");
  const candidate = product.candidate;
  const findingSet = priorFindingSet ?? (() => {
    const setBody = {
      candidateRef: candidate.ref,
      findingRefs: findings.map((finding) => finding.ref),
    };
    return { ref: contentRef("goal-finding-set", setBody), ...setBody };
  })();
  const findingSetRef = findingSet.ref;
  const body = {
    candidateRef: candidate.ref,
    originalMessageId: candidate.proposedContract.originalMessageId,
    originalMessageSha256: candidate.proposedContract.originalMessageSha256,
    verdict: "revision_required" as const,
    findings: findings as [GoalReviewFinding, ...GoalReviewFinding[]],
    findingVerdicts,
    findingSet,
    findingSetRef,
  };
  return {
    kind: "goal_contract_revision_required",
    candidate,
    review: { ref: contentRef("goal-review", body), ...body },
  };
}

export function reviewGoalContract(command: PhaseInvocation) {
  const state = requireRecord(command.context.stateInput, "Contract Review state input");
  const prior = state.goalRevision as GoalContractRevisionRequiredProduct | undefined;
  const proposedContinuationCandidateId = openingContinuationProposalId(state);
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: goalReviewCodec(prior, proposedContinuationCandidateId),
  });
}

function loadCandidate(input: unknown): GoalContractCandidateProduct {
  const state = requireRecord(input, "Contract Review state input");
  const candidate = state.goalCandidate as GoalContractCandidateProduct | undefined;
  if (candidate?.kind !== "goal_contract_candidate") {
    throw new Error("Contract Review is missing its exact Goal candidate");
  }
  return candidate;
}

function requireStringState(input: unknown, key: string): string {
  const value = requireRecord(input, "Contract Review state input")[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Contract Review state input is missing ${key}`);
  }
  return value;
}

function optionalStringState(input: unknown, key: string): string | undefined {
  const value = requireRecord(input, "Contract Review state input")[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Contract Review state input has an invalid ${key}`);
  }
  return value;
}
