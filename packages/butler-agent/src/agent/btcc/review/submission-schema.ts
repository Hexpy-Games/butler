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

function semanticRootFinding(priorRootCauseKeys: string[]) {
  const requiredFinding = {
    ...findingFields,
    recommendedDisposition: literalSchema("required_now"),
  };
  const requiredVariants = priorRootCauseKeys.length === 0
    ? [objectSchema({ ...requiredFinding, findingOrigin: literalSchema("initial_review") })]
    : [];
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
  priorRootCauseKeys: string[] = [],
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
    : semanticRootFinding(priorRootCauseKeys);
  const fields = {
    kind: literalSchema("task_review"),
    criterionVerdicts: arraySchema(criterionVerdict, { minItems: 1 }),
    findings: arraySchema(rootFinding),
  };
  return priorRootCauseKeys.length === 0
    ? objectSchema(fields)
    : objectSchema({
        ...fields,
        priorFindingVerdicts: arraySchema(objectSchema({
          rootCauseKey: enumSchema(...priorRootCauseKeys),
          verdict: enumSchema("resolved", "unresolved", "regressed"),
          observation: textSchema(),
        }), {
          minItems: priorRootCauseKeys.length,
          maxItems: priorRootCauseKeys.length,
        }),
      });
}
