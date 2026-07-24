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
  observation: textSchema(),
};
const satisfiedCriterionVerdict = objectSchema({
  ...commonCriterionFields,
  verdict: literalSchema("satisfied"),
});
const findingFields = {
  rootCauseKey: textSchema(),
  affectedCriterionRefs: arraySchema(contentRefSchema(), { minItems: 1 }),
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
  priority: enumSchema("P0", "P1", "P2"),
};

function semanticCriterionVerdict(priorFindingIds: string[]) {
  const requiredFinding = {
    ...commonCriterionFields,
    verdict: literalSchema("not_satisfied"),
    ...findingFields,
    recommendedDisposition: literalSchema("required_now"),
  };
  const requiredVariants = priorFindingIds.length === 0
    ? [objectSchema({ ...requiredFinding, findingOrigin: literalSchema("initial_review") })]
    : [
        objectSchema({
          ...requiredFinding,
          findingOrigin: literalSchema("prior_finding"),
          priorFindingId: enumSchema(...priorFindingIds),
        }),
        objectSchema({
          ...requiredFinding,
          findingOrigin: literalSchema("correction_regression"),
          priorFindingId: enumSchema(...priorFindingIds),
        }),
      ];
  return variantsSchema(
    satisfiedCriterionVerdict,
    objectSchema({
      ...commonCriterionFields,
      verdict: literalSchema("satisfied"),
      ...findingFields,
      recommendedDisposition: literalSchema("backlog"),
      findingOrigin: literalSchema("backlog_candidate"),
    }),
    ...requiredVariants,
  );
}

export type TaskReviewMode = "semantic" | "promotion_identity";

export function taskReviewSubmissionSchema(
  mode: TaskReviewMode,
  priorFindingIds: string[] = [],
) {
  const criterionVerdict = mode === "promotion_identity"
    ? satisfiedCriterionVerdict
    : semanticCriterionVerdict(priorFindingIds);
  return objectSchema({
    kind: literalSchema("task_review"),
    criterionVerdicts: arraySchema(criterionVerdict, { minItems: 1 }),
  });
}
