import {
  contentRef,
  digest,
  requireLiteral,
  requireRecord,
  requireString,
  requireStringArray,
  runPhaseConversation,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  ConceptionLensId,
  GoalContractCandidateProduct,
  GoalContractRevisionRequiredProduct,
  GoalReviewFinding,
  GoalReviewFindingDecision,
} from "./managed-contracts.ts";
import { requireGoverningSpecApplications } from "./governing-spec-applications.ts";
import { goalCandidateSubmissionSchema } from "./submission-schemas.ts";
import { retainConceptionPlanningContext } from "./planning-context.ts";

const LENSES: ConceptionLensId[] = [
  "requested_content",
  "related_memory",
  "connected_current_knowledge",
  "user_preferences_and_resolution_style",
  "expert_perspective",
  "intended_result_and_acceptance",
];

const CONTRACT: PhaseContract = {
  phase: "conception_deliberation",
  operationSurface: "authorized",
  objective: "understand_the_full_request_and_author_a_goal_candidate",
  duties: [
    "preserve_selected_model", "state_input_only", "understand_request",
    ...LENSES, "map_governing_spec_applicability", "candidate_revision_lineage",
    "apply_exact_review_findings", "define_artifact_persistence",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
};

function goalCodec(
  priorRevision?: GoalContractRevisionRequiredProduct,
): PhaseCodec<GoalContractCandidateProduct> {
  const priorFindings = priorRevision?.review.findings ?? [];
  return {
  submissionSchema: goalCandidateSubmissionSchema(
    priorFindings.map((finding) => finding.rootCauseKey),
  ),
  decode(submission, envelope) {
    const value = requireRecord(submission, "Conception submission");
    requireLiteral(value.kind, "goal_contract_candidate", "Conception kind");
    const assessments = requireRecord(value.lensAssessments, "lensAssessments");
    const lensAssessments = Object.fromEntries(LENSES.map((lens) => {
      const assessment = requireRecord(assessments[lens], `lens ${lens}`);
      if (assessment.disposition !== "adopted" && assessment.disposition !== "non_applicable") {
        throw new Error(`lens ${lens} has an invalid disposition`);
      }
      const submittedGoalFieldIds = requireStringArray(
        assessment.adoptedGoalFieldIds,
        `lens ${lens} adoptedGoalFieldIds`,
      );
      const canonical = canonicalLensBinding(
        lens,
        assessment.disposition,
        submittedGoalFieldIds,
      );
      return [lens, {
        disposition: canonical.disposition,
        assessment: requireString(assessment.assessment, `lens ${lens} assessment`),
        adoptedGoalFieldIds: canonical.adoptedGoalFieldIds,
      }];
    })) as GoalContractCandidateProduct["candidate"]["proposedContract"]["lensAssessments"];
    const submittedPersonalizationRefs = requireStringArray(
      value.personalizationRefs,
      "personalizationRefs",
    );
    const admittedRefs = [
      ...envelope.context.profileRefs,
      ...envelope.context.recentFeedbackRefs,
      ...envelope.context.mandatoryHotCacheRefs,
      ...envelope.context.optionalHotCacheRefs,
    ];
    const admittedSet = new Set(admittedRefs);
    const personalizationRefs = [...new Set([
      ...envelope.context.mandatoryHotCacheRefs,
      ...submittedPersonalizationRefs.filter((ref) => admittedSet.has(ref)),
    ])];
    const request = requireString(value.request, "request");
    const intendedResult = requireString(value.intendedResult, "intendedResult");
    const body = {
      originalMessageId: envelope.context.originalMessageId,
      originalMessageSha256: digest(envelope.context.originalMessage),
      request,
      intendedResult,
      acceptanceIntent: requireString(value.acceptanceIntent, "acceptanceIntent"),
      artifactPersistence: requireArtifactPersistence(value.artifactPersistence),
      fields: [
        { fieldId: "request", semanticRole: "required_outcome", statement: request },
        { fieldId: "intended_result", semanticRole: "required_outcome", statement: intendedResult },
      ] as const,
      requiredOutcome: {
        outcomeId: digest(`btcc-required-outcome.v1\0${envelope.binding.turnId}`),
        sourceGoalFieldIds: ["request", "intended_result"] as const,
      },
      lensAssessments,
      personalizationRefs,
      governingSpecApplications: requireGoverningSpecApplications(
        value.governingSpecApplications,
      ),
      nonGoals: requireStringArray(value.nonGoals, "nonGoals"),
    };
    const proposedContract = { ref: contentRef("goal-contract", body), ...body };
    const revisionOrigin = bindGoalRevision(
      envelope.context.stateInput,
      proposedContract.ref,
      decodeGoalFindingDecisions(value.findingDecisions, priorFindings),
    );
    const candidateBody = {
      turnId: envelope.binding.turnId,
      proposedContract,
      proposedStrategy: "managed" as const,
      revisionOrigin,
      planningContext: retainConceptionPlanningContext(
        envelope.operationResults,
        priorPlanningContext(envelope.context.stateInput),
      ),
    };
    return {
      kind: "goal_contract_candidate",
      candidate: { ref: contentRef("goal-candidate", candidateBody), ...candidateBody },
    };
  },
};
}

export function bindGoalRevision(
  input: unknown,
  proposedContractRef: GoalContractCandidateProduct["candidate"]["proposedContract"]["ref"],
  findingDecisions: GoalReviewFindingDecision[] = [],
): GoalContractCandidateProduct["candidate"]["revisionOrigin"] {
  if (input === undefined) return { kind: "initial" };
  const state = requireRecord(input, "Conception revision state");
  if (state.goalRevision === undefined) return { kind: "initial" };
  const revision = state.goalRevision as GoalContractRevisionRequiredProduct;
  if (revision.kind !== "goal_contract_revision_required") {
    throw new Error("Conception revision state has an invalid Goal review");
  }
  if (!sameRef(revision.review.candidateRef, revision.candidate.ref)) {
    throw new Error("Goal review is not bound to its exact previous candidate");
  }
  const requiresContractChange = findingDecisions.some(
    (decision) => decision.decision === "apply_now",
  );
  if (
    requiresContractChange &&
    sameRef(proposedContractRef, revision.candidate.proposedContract.ref)
  ) {
    throw new Error("Goal Contract revision did not change the proposed contract");
  }
  const expected = new Set(revision.review.findings.map((finding) => finding.ref.id));
  if (
    findingDecisions.length !== revision.review.findings.length ||
    new Set(findingDecisions.map((decision) => decision.findingRef.id)).size !==
      findingDecisions.length ||
    findingDecisions.some((decision) => !expected.has(decision.findingRef.id))
  ) {
    throw new Error("Goal Contract revision must decide every frozen finding");
  }
  return {
    kind: "review_revision",
    previousCandidateRef: revision.candidate.ref,
    reviewRef: revision.review.ref,
    findingSetRef: revision.review.findingSetRef,
    findingDecisions,
  };
}

function decodeGoalFindingDecisions(
  value: unknown,
  findings: GoalReviewFinding[],
): GoalReviewFindingDecision[] {
  if (findings.length === 0) return [];
  if (!Array.isArray(value) || value.length !== findings.length) {
    throw new Error("Goal Contract revision must decide every frozen finding");
  }
  const byRootCause = new Map(findings.map((finding) => [
    finding.rootCauseKey,
    finding,
  ]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const submitted = requireRecord(item, `Goal findingDecision[${index}]`);
    const rootCauseKey = requireString(
      submitted.rootCauseKey,
      `Goal findingDecision[${index}].rootCauseKey`,
    );
    const finding = byRootCause.get(rootCauseKey);
    if (!finding || seen.has(rootCauseKey)) {
      throw new Error("Goal Contract finding decisions must be exact and unique");
    }
    seen.add(rootCauseKey);
    if (
      submitted.decision !== "apply_now" &&
      submitted.decision !== "dispute" &&
      submitted.decision !== "split_to_backlog"
    ) {
      throw new Error("Goal Contract finding decision is invalid");
    }
    return {
      findingRef: finding.ref,
      decision: submitted.decision,
      rationale: requireString(
        submitted.rationale,
        `Goal findingDecision[${index}].rationale`,
      ),
    };
  });
}

function priorPlanningContext(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const revision = (input as Record<string, unknown>).goalRevision;
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) return undefined;
  const candidate = (revision as GoalContractRevisionRequiredProduct).candidate;
  return candidate?.planningContext;
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function canonicalLensBinding(
  lens: ConceptionLensId,
  submittedDisposition: "adopted" | "non_applicable",
  submittedFieldIds: string[],
) {
  if (lens === "requested_content") {
    return { disposition: "adopted" as const, adoptedGoalFieldIds: ["request"] };
  }
  if (lens === "intended_result_and_acceptance") {
    return { disposition: "adopted" as const, adoptedGoalFieldIds: ["intended_result"] };
  }
  const adoptedGoalFieldIds = submittedFieldIds.filter(
    (id) => id === "request" || id === "intended_result",
  );
  return submittedDisposition === "adopted"
    ? { disposition: "adopted" as const, adoptedGoalFieldIds }
    : { disposition: "non_applicable" as const, adoptedGoalFieldIds: [] };
}

function requireArtifactPersistence(value: unknown): "not_required" | "required" {
  if (value !== "not_required" && value !== "required") {
    throw new Error("artifactPersistence must be not_required or required");
  }
  return value;
}

export function deliberateGoal(command: PhaseInvocation) {
  const state = command.context.stateInput as {
    goalRevision?: GoalContractRevisionRequiredProduct;
  } | undefined;
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: goalCodec(state?.goalRevision),
  });
}
