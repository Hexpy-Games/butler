import {
  arraySchema,
  contentRefSchema,
  enumSchema,
  integerSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
  type SubmissionSchema,
} from "../core/index.ts";

const textList = () => arraySchema(textSchema());
const refList = () => arraySchema(contentRefSchema());

const criterion = objectSchema({
  statement: textSchema(),
  question: textSchema(),
  sourceGoalFieldIds: arraySchema(enumSchema("request", "intended_result"), { minItems: 1 }),
  sourceRequiredOutcomeRefs: textList(),
});
const taskFields = {
  logicalId: textSchema(),
  intendedOutcome: textSchema(),
  executionOrdinal: integerSchema(),
  dependencyTaskIds: textList(),
  targetScopeRefs: textList(),
  criteria: arraySchema(criterion, { minItems: 1 }),
};
const task = variantsSchema(
  objectSchema(taskFields),
  objectSchema({
    ...taskFields,
    artifactPolicy: objectSchema({
      kind: literalSchema("workspace_artifact"),
      targetScopeRef: textSchema(),
      baselinePolicy: literalSchema("capture_at_workspace_provision"),
    }),
  }),
  objectSchema({
    ...taskFields,
    artifactPolicy: objectSchema({
      kind: literalSchema("repository_promotion"),
      targetScopeRef: textSchema(),
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
};
const promotionSelector = objectSchema({
  targetScopeRef: textSchema(),
  implementationTaskIds: textList(),
  integrationTaskId: textSchema(),
  promotionTaskId: textSchema(),
  baselinePolicy: literalSchema("capture_at_workspace_provision"),
});

export const revisedPlanSubmissionSchema = variantsSchema(
  objectSchema(planFields),
  objectSchema({ ...planFields, promotionSelectors: arraySchema(promotionSelector, { minItems: 1 }) }),
);

export const planCandidateSubmissionSchema = variantsSchema(
  objectSchema({ kind: literalSchema("plan_candidate"), ...planFields }),
  objectSchema({
    kind: literalSchema("plan_candidate"),
    ...planFields,
    promotionSelectors: arraySchema(promotionSelector, { minItems: 1 }),
  }),
);

export const planReviewSubmissionSchema = objectSchema({
  kind: literalSchema("planning_review"),
  candidateRef: contentRefSchema(),
  reviewedBundleRef: contentRefSchema(),
  reviewedWorkGraphRef: contentRefSchema(),
  reviewedWorkRefs: refList(),
  reviewedTaskRefs: refList(),
  reviewedCriterionRefs: refList(),
  reviewedVerificationQuestionRefs: refList(),
  reviewedArtifactLifecycleRef: contentRefSchema(),
  reviewedGoalFieldIds: textList(),
  reviewedRequiredOutcomeRefs: textList(),
  verdict: enumSchema("accepted", "revision_required"),
  findings: textList(),
});

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

export const feedbackPlanSubmissionSchema: SubmissionSchema = variantsSchema(
  objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    correctionKind: literalSchema("implementation_repair"),
    correctionAction: textSchema(),
  }),
  objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    correctionKind: literalSchema("governing_revision"),
    correctionAction: textSchema(),
    revisedPlan: revisedPlanSubmissionSchema,
    impactMap: arraySchema(impact, { minItems: 1 }),
  }),
  objectSchema({
    kind: literalSchema("feedback_plan_candidate"),
    correctionKind: literalSchema("authority_scope_revision"),
    correctionAction: textSchema(),
    revisedPlan: revisedPlanSubmissionSchema,
    impactMap: arraySchema(impact, { minItems: 1 }),
    authorityChange: textSchema(),
  }),
);

const feedbackReviewFields = {
  kind: literalSchema("feedback_planning_review"),
  candidateRef: contentRefSchema(),
  reviewedCorrectionPlanRef: contentRefSchema(),
  verdict: enumSchema("accepted", "revision_required"),
  findings: textList(),
};
export const feedbackPlanReviewSubmissionSchema = variantsSchema(
  objectSchema({
    ...feedbackReviewFields,
    correctionKind: literalSchema("implementation_repair"),
  }),
  objectSchema({
    ...feedbackReviewFields,
    correctionKind: literalSchema("governing_revision"),
    reviewedNextPlanCandidateRef: contentRefSchema(),
    reviewedImpactMap: arraySchema(impact, { minItems: 1 }),
  }),
  objectSchema({
    ...feedbackReviewFields,
    correctionKind: literalSchema("authority_scope_revision"),
    reviewedNextPlanCandidateRef: contentRefSchema(),
    reviewedImpactMap: arraySchema(impact, { minItems: 1 }),
    reviewedAuthorityRef: contentRefSchema(),
  }),
);
