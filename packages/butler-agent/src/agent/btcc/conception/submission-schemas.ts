import {
  arraySchema,
  contentRefSchema,
  enumSchema,
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
const answerFields = {
  interpretedIntent: textSchema(),
  requiredOutcome: textSchema(),
  requiredOutcomeResolution: enumSchema("fulfilled", "truthfully_limited"),
  nonGoals: textList(),
  answer: textSchema(),
  personalizationApplications: arraySchema(personalizationApplication),
  publicClaims: arraySchema(publicClaim),
};

export const openingSubmissionSchema = variantsSchema(
  objectSchema({ kind: literalSchema("direct_answer"), ...answerFields }),
  objectSchema({ kind: literalSchema("assisted_continuation"), message: textSchema() }),
  objectSchema({ kind: literalSchema("managed_continuation"), message: textSchema() }),
);
export const assistedAnswerSubmissionSchema = objectSchema({
  kind: literalSchema("assisted_answer"),
  ...answerFields,
});

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
  artifactPersistence: enumSchema("not_required", "required"),
  nonGoals: textList(),
  personalizationRefs: textList(),
  governingSpecLogicalIds: textList(),
  lensAssessments: objectSchema({
    requested_content: lensAssessment,
    related_memory: lensAssessment,
    connected_current_knowledge: lensAssessment,
    user_preferences_and_resolution_style: lensAssessment,
    expert_perspective: lensAssessment,
    intended_result_and_acceptance: lensAssessment,
  }),
});

const acceptedGoalReviewFields = {
  kind: literalSchema("goal_contract_review"),
  strategy: literalSchema("managed"),
  verdict: literalSchema("accepted"),
};
export const goalReviewSubmissionSchema = variantsSchema(
  objectSchema(acceptedGoalReviewFields),
  objectSchema({ ...acceptedGoalReviewFields, continuationCandidateId: textSchema() }),
  objectSchema({
    kind: literalSchema("goal_contract_review"),
    strategy: literalSchema("managed"),
    verdict: literalSchema("revision_required"),
    findings: textList(),
  }),
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
