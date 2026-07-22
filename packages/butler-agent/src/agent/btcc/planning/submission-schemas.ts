import {
  arraySchema,
  contentRefSchema,
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
    effectClass: literalSchema("none"),
    artifactPolicy: objectSchema({
      kind: literalSchema("workspace_artifact"),
      targetPath: textSchema(),
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
const specifications = arraySchema(objectSchema({
  logicalId: textSchema(),
  title: textSchema(),
  body: textSchema(),
}), { minItems: 1 });
const promotionSelectors = arraySchema(promotionSelector, { minItems: 1 });

export function revisedPlanSubmissionSchema(logicalIds: string[]): SubmissionSchema {
  return variantsSchema(...planVariants({}, logicalIds));
}

export function planCandidateSubmissionSchema(logicalIds: string[]): SubmissionSchema {
  return variantsSchema(...planVariants({ kind: literalSchema("plan_candidate") }, logicalIds));
}

function planVariants(
  prefix: Record<string, SubmissionSchema>,
  logicalIds: string[],
): SubmissionSchema[] {
  const base = { ...prefix, ...planFields };
  const variants = [
    objectSchema(base),
    objectSchema({ ...base, specifications }),
    objectSchema({ ...base, promotionSelectors }),
    objectSchema({ ...base, specifications, promotionSelectors }),
  ];
  if (logicalIds.length === 0) return variants;
  const governingSpecSelections = arraySchema(enumSchema(...logicalIds), { minItems: 1 });
  return [...variants,
    objectSchema({ ...base, governingSpecSelections }),
    objectSchema({ ...base, specifications, governingSpecSelections }),
    objectSchema({ ...base, governingSpecSelections, promotionSelectors }),
    objectSchema({ ...base, specifications, governingSpecSelections, promotionSelectors }),
  ];
}

const acceptedPlanReview = objectSchema({
  kind: literalSchema("planning_review"),
  verdict: literalSchema("accepted"),
  findings: arraySchema(textSchema(), { maxItems: 0 }),
});
export const planRevisionReviewSubmissionSchema = objectSchema({
  kind: literalSchema("planning_review"),
  verdict: literalSchema("revision_required"),
  findings: arraySchema(textSchema(), { minItems: 1 }),
});
export const planReviewSubmissionSchema = variantsSchema(
  acceptedPlanReview,
  planRevisionReviewSubmissionSchema,
);

const impact = variantsSchema(
  objectSchema({
    priorTaskRef: contentRefSchema(),
    disposition: enumSchema("unaffected", "revalidate", "rework", "replan"),
  }),
  objectSchema({
    priorTaskRef: contentRefSchema(),
    disposition: enumSchema("unaffected", "revalidate", "rework", "replan"),
    successorTaskRef: contentRefSchema(),
  }),
);

export function feedbackPlanSubmissionSchema(logicalIds: string[]): SubmissionSchema {
  const revisedPlan = revisedPlanSubmissionSchema(logicalIds);
  return variantsSchema(
  objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    correctionKind: literalSchema("implementation_repair"),
    correctionAction: textSchema(),
  }),
  objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    correctionKind: literalSchema("governing_revision"),
    correctionAction: textSchema(),
    revisedPlan,
    impactMap: arraySchema(impact, { minItems: 1 }),
  }),
  objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    correctionKind: literalSchema("authority_scope_revision"),
    correctionAction: textSchema(),
    revisedPlan,
    impactMap: arraySchema(impact, { minItems: 1 }),
    authorityChange: textSchema(),
  }),
  );
}

const feedbackReviewIdentity = {
  kind: literalSchema("feedback_planning_review"),
};

const acceptedFeedbackReview = {
  ...feedbackReviewIdentity,
  verdict: literalSchema("accepted"),
  findings: arraySchema(textSchema(), { maxItems: 0 }),
};

const revisionFeedbackReview = {
  ...feedbackReviewIdentity,
  verdict: literalSchema("revision_required"),
  findings: arraySchema(textSchema(), { minItems: 1 }),
};

function feedbackReviewVariants(fields: Record<string, SubmissionSchema>) {
  return [
    objectSchema({ ...acceptedFeedbackReview, ...fields }),
    objectSchema({ ...revisionFeedbackReview, ...fields }),
  ];
}

export const feedbackPlanReviewSubmissionSchema = variantsSchema(
  ...feedbackReviewVariants({}),
);
