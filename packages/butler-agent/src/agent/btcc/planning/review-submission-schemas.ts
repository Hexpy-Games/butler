import {
  arraySchema,
  enumSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
  type SubmissionSchema,
} from "../core/index.ts";

const REVIEW_DIMENSIONS = [
  "original_goal",
  "governing_specs",
  "work_cohesion",
  "task_executability",
  "dependencies",
  "verification_integration",
  "effect_authority",
  "artifact_lifecycle",
] as const;

export function planReviewSubmissionSchema(
  subjectIds: string[],
  priorRootCauseKeys: string[] = [],
): SubmissionSchema {
  const reviewFields: Record<string, SubmissionSchema> = {
    kind: literalSchema("planning_review"),
    coverage: reviewCoverage(),
    findings: findingsSchema(subjectIds, priorRootCauseKeys),
    subjects: subjectCoverageSchema(subjectIds),
  };
  if (priorRootCauseKeys.length > 0) {
    reviewFields.priorFindingVerdicts =
      priorFindingVerdicts(priorRootCauseKeys);
  }
  return reviewVerdictVariants(reviewFields);
}

export function feedbackPlanReviewSubmissionSchema(
  priorRootCauseKeys: string[],
): SubmissionSchema {
  const fields: Record<string, SubmissionSchema> = {
    kind: literalSchema("feedback_planning_review"),
    findings: feedbackFindingsSchema(priorRootCauseKeys),
  };
  if (priorRootCauseKeys.length > 0) {
    fields.priorFindingVerdicts = priorFindingVerdicts(priorRootCauseKeys);
  }
  return reviewVerdictVariants(fields);
}

function reviewCoverage(): SubmissionSchema {
  return arraySchema(
    objectSchema({
      dimension: enumSchema(...REVIEW_DIMENSIONS),
      verdict: enumSchema("passed", "failed"),
    }),
    {
      minItems: REVIEW_DIMENSIONS.length,
      maxItems: REVIEW_DIMENSIONS.length,
    },
  );
}

function subjectCoverageSchema(subjectIds: string[]): SubmissionSchema {
  return arraySchema(
    objectSchema({
      subjectId: enumSchema(...subjectIds),
      verdict: enumSchema("passed", "failed"),
    }),
    { minItems: subjectIds.length, maxItems: subjectIds.length },
  );
}

function findingsSchema(
  subjectIds: string[],
  priorRootCauseKeys: string[],
): SubmissionSchema {
  const fields = {
    rootCauseKey: textSchema(),
    affectedSubjectIds: arraySchema(enumSchema(...subjectIds), { minItems: 1 }),
    dimension: enumSchema(...REVIEW_DIMENSIONS),
    message: textSchema(),
    priority: enumSchema("P0", "P1", "P2"),
    scopeRelation: enumSchema(
      "current_plan",
      "governing_contract",
      "outside_current_scope",
    ),
    dispositionRationale: textSchema(),
  };
  const finding =
    priorRootCauseKeys.length === 0
      ? variantsSchema(
          objectSchema({
            ...fields,
            recommendedDisposition: literalSchema("required_now"),
            findingOrigin: literalSchema("initial_review"),
          }),
          objectSchema({
            ...fields,
            recommendedDisposition: literalSchema("backlog"),
            findingOrigin: literalSchema("backlog_candidate"),
          }),
        )
      : objectSchema({
          ...fields,
          recommendedDisposition: literalSchema("backlog"),
          findingOrigin: literalSchema("backlog_candidate"),
        });
  return arraySchema(
    finding,
    priorRootCauseKeys.length > 0 ? { maxItems: 0 } : {},
  );
}

function feedbackFindingsSchema(
  priorRootCauseKeys: string[],
): SubmissionSchema {
  const fields = {
    rootCauseKey: textSchema(),
    statement: textSchema(),
    priority: enumSchema("P0", "P1", "P2"),
    scopeRelation: enumSchema(
      "current_correction",
      "governing_contract",
      "outside_current_scope",
    ),
    dispositionRationale: textSchema(),
  };
  const finding =
    priorRootCauseKeys.length === 0
      ? variantsSchema(
          objectSchema({
            ...fields,
            recommendedDisposition: literalSchema("required_now"),
            findingOrigin: literalSchema("initial_review"),
          }),
          objectSchema({
            ...fields,
            recommendedDisposition: literalSchema("backlog"),
            findingOrigin: literalSchema("backlog_candidate"),
          }),
        )
      : objectSchema({
          ...fields,
          recommendedDisposition: literalSchema("backlog"),
          findingOrigin: literalSchema("backlog_candidate"),
        });
  return arraySchema(
    finding,
    priorRootCauseKeys.length > 0 ? { maxItems: 0 } : {},
  );
}

function priorFindingVerdicts(rootCauseKeys: string[]): SubmissionSchema {
  return arraySchema(
    objectSchema({
      rootCauseKey: enumSchema(...rootCauseKeys),
      verdict: enumSchema("resolved", "unresolved"),
      observation: textSchema(),
    }),
    { minItems: rootCauseKeys.length, maxItems: rootCauseKeys.length },
  );
}

function reviewVerdictVariants(
  fields: Record<string, SubmissionSchema>,
): SubmissionSchema {
  return variantsSchema(
    objectSchema({ ...fields, verdict: literalSchema("accepted") }),
    objectSchema({ ...fields, verdict: literalSchema("revision_required") }),
  );
}
