export const R2_ONLY_NONTERMINAL_TURN_STATES = [
  "conception_opening",
  "assisted_answer",
  "conception_deliberation",
  "contract_review",
  "planning",
  "planning_review",
  "work_frontier",
  "task_execution",
  "task_review",
  "feedback_conception",
  "feedback_planning",
  "feedback_planning_review",
  "consolidation",
  "reporting",
] as const;

export type R2OnlyNonterminalTurnState =
  typeof R2_ONLY_NONTERMINAL_TURN_STATES[number];

export const R3_PRESERVED_TURN_STATES = [
  "admitted",
  "delivery_committed",
  "delivered",
  "cancelled",
] as const;

export type R3PreservedTurnState = typeof R3_PRESERVED_TURN_STATES[number];

export type LegacyTurnCutoverBlocker = {
  turnId: string;
  kind:
    | "pending_external_effect"
    | "pending_repository_promotion"
    | "pending_project_ledger_promotion"
    | "pending_guided_effect"
    | "pending_operation_unreadable";
  referenceId: string;
  detail: string;
  capability?: string;
  target?: string;
};

export type PendingLegacyEffectReconciliation = {
  sourceOccurrenceId: string;
  capability: string;
  target: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
};

export type PendingLegacyTurnCutoverBlocker = LegacyTurnCutoverBlocker & {
  reconciliation?: PendingLegacyEffectReconciliation;
};

export type LegacyTurnCutoverDiagnostic = {
  turnId: string;
  code:
    | "unknown_semantic_state"
    | "cutover_evidence_turn_missing"
    | "cutover_evidence_state_reverted"
    | "unsafe_legacy_reentry_evidence"
    | "legacy_delivery_state_conflict"
    | "cutover_cas_conflict";
  semanticState?: string;
  detail: string;
};

export type LegacyTurnCutoverCompleted = {
  kind: "completed";
  convertedTurnIds: string[];
  replayedTurnIds: string[];
  preservedTurnIds: string[];
  quarantinedTurnIds: string[];
  blockers: LegacyTurnCutoverBlocker[];
  diagnostics: LegacyTurnCutoverDiagnostic[];
};

export type LegacyTurnCutoverResult = LegacyTurnCutoverCompleted;

export type LegacyTurnCutoverEvidence = {
  schema: "btcc.r3.legacy-turn-cutover.v2";
  turnId: string;
  source: {
    semanticState: R2OnlyNonterminalTurnState;
    turnRevision: number;
    executionFence: number;
    activeCheckpointId: string | null;
    activeCheckpointRevision: number | null;
    route: string | null;
    openingAnswerSha256: string | null;
    managedStateSha256: string | null;
    finalPayloadSha256: string | null;
    goalContractRef: string | null;
    finalDossierRef: string | null;
    deliveryOutboxId: string | null;
    canonicalAssistantMessageId: string | null;
    finalDisposition: string | null;
    activeClaimIds: string[];
    pendingInterruptionIds: string[];
    openContentionIds: string[];
  };
  target: {
    semanticState: "delivery_committed";
    turnRevision: number;
    executionFence: number;
    checkpointId: string;
    checkpointRevision: 0;
    checkpointKind: "runtime";
  };
  safetyBlockers: LegacyTurnCutoverBlocker[];
  cutoverAt: string;
};
