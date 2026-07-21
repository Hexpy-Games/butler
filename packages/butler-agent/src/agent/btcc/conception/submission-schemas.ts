import {
  arraySchema,
  contentRefSchema,
  enumSchema,
  integerSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
} from "../core/index.ts";

const textList = () => arraySchema(textSchema());
const refList = () => arraySchema(contentRefSchema());

const personalizationApplication = objectSchema({
  ref: textSchema(),
  decision: enumSchema("applied", "not_applicable"),
});
const publicClaim = objectSchema({
  claim: textSchema(),
  sourceRefs: refList(),
});
const answerGuard = objectSchema({
  responseVerdict: enumSchema("responsive", "truthfully_limited"),
  personalizationVerdicts: arraySchema(objectSchema({
    ref: textSchema(),
    verdict: literalSchema("faithful_and_public_safe"),
  })),
  publicClaimVerdicts: arraySchema(objectSchema({
    claimIndex: integerSchema(),
    verdict: literalSchema("supported_or_not_observation_dependent"),
  })),
  verdict: literalSchema("accepted"),
});
const answerFields = {
  interpretedIntent: textSchema(),
  requiredOutcome: textSchema(),
  requiredOutcomeResolution: enumSchema("fulfilled", "truthfully_limited"),
  nonGoals: textList(),
  answer: textSchema(),
  personalizationApplications: arraySchema(personalizationApplication),
  publicClaims: arraySchema(publicClaim),
  guard: answerGuard,
};

export const openingSubmissionSchema = variantsSchema(
  objectSchema({ kind: literalSchema("direct_answer"), ...answerFields }),
  objectSchema({ kind: literalSchema("assisted_answer"), ...answerFields }),
  objectSchema({ kind: literalSchema("opening_continuation"), message: textSchema() }),
);

const lensAssessment = objectSchema({
  disposition: enumSchema("adopted", "non_applicable"),
  assessment: textSchema(),
  adoptedGoalFieldIds: textList(),
});

export const goalCandidateSubmissionSchema = objectSchema({
  kind: literalSchema("goal_contract_candidate"),
  request: textSchema(),
  intendedResult: textSchema(),
  acceptanceIntent: textSchema(),
  nonGoals: textList(),
  personalizationRefs: textList(),
  lensAssessments: objectSchema({
    requested_content: lensAssessment,
    related_memory: lensAssessment,
    connected_current_knowledge: lensAssessment,
    user_preferences_and_resolution_style: lensAssessment,
    expert_perspective: lensAssessment,
    intended_result_and_acceptance: lensAssessment,
  }),
});

const goalReviewFields = {
  kind: literalSchema("goal_contract_review"),
  strategy: literalSchema("managed"),
  verdict: literalSchema("accepted"),
};
export const goalReviewSubmissionSchema = variantsSchema(
  objectSchema(goalReviewFields),
  objectSchema({ ...goalReviewFields, continuationCandidateId: textSchema() }),
);

export const feedbackIntentSubmissionSchema = objectSchema({
  kind: literalSchema("feedback_intent"),
  correctionKind: enumSchema(
    "implementation_repair",
    "governing_revision",
    "authority_scope_revision",
  ),
  intendedCorrection: textSchema(),
});
