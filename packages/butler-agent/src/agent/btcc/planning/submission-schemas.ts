import {
  arraySchema,
  enumSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
  type SubmissionSchema,
} from "../core/index.ts";

const textList = () => arraySchema(textSchema());
const criterion = objectSchema({
  statement: textSchema(),
  question: textSchema(),
  sourceGoalFieldIds: arraySchema(enumSchema("request", "intended_result"), { minItems: 1 }),
  sourceRequiredOutcomeRefs: arraySchema(textSchema(), { minItems: 1 }),
});
const taskFields = {
  logicalId: textSchema(),
  intendedOutcome: textSchema(),
  dependencyTaskIds: textList(),
  targetScopeRefs: textList(),
  criteria: arraySchema(criterion, { minItems: 1 }),
};
const task = variantsSchema(
  objectSchema({ ...taskFields, effectClass: enumSchema("none", "external_effect") }),
  objectSchema({
    ...taskFields,
    effectClass: enumSchema("none", "external_effect"),
    artifactPolicy: objectSchema({
      kind: literalSchema("workspace_artifact"),
      workspacePath: textSchema(),
      mutationScope: variantsSchema(
        objectSchema({ kind: literalSchema("read_only") }),
        objectSchema({
          kind: literalSchema("contained_paths"),
          writablePaths: arraySchema(textSchema(), { minItems: 1 }),
        }),
      ),
    }),
  }),
  objectSchema({
    ...taskFields,
    effectClass: literalSchema("external_effect"),
    artifactPolicy: objectSchema({
      kind: literalSchema("repository_promotion"),
      targetPath: textSchema(),
    }),
  }),
);
const work = objectSchema({
  logicalId: textSchema(),
  outcome: textSchema(),
  dependencyWorkIds: textList(),
  tasks: arraySchema(task, { minItems: 1 }),
});
const planFields = {
  strategy: textSchema(),
  works: arraySchema(work, { minItems: 1 }),
  risks: arraySchema(variantsSchema(
    objectSchema({
      logicalId: textSchema(), statement: textSchema(), affectedTaskIds: textList(),
      mitigation: textSchema(),
    }),
    objectSchema({
      logicalId: textSchema(), statement: textSchema(), affectedTaskIds: textList(),
      mitigation: textSchema(), residualRisk: textSchema(),
    }),
  )),
  assumptions: arraySchema(objectSchema({
    logicalId: textSchema(), statement: textSchema(), affectedTaskIds: textList(),
    validationQuestion: textSchema(), invalidationConsequence: textSchema(),
  })),
  effectIntents: arraySchema(objectSchema({
    occurrenceKey: textSchema(), taskId: textSchema(),
    actionKind: enumSchema("external_operation", "repository_promotion"),
    action: textSchema(), payload: textSchema(), desiredOutcome: textSchema(),
    sourceGoalFieldIds: arraySchema(enumSchema("request", "intended_result"), { minItems: 1 }),
    sourceRequiredOutcomeRefs: arraySchema(textSchema(), { minItems: 1 }),
  })),
  integrationCriteria: arraySchema(objectSchema({
    logicalId: textSchema(), statement: textSchema(),
    sourceGoalFieldIds: arraySchema(enumSchema("request", "intended_result"), { minItems: 1 }),
    sourceRequiredOutcomeRefs: arraySchema(textSchema(), { minItems: 1 }),
    participatingTaskIds: arraySchema(textSchema(), { minItems: 1 }),
    integrationTaskId: textSchema(), promotionTaskId: textSchema(),
    observableCompatibility: textSchema(),
  })),
};
const promotionSelector = objectSchema({
  implementationTaskIds: textList(),
  integrationTaskId: textSchema(),
  promotionTaskId: textSchema(),
});
const specification = objectSchema({
  logicalId: textSchema(),
  parentId: textSchema(),
  concernId: textSchema(),
  title: textSchema(),
  body: textSchema(),
});

export function revisedPlanSubmissionSchema(logicalIds: string[]): SubmissionSchema {
  return canonicalPlanSchema({}, logicalIds);
}

export function planCandidateSubmissionSchema(
  logicalIds: string[],
  findingIds: string[] = [],
): SubmissionSchema {
  const prefix = {
    kind: literalSchema("plan_candidate"),
    ...(findingIds.length > 0 ? { findingDecisions: findingDecisionSchema(findingIds) } : {}),
  };
  return canonicalPlanSchema(prefix, logicalIds);
}

function canonicalPlanSchema(
  prefix: Record<string, SubmissionSchema>,
  logicalIds: string[],
): SubmissionSchema {
  return objectSchema({
    ...prefix,
    ...planFields,
    specifications: arraySchema(specification),
    governingSpecSelections: logicalIds.length > 0
      ? arraySchema(enumSchema(...logicalIds))
      : arraySchema(textSchema(), { maxItems: 0 }),
    promotionSelectors: arraySchema(promotionSelector),
  });
}

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

function reviewCoverage(): SubmissionSchema {
  return arraySchema(objectSchema({
    dimension: enumSchema(...REVIEW_DIMENSIONS),
    verdict: enumSchema("passed", "failed"),
  }), {
    minItems: REVIEW_DIMENSIONS.length,
    maxItems: REVIEW_DIMENSIONS.length,
  });
}

