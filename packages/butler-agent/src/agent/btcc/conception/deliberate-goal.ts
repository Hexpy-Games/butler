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
} from "./managed-contracts.ts";

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
  objective: "understand_the_full_request_and_author_a_goal_candidate",
  duties: [
    "preserve_selected_model", "state_input_only", "understand_request",
    ...LENSES, "candidate_revision_lineage",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
};

const codec: PhaseCodec<GoalContractCandidateProduct> = {
  decode(submission, envelope) {
    const value = requireRecord(submission, "Conception submission");
    requireLiteral(value.kind, "goal_contract_candidate", "Conception kind");
    const assessments = requireRecord(value.lensAssessments, "lensAssessments");
    const lensAssessments = Object.fromEntries(LENSES.map((lens) => {
      const assessment = requireRecord(assessments[lens], `lens ${lens}`);
      if (assessment.disposition !== "adopted" && assessment.disposition !== "non_applicable") {
        throw new Error(`lens ${lens} has an invalid disposition`);
      }
      const adoptedGoalFieldIds = requireStringArray(
        assessment.adoptedGoalFieldIds,
        `lens ${lens} adoptedGoalFieldIds`,
      );
      if (assessment.disposition === "non_applicable" && adoptedGoalFieldIds.length > 0) {
        throw new Error(`non-applicable lens ${lens} cannot adopt Goal fields`);
      }
      return [lens, {
        disposition: assessment.disposition,
        assessment: requireString(assessment.assessment, `lens ${lens} assessment`),
        adoptedGoalFieldIds,
      }];
    })) as GoalContractCandidateProduct["candidate"]["proposedContract"]["lensAssessments"];
    if (Object.keys(assessments).length !== LENSES.length) {
      throw new Error("Conception must assess exactly the six intent lenses");
    }
    const adoptedIds = LENSES.flatMap((lens) => lensAssessments[lens].adoptedGoalFieldIds);
    if (adoptedIds.some((id) => id !== "request" && id !== "intended_result")) {
      throw new Error("Conception lens adopted an unknown Goal field");
    }
    if (
      lensAssessments.requested_content.disposition !== "adopted" ||
      !lensAssessments.requested_content.adoptedGoalFieldIds.includes("request") ||
      lensAssessments.intended_result_and_acceptance.disposition !== "adopted" ||
      !lensAssessments.intended_result_and_acceptance.adoptedGoalFieldIds.includes("intended_result")
    ) {
      throw new Error("Conception did not bind the mandatory request and intended-result lenses");
    }
    const personalizationRefs = requireStringArray(
      value.personalizationRefs,
      "personalizationRefs",
    );
    const expectedRefs = [
      ...envelope.context.profileRefs,
      ...envelope.context.recentFeedbackRefs,
      ...envelope.context.mandatoryHotCacheRefs,
      ...envelope.context.optionalHotCacheRefs,
    ];
    if (JSON.stringify(personalizationRefs) !== JSON.stringify(expectedRefs)) {
      throw new Error("Conception did not preserve the admitted Butler context");
    }
    const request = requireString(value.request, "request");
    const intendedResult = requireString(value.intendedResult, "intendedResult");
    const body = {
      originalMessageId: envelope.context.originalMessageId,
      originalMessageSha256: digest(envelope.context.originalMessage),
      request,
      intendedResult,
      acceptanceIntent: requireString(value.acceptanceIntent, "acceptanceIntent"),
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
      nonGoals: requireStringArray(value.nonGoals, "nonGoals"),
    };
    const proposedContract = { ref: contentRef("goal-contract", body), ...body };
    const candidateBody = {
      turnId: envelope.binding.turnId,
      proposedContract,
      proposedStrategy: "managed" as const,
    };
    return {
      kind: "goal_contract_candidate",
      candidate: { ref: contentRef("goal-candidate", candidateBody), ...candidateBody },
    };
  },
};

export function deliberateGoal(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}
