const text = { type: "string", minLength: 1 } as const;
const texts = { type: "array", items: text } as const;
const nonEmptyTexts = { type: "array", items: text, minItems: 1 } as const;
const scopeKind = {
  type: "string",
  enum: ["user", "project", "session", "global"],
} as const;
const boundary = {
  type: "string",
  enum: [
    "cross_project_user_preference",
    "project_bound_strategy",
    "session_bound_strategy",
    "global_phase_practice",
  ],
} as const;
const phase = {
  type: "string",
  enum: [
    "conception_opening", "assisted_answer", "conception_deliberation", "contract_review",
    "planning", "planning_review", "task_execution", "task_review",
    "feedback_conception", "feedback_planning", "feedback_planning_review",
    "consolidation", "reporting",
  ],
} as const;

const finding = closed({
  score: { type: "number", minimum: 1, maximum: 5 },
  assessment: text,
  sourceRefs: texts,
});

const candidate = closed({
  candidateId: text,
  phase,
  scopeKind,
  scopeRationale: text,
  scopeSourceRefs: nonEmptyTexts,
  generalityBoundary: boundary,
  problem: text,
  guidance: text,
  appliesWhen: texts,
  doesNotApplyWhen: texts,
  expectedBenefit: text,
  risks: texts,
  confidence: { type: "number", minimum: 0, maximum: 1 },
  sourceRefs: texts,
});

const outsideFinding = closed({ finding: text, requiredChange: text, sourceRefs: texts });

export const RETROSPECTIVE_RESPONSE_SCHEMA = closed({
  rubricRevision: { type: "string", const: "btcc.retrospective-rubric.v1" },
  summary: text,
  dimensions: closed({
    goal_fidelity: finding,
    conception_quality: finding,
    planning_quality: finding,
    ledger_fitness: finding,
    execution_fidelity: finding,
    review_effectiveness: finding,
    efficiency_and_proportionality: finding,
    user_stewardship: finding,
    learning_calibration: finding,
  }),
  strengths: texts,
  misses: texts,
  candidates: { type: "array", items: candidate },
  outsideLearningSurface: { type: "array", items: outsideFinding },
});

const decisionBase = {
  candidateId: text,
  guidanceId: text,
  rationale: text,
};

const acceptedFields = {
  ...decisionBase,
  acceptedScopeKind: scopeKind,
  acceptedScopeRationale: text,
  acceptedScopeSourceRefs: nonEmptyTexts,
  acceptedGeneralityBoundary: boundary,
  acceptedGuidance: text,
  acceptedAppliesWhen: texts,
  acceptedDoesNotApplyWhen: texts,
};

const guidanceScope = {
  anyOf: [
    closed({ kind: { type: "string", const: "user" }, userRef: text }),
    closed({ kind: { type: "string", const: "project" }, projectRef: text }),
    closed({ kind: { type: "string", const: "session" }, sessionId: text }),
    closed({ kind: { type: "string", const: "global" } }),
  ],
};

const targetRevision = closed({
  guidanceId: text,
  phase,
  scope: guidanceScope,
  revision: { type: "integer", minimum: 1 },
  contentSha256: text,
});

const promoteDecision = closed({
  ...acceptedFields,
  disposition: { type: "string", const: "promote" },
});

const revisionDecision = closed({
  ...acceptedFields,
  disposition: { type: "string", enum: ["merge", "supersede"] },
  targetRevision,
});

const declinedDecision = closed({
  ...decisionBase,
  disposition: {
    type: "string",
    enum: ["defer", "reject", "outside_learning_surface"],
  },
});

export const RETROSPECTIVE_DECISION_RESPONSE_SCHEMA = closed({
  contractRevision: { type: "string", const: "btcc.guidance-decision.v1" },
  decisions: {
    type: "array",
    items: { anyOf: [promoteDecision, revisionDecision, declinedDecision] },
  },
});

function closed(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
