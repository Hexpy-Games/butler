import {
  arraySchema,
  contentRefSchema,
  enumSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
} from "../core/index.ts";

const commonCriterionFields = {
  criterionRef: contentRefSchema(),
  verificationQuestionRefs: arraySchema(contentRefSchema()),
  observation: textSchema(),
};
const criterionVerdict = variantsSchema(
  objectSchema({
    ...commonCriterionFields,
    verdict: literalSchema("satisfied"),
  }),
  objectSchema({
    ...commonCriterionFields,
    verdict: literalSchema("not_satisfied"),
    findingCategory: enumSchema(
      "implementation_nonconformance",
      "authority_contradiction",
      "goal_drift",
      "task_decomposition",
      "dependency_invalid",
      "verification_incomplete",
      "missing_observation",
    ),
    finding: textSchema(),
  }),
);

export const taskReviewSubmissionSchema = objectSchema({
  kind: literalSchema("task_review"),
  resultCandidateRef: contentRefSchema(),
  verdict: enumSchema("passed", "not_passed"),
  criterionVerdicts: arraySchema(criterionVerdict, { minItems: 1 }),
});
