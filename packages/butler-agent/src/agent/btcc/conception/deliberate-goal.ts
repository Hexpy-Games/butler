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
import { goalCandidateSubmissionSchema } from "./submission-schemas.ts";

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
  submissionSchema: goalCandidateSubmissionSchema,
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

export function deliberateGoal(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}
