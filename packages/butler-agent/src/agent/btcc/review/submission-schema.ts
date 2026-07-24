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
  findingRootCauseKeys: arraySchema(textSchema()),
};
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

function semanticRootFinding(priorFindingIds: string[]) {
  const requiredFinding = {
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
    objectSchema({
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
    ? objectSchema({
        ...commonCriterionFields,
        verdict: literalSchema("satisfied"),
      })
    : objectSchema({
        ...commonCriterionFields,
        verdict: enumSchema("satisfied", "not_satisfied"),
      });
  const rootFinding = mode === "promotion_identity"
    ? objectSchema({
        ...findingFields,
        recommendedDisposition: literalSchema("backlog"),
        findingOrigin: literalSchema("backlog_candidate"),
      })
    : semanticRootFinding(priorFindingIds);
  return objectSchema({
    kind: literalSchema("task_review"),
    criterionVerdicts: arraySchema(criterionVerdict, { minItems: 1 }),
    findings: arraySchema(rootFinding),
  });
}
