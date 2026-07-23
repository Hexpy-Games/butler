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
  reviewedResultRefs: arraySchema(contentRefSchema(), { minItems: 1 }),
  observation: textSchema(),
};
const satisfiedCriterionVerdict = objectSchema({
  ...commonCriterionFields,
  verdict: literalSchema("satisfied"),
});
const semanticCriterionVerdict = variantsSchema(
  satisfiedCriterionVerdict,
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

export type TaskReviewMode = "semantic" | "promotion_identity";

export function taskReviewSubmissionSchema(mode: TaskReviewMode) {
  const criterionVerdict = mode === "promotion_identity"
    ? satisfiedCriterionVerdict
    : semanticCriterionVerdict;
  return objectSchema({
    kind: literalSchema("task_review"),
    criterionVerdicts: arraySchema(criterionVerdict, { minItems: 1 }),
  });
}
