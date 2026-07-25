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
const refList = () => arraySchema(contentRefSchema());

const personalizationApplication = objectSchema({
  ref: textSchema(),
  decision: enumSchema("applied", "not_applicable"),
});
const publicClaim = objectSchema({
  claim: textSchema(),
  sourceRefs: refList(),
});
const answerFields = {
  requestObligation: textSchema(),
  interpretedIntent: textSchema(),
  requiredOutcome: textSchema(),
  requiredOutcomeResolution: enumSchema("fulfilled", "truthfully_limited"),
  nonGoals: textList(),
  answer: textSchema(),
  personalizationApplications: arraySchema(personalizationApplication),
  publicClaims: arraySchema(publicClaim),
};

export const openingSubmissionSchema = variantsSchema(
  objectSchema({
    kind: literalSchema("direct_answer"),
    requiredResultKind: literalSchema("response_content"),
    ...answerFields,
  }),
  openingContinuationSchema(
    "assisted_continuation",
    literalSchema("current_observation"),
  ),
  openingContinuationSchema(
    "managed_continuation",
    enumSchema("target_change", "persistent_artifact", "external_effect", "durable_work"),
  ),
);
export const assistedAnswerSubmissionSchema = objectSchema({
  kind: literalSchema("assisted_answer"),
  requiredResultKind: literalSchema("current_observation"),
  ...answerFields,
});

function openingContinuationSchema(
  kind: "assisted_continuation" | "managed_continuation",
  requiredResultKind: SubmissionSchema,
) {
  return objectSchema({
    kind: literalSchema(kind),
    requiredResultKind,
    requestObligation: textSchema(),
    summary: textSchema(),
    rationale: textSchema(),
    nextStep: textSchema(),
  });
}

const lensAssessment = objectSchema({
  disposition: enumSchema("adopted", "non_applicable"),
  assessment: textSchema(),
  adoptedGoalFieldIds: textList(),
});

function governingSpecApplicationsSchema(allowedLogicalIds: readonly string[]) {
  if (allowedLogicalIds.length === 0) {
    return arraySchema(objectSchema({
      logicalId: textSchema(),
      changeObligations: textList(),
      preservationConstraints: textList(),
    }), { maxItems: 0 });
  }
  return arraySchema(objectSchema({
    logicalId: enumSchema(...allowedLogicalIds),
    changeObligations: textList(),
    preservationConstraints: textList(),
  }));
}

export function goalCandidateSubmissionSchema(
  allowedGoverningSpecLogicalIds: readonly string[],
  priorRootCauseKeys: string[] = [],
) {
  return objectSchema({
    kind: literalSchema("goal_contract_candidate"),
    request: textSchema(),
    intendedResult: textSchema(),
    acceptanceIntent: textSchema(),
    artifactPersistence: enumSchema("not_required", "required"),
    nonGoals: textList(),
    personalizationRefs: textList(),
    governingSpecApplications: governingSpecApplicationsSchema(
      allowedGoverningSpecLogicalIds,
    ),
    lensAssessments: objectSchema({
      requested_content: lensAssessment,
      related_memory: lensAssessment,
      connected_current_knowledge: lensAssessment,
      user_preferences_and_resolution_style: lensAssessment,
      expert_perspective: lensAssessment,
      intended_result_and_acceptance: lensAssessment,
    }),
    ...(priorRootCauseKeys.length > 0
      ? {
          findingDecisions: arraySchema(objectSchema({
            rootCauseKey: enumSchema(...priorRootCauseKeys),
            decision: enumSchema("apply_now", "dispute", "split_to_backlog"),
            rationale: textSchema(),
          }), {
            minItems: priorRootCauseKeys.length,
            maxItems: priorRootCauseKeys.length,
          }),
        }
      : {}),
  });
}

const acceptedGoalReviewFields = {
  kind: literalSchema("goal_contract_review"),
  strategy: literalSchema("managed"),
  verdict: literalSchema("accepted"),
};
export const GOAL_REVIEW_SUBJECTS = [
  "goal:request",
  "goal:intended_result",
  "goal:acceptance_intent",
  "goal:artifact_persistence",
  "goal:governing_specs",
  "goal:non_goals",
  "lens:requested_content",
  "lens:related_memory",
  "lens:connected_current_knowledge",
  "lens:user_preferences_and_resolution_style",
  "lens:expert_perspective",
  "lens:intended_result_and_acceptance",
] as const;

export function goalReviewSubmissionSchema(priorRootCauseKeys: string[] = []) {
  const priorVerdicts: Record<string, SubmissionSchema> = priorRootCauseKeys.length > 0
    ? {
        priorFindingVerdicts: arraySchema(objectSchema({
          rootCauseKey: enumSchema(...priorRootCauseKeys),
          verdict: enumSchema("resolved", "unresolved"),
          observation: textSchema(),
        }), {
          minItems: priorRootCauseKeys.length,
          maxItems: priorRootCauseKeys.length,
        }),
      }
    : {};
  const initialCoverage: Record<string, SubmissionSchema> =
    priorRootCauseKeys.length === 0
      ? {
          subjects: arraySchema(objectSchema({
            subjectId: enumSchema(...GOAL_REVIEW_SUBJECTS),
            verdict: enumSchema("passed", "failed"),
          }), {
            minItems: GOAL_REVIEW_SUBJECTS.length,
            maxItems: GOAL_REVIEW_SUBJECTS.length,
          }),
        }
      : {};
  const accepted = [
    objectSchema({
      ...acceptedGoalReviewFields,
      ...initialCoverage,
      ...priorVerdicts,
    }),
    objectSchema({
      ...acceptedGoalReviewFields,
      continuationCandidateId: textSchema(),
      ...initialCoverage,
      ...priorVerdicts,
    }),
  ];
  if (priorRootCauseKeys.length > 0) {
    return variantsSchema(
      ...accepted,
      objectSchema({
        kind: literalSchema("goal_contract_review"),
        strategy: literalSchema("managed"),
        verdict: literalSchema("revision_required"),
        ...priorVerdicts,
      }),
    );
  }
  const finding = objectSchema({
    rootCauseKey: textSchema(),
    affectedSubjectIds: arraySchema(enumSchema(...GOAL_REVIEW_SUBJECTS), { minItems: 1 }),
    finding: textSchema(),
    priority: enumSchema("P0", "P1", "P2"),
    scopeRelation: enumSchema("current_goal", "governing_contract"),
    recommendedDisposition: literalSchema("required_now"),
    dispositionRationale: textSchema(),
  });
  return variantsSchema(
    ...accepted,
    objectSchema({
      kind: literalSchema("goal_contract_review"),
      strategy: literalSchema("managed"),
      verdict: literalSchema("revision_required"),
      ...initialCoverage,
      findings: arraySchema(finding, { minItems: 1 }),
    }),
  );
}

export function feedbackIntentSubmissionSchema(findingIds: string[]) {
  return objectSchema({
    kind: literalSchema("feedback_intent"),
    correctionKind: enumSchema(
      "implementation_repair",
      "governing_revision",
      "authority_scope_revision",
    ),
    intendedCorrection: textSchema(),
    ...(findingIds.length > 0
      ? {
          findingDecisions: arraySchema(objectSchema({
            findingId: enumSchema(...findingIds),
            decision: enumSchema("apply_now", "dispute", "split_to_backlog"),
            rationale: textSchema(),
          }), {
            minItems: findingIds.length,
            maxItems: findingIds.length,
          }),
        }
      : {}),
  });
}
