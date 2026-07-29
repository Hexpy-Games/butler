import {
  arraySchema,
  enumSchema,
  literalSchema,
  objectSchema,
  textSchema,
  variantsSchema,
  type SubmissionSchema,
} from "../core/index.ts";
import { DISPLAY_TITLE_MAX_LENGTH } from "../core/display-title.ts";

export {
  feedbackPlanReviewSubmissionSchema,
  planReviewSubmissionSchema,
} from "./review-submission-schemas.ts";

const textList = () => arraySchema(textSchema());
const criterion = objectSchema({
  statement: textSchema(),
  question: textSchema(),
  sourceGoalFieldIds: arraySchema(enumSchema("request", "intended_result"), {
    minItems: 1,
  }),
  sourceRequiredOutcomeRefs: arraySchema(textSchema(), { minItems: 1 }),
});
const taskFields = {
  logicalId: textSchema(),
  displayTitle: {
    type: "string",
    minLength: 1,
    maxLength: DISPLAY_TITLE_MAX_LENGTH,
  },
  intendedOutcome: textSchema(),
  dependencyTaskIds: textList(),
  targetScopeRefs: textList(),
  criteria: arraySchema(criterion, { minItems: 1 }),
};
const task = variantsSchema(
  objectSchema({
    ...taskFields,
    effectClass: enumSchema("none", "external_effect"),
  }),
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
  works: arraySchema(work),
  risks: arraySchema(
    variantsSchema(
      objectSchema({
        logicalId: textSchema(),
        statement: textSchema(),
        affectedTaskIds: textList(),
        mitigation: textSchema(),
      }),
      objectSchema({
        logicalId: textSchema(),
        statement: textSchema(),
        affectedTaskIds: textList(),
        mitigation: textSchema(),
        residualRisk: textSchema(),
      }),
    ),
  ),
  assumptions: arraySchema(
    objectSchema({
      logicalId: textSchema(),
      statement: textSchema(),
      affectedTaskIds: textList(),
      validationQuestion: textSchema(),
      invalidationConsequence: textSchema(),
    }),
  ),
  effectIntents: arraySchema(
    objectSchema({
      occurrenceKey: textSchema(),
      taskId: textSchema(),
      actionKind: enumSchema("external_target_mutation", "repository_promotion"),
      action: textSchema(),
      payload: textSchema(),
      desiredOutcome: textSchema(),
      sourceGoalFieldIds: arraySchema(
        enumSchema("request", "intended_result"),
        { minItems: 1 },
      ),
      sourceRequiredOutcomeRefs: arraySchema(textSchema(), { minItems: 1 }),
    }),
  ),
  integrationCriteria: arraySchema(
    objectSchema({
      logicalId: textSchema(),
      statement: textSchema(),
      sourceGoalFieldIds: arraySchema(
        enumSchema("request", "intended_result"),
        { minItems: 1 },
      ),
      sourceRequiredOutcomeRefs: arraySchema(textSchema(), { minItems: 1 }),
      participatingTaskIds: arraySchema(textSchema(), { minItems: 1 }),
      integrationTaskId: textSchema(),
      promotionTaskId: textSchema(),
      observableCompatibility: textSchema(),
    }),
  ),
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

export function revisedPlanSubmissionSchema(
  logicalIds: string[],
): SubmissionSchema {
  return canonicalPlanSchema({}, logicalIds);
}

export function planCandidateSubmissionSchema(
  logicalIds: string[],
  findingIds: string[] = [],
  resumeStoppedPlan = false,
): SubmissionSchema {
  const prefix = {
    kind: literalSchema(resumeStoppedPlan ? "stopped_plan_resume" : "plan_candidate"),
    ...(findingIds.length > 0
      ? { findingDecisions: findingDecisionSchema(findingIds) }
      : {}),
  };
  if (resumeStoppedPlan) return objectSchema(prefix);
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
    governingSpecSelections:
      logicalIds.length > 0
        ? arraySchema(enumSchema(...logicalIds))
        : arraySchema(textSchema(), { maxItems: 0 }),
    promotionSelectors: arraySchema(promotionSelector),
  });
}

function findingDecisionSchema(findingIds: string[]): SubmissionSchema {
  return arraySchema(
    objectSchema({
      findingId: enumSchema(...findingIds),
      decision: enumSchema("apply_now", "dispute", "split_to_backlog"),
      rationale: textSchema(),
    }),
    {
      minItems: findingIds.length,
      maxItems: findingIds.length,
    },
  );
}

const impact = variantsSchema(
  objectSchema({
    priorTaskLogicalId: textSchema(),
    disposition: literalSchema("replan"),
    reason: textSchema(),
  }),
  objectSchema({
    priorTaskLogicalId: textSchema(),
    disposition: enumSchema("unaffected", "rework"),
    successorTaskLogicalId: textSchema(),
    reason: textSchema(),
  }),
  objectSchema({
    priorTaskLogicalId: textSchema(),
    disposition: literalSchema("revalidate"),
    successorTaskLogicalId: textSchema(),
    revalidationPrerequisiteTaskLogicalIds: arraySchema(textSchema()),
    reason: textSchema(),
  }),
);

const correctionExecutionRequirement = variantsSchema(
  objectSchema({ kind: literalSchema("observation_only") }),
  objectSchema({
    kind: literalSchema("workspace_mutation"),
    workspaceScopeRef: textSchema(),
    writablePaths: arraySchema(textSchema(), { minItems: 1 }),
  }),
);

export function feedbackPlanSubmissionSchema(
  logicalIds: string[],
  correctionKind?:
    | "implementation_repair"
    | "governing_revision"
    | "authority_scope_revision",
  findingIds: string[] = [],
  currentTaskCount = 1,
): SubmissionSchema {
  const revisedPlan = revisedPlanSubmissionSchema(logicalIds);
  const decisions: Record<string, SubmissionSchema> =
    findingIds.length > 0
      ? { findingDecisions: findingDecisionSchema(findingIds) }
      : {};
  const variants = {
    implementation_repair: objectSchema({
      kind: literalSchema("feedback_plan_candidate"),
      ...decisions,
      correctionKind: literalSchema("implementation_repair"),
      correctionAction: textSchema(),
      executionRequirement: correctionExecutionRequirement,
    }),
    governing_revision: objectSchema({
      kind: literalSchema("feedback_plan_candidate"),
      ...decisions,
      correctionKind: literalSchema("governing_revision"),
      correctionAction: textSchema(),
      executionRequirement: correctionExecutionRequirement,
      revisedPlan,
      impactMap: arraySchema(impact, {
        minItems: currentTaskCount,
        maxItems: currentTaskCount,
      }),
    }),
    authority_scope_revision: objectSchema({
      kind: literalSchema("feedback_plan_candidate"),
      ...decisions,
      correctionKind: literalSchema("authority_scope_revision"),
      correctionAction: textSchema(),
      executionRequirement: correctionExecutionRequirement,
      revisedPlan,
      impactMap: arraySchema(impact, {
        minItems: currentTaskCount,
        maxItems: currentTaskCount,
      }),
      authorityChange: textSchema(),
    }),
  };
  return correctionKind
    ? variants[correctionKind]
    : variantsSchema(...Object.values(variants));
}
