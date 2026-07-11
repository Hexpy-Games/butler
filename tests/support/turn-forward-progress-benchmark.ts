export interface TurnForwardProgressMetrics {
  modelRequests: number;
  toolCalls: number;
  promptTokens: number;
  noDeltaBroadReadRounds: number;
  ledgerMutations: number;
  openingDecisions: number;
  contractConflicts: number;
  genericInternalFailures: number;
  liveReplayParity: boolean;
}

export const SANDY_FORWARD_PROGRESS_BASELINE = Object.freeze({
  modelRequests: 32,
  toolCalls: 65,
  promptTokens: 354_755,
  hardGuardFailures: 39,
  continuationEvents: 31,
  ledgerMutations: 0,
});

export const SANDY_FORWARD_PROGRESS_GATES = Object.freeze({
  maxModelRequests: 8,
  maxToolCalls: 18,
  maxPromptTokens: Math.floor(SANDY_FORWARD_PROGRESS_BASELINE.promptTokens * 0.4),
  maxNoDeltaBroadReadRounds: 0,
  minLedgerMutations: 1,
  expectedOpeningDecisions: 1,
  maxContractConflicts: 0,
  maxGenericInternalFailures: 0,
});

export interface TurnForwardProgressGateResult {
  ok: boolean;
  failures: string[];
  promptTokenReduction: number;
}

export function evaluateSandyForwardProgress(
  metrics: TurnForwardProgressMetrics,
): TurnForwardProgressGateResult {
  const failures: string[] = [];
  if (metrics.modelRequests > SANDY_FORWARD_PROGRESS_GATES.maxModelRequests) {
    failures.push("model_requests");
  }
  if (metrics.toolCalls > SANDY_FORWARD_PROGRESS_GATES.maxToolCalls) {
    failures.push("tool_calls");
  }
  if (metrics.promptTokens > SANDY_FORWARD_PROGRESS_GATES.maxPromptTokens) {
    failures.push("prompt_tokens");
  }
  if (metrics.noDeltaBroadReadRounds > SANDY_FORWARD_PROGRESS_GATES.maxNoDeltaBroadReadRounds) {
    failures.push("no_delta_broad_reads");
  }
  if (metrics.ledgerMutations < SANDY_FORWARD_PROGRESS_GATES.minLedgerMutations) {
    failures.push("ledger_mutations");
  }
  if (metrics.openingDecisions !== SANDY_FORWARD_PROGRESS_GATES.expectedOpeningDecisions) {
    failures.push("opening_decisions");
  }
  if (metrics.contractConflicts > SANDY_FORWARD_PROGRESS_GATES.maxContractConflicts) {
    failures.push("contract_conflicts");
  }
  if (metrics.genericInternalFailures > SANDY_FORWARD_PROGRESS_GATES.maxGenericInternalFailures) {
    failures.push("generic_internal_failures");
  }
  if (!metrics.liveReplayParity) failures.push("live_replay_parity");
  return {
    ok: failures.length === 0,
    failures,
    promptTokenReduction: 1 - metrics.promptTokens / SANDY_FORWARD_PROGRESS_BASELINE.promptTokens,
  };
}
