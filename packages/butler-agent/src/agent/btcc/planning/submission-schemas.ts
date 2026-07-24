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
  const governingSpec = logicalIds.length > 0
    ? enumSchema(...logicalIds)
    : textSchema();
  return objectSchema({
    ...prefix,
    ...planFields,
    specifications: arraySchema(specification),
    governingSpecSelections: arraySchema(governingSpec),
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
  priorFindingIds: string[] = [],
): SubmissionSchema {
  const findingFields = {
    rootCauseKey: textSchema(),
    affectedSubjectIds: arraySchema(enumSchema(...subjectIds), { minItems: 1 }),
    dimension: enumSchema(...REVIEW_DIMENSIONS),
    message: textSchema(),
    priority: enumSchema("P0", "P1", "P2"),
  };
  const subjectFinding = priorFindingIds.length === 0
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
    : variantsSchema(
        objectSchema({
          ...findingFields,
          recommendedDisposition: literalSchema("required_now"),
          findingOrigin: literalSchema("prior_finding"),
          priorFindingId: enumSchema(...priorFindingIds),
        }),
        objectSchema({
          ...findingFields,
          recommendedDisposition: literalSchema("backlog"),
          findingOrigin: literalSchema("backlog_candidate"),
        }),
      );
  const subjectCoverage = variantsSchema(
    objectSchema({
      subjectId: enumSchema(...subjectIds),
      verdict: literalSchema("passed"),
      findings: arraySchema(subjectFinding),
    }),
    objectSchema({
      subjectId: enumSchema(...subjectIds),
      verdict: literalSchema("failed"),
      findings: arraySchema(subjectFinding, { minItems: 1 }),
    }),
  );
  const reviewFields = {
    kind: literalSchema("planning_review"),
    coverage: reviewCoverage(),
    subjects: arraySchema(subjectCoverage, {
      minItems: subjectIds.length,
      maxItems: subjectIds.length,
    }),
  };
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

export function feedbackPlanReviewSubmissionSchema(priorFindingIds: string[]) {
  const baseFinding = {
    rootCauseKey: textSchema(),
    statement: textSchema(),
    priority: enumSchema("P0", "P1", "P2"),
  };
  const finding = priorFindingIds.length === 0
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
    : variantsSchema(
        objectSchema({
          ...baseFinding,
          recommendedDisposition: literalSchema("required_now"),
          findingOrigin: literalSchema("prior_finding"),
          priorFindingId: enumSchema(...priorFindingIds),
        }),
        objectSchema({
          ...baseFinding,
          recommendedDisposition: literalSchema("backlog"),
          findingOrigin: literalSchema("backlog_candidate"),
        }),
      );
  const fields = { findings: arraySchema(finding) };
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