export function planReviewSubmissionSchema(
  subjectIds: string[],
  priorRootCauseKeys: string[] = [],
): SubmissionSchema {
  const findingFields = {
    rootCauseKey: textSchema(),
    affectedSubjectIds: arraySchema(enumSchema(...subjectIds), { minItems: 1 }),
    dimension: enumSchema(...REVIEW_DIMENSIONS),
    message: textSchema(),
    priority: enumSchema("P0", "P1", "P2"),
  };
  const rootFinding = priorRootCauseKeys.length === 0
    ? variantsSchema(
        objectSchema({
          ...findingFields,
          recommendedDisposition: literalSchema("required_now"),
          findingOrigin: literalSchema("initial_review"),
        }),
        objectSchema({
          ...findingFields,
          recommendedDisposition: literalSchema("backlog"),
          findingOrigin: literalSchema("backlog_candidate"),
        }),
      )
    : objectSchema({
        ...findingFields,
        recommendedDisposition: literalSchema("backlog"),
        findingOrigin: literalSchema("backlog_candidate"),
      });
  const subjectCoverage = objectSchema({
    subjectId: enumSchema(...subjectIds),
    verdict: enumSchema("passed", "failed"),
  });
  const reviewFields: Record<string, SubmissionSchema> = {
    kind: literalSchema("planning_review"),
    coverage: reviewCoverage(),
    findings: arraySchema(rootFinding),
    subjects: arraySchema(subjectCoverage, {
      minItems: subjectIds.length,
      maxItems: subjectIds.length,
    }),
  };
  if (priorRootCauseKeys.length > 0) {
    reviewFields.priorFindingVerdicts = arraySchema(objectSchema({
      rootCauseKey: enumSchema(...priorRootCauseKeys),
      verdict: enumSchema("resolved", "unresolved"),
      observation: textSchema(),
    }), {
      minItems: priorRootCauseKeys.length,
      maxItems: priorRootCauseKeys.length,
    });
  }
  return variantsSchema(
    objectSchema({ ...reviewFields, verdict: literalSchema("accepted") }),
    objectSchema({ ...reviewFields, verdict: literalSchema("revision_required") }),
  );
}

function findingDecisionSchema(findingIds: string[]): SubmissionSchema {
  return arraySchema(objectSchema({
    findingId: enumSchema(...findingIds),
    decision: enumSchema("apply_now", "dispute", "split_to_backlog"),
    rationale: textSchema(),
  }), {
    minItems: findingIds.length,
    maxItems: findingIds.length,
  });
}

const impact = variantsSchema(
  objectSchema({
    priorTaskLogicalId: textSchema(),
    disposition: enumSchema("unaffected", "revalidate", "rework", "replan"),
    reason: textSchema(),
  }),
  objectSchema({
    priorTaskLogicalId: textSchema(),
    disposition: enumSchema("unaffected", "revalidate", "rework", "replan"),
    successorTaskLogicalId: textSchema(),
    reason: textSchema(),
  }),
);

export function feedbackPlanSubmissionSchema(
  logicalIds: string[],
  correctionKind?:
    | "implementation_repair"
    | "governing_revision"
    | "authority_scope_revision",
  findingIds: string[] = [],
): SubmissionSchema {
  const revisedPlan = revisedPlanSubmissionSchema(logicalIds);
  const decisions: Record<string, SubmissionSchema> = findingIds.length > 0
    ? { findingDecisions: findingDecisionSchema(findingIds) }
    : {};
  const variants = {
    implementation_repair: objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    ...decisions,
    correctionKind: literalSchema("implementation_repair"),
    correctionAction: textSchema(),
  }),
    governing_revision: objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    ...decisions,
    correctionKind: literalSchema("governing_revision"),
    correctionAction: textSchema(),
    revisedPlan,
    impactMap: arraySchema(impact, { minItems: 1 }),
  }),
    authority_scope_revision: objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    ...decisions,
    correctionKind: literalSchema("authority_scope_revision"),
    correctionAction: textSchema(),
    revisedPlan,
    impactMap: arraySchema(impact, { minItems: 1 }),
    authorityChange: textSchema(),
  }),
  };
  return correctionKind
    ? variants[correctionKind]
    : variantsSchema(...Object.values(variants));
}

const feedbackReviewIdentity = {
  kind: literalSchema("feedback_planning_review"),
};

export function feedbackPlanReviewSubmissionSchema(priorRootCauseKeys: string[]) {
  const baseFinding = {
    rootCauseKey: textSchema(),
    statement: textSchema(),
    priority: enumSchema("P0", "P1", "P2"),
  };
  const finding = priorRootCauseKeys.length === 0
    ? variantsSchema(
        objectSchema({
          ...baseFinding,
          recommendedDisposition: literalSchema("required_now"),
          findingOrigin: literalSchema("initial_review"),
        }),
        objectSchema({
          ...baseFinding,
          recommendedDisposition: literalSchema("backlog"),
          findingOrigin: literalSchema("backlog_candidate"),
        }),
      )
    : objectSchema({
        ...baseFinding,
        recommendedDisposition: literalSchema("backlog"),
        findingOrigin: literalSchema("backlog_candidate"),
      });
  const fields: Record<string, SubmissionSchema> = {
    findings: arraySchema(finding),
  };
  if (priorRootCauseKeys.length > 0) {
    fields.priorFindingVerdicts = arraySchema(objectSchema({
      rootCauseKey: enumSchema(...priorRootCauseKeys),
      verdict: enumSchema("resolved", "unresolved"),
      observation: textSchema(),
    }), {
      minItems: priorRootCauseKeys.length,
      maxItems: priorRootCauseKeys.length,
    });
  }
  return variantsSchema(
    objectSchema({
      ...feedbackReviewIdentity,
      verdict: literalSchema("accepted"),
      ...fields,
    }),
    objectSchema({
      ...feedbackReviewIdentity,
      verdict: literalSchema("revision_required"),
      ...fields,
    }),
  );
}
