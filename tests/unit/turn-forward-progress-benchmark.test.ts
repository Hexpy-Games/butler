import { expect, test } from "bun:test";
import {
  evaluateSandyForwardProgress,
  SANDY_FORWARD_PROGRESS_BASELINE,
  SANDY_FORWARD_PROGRESS_GATES,
} from "../support/turn-forward-progress-benchmark.ts";

test("Sandy regression baseline remains the benchmark authority", () => {
  expect(SANDY_FORWARD_PROGRESS_BASELINE).toEqual({
    modelRequests: 32,
    toolCalls: 65,
    promptTokens: 354_755,
    hardGuardFailures: 39,
    continuationEvents: 31,
    ledgerMutations: 0,
  });
  expect(SANDY_FORWARD_PROGRESS_GATES).toMatchObject({
    maxModelRequests: 8,
    maxToolCalls: 18,
    maxNoDeltaBroadReadRounds: 0,
    minLedgerMutations: 1,
    expectedOpeningDecisions: 1,
  });
});

test("benchmark rejects a fast turn that still fails to move durable state", () => {
  const result = evaluateSandyForwardProgress({
    modelRequests: 5,
    toolCalls: 8,
    promptTokens: 80_000,
    noDeltaBroadReadRounds: 0,
    ledgerMutations: 0,
    openingDecisions: 1,
    contractConflicts: 0,
    genericInternalFailures: 0,
    liveReplayParity: true,
  });
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual(["ledger_mutations"]);
});

test("benchmark accepts a bounded forward-progress turn", () => {
  const result = evaluateSandyForwardProgress({
    modelRequests: 7,
    toolCalls: 16,
    promptTokens: 120_000,
    noDeltaBroadReadRounds: 0,
    ledgerMutations: 4,
    openingDecisions: 1,
    contractConflicts: 0,
    genericInternalFailures: 0,
    liveReplayParity: true,
  });
  expect(result.ok).toBe(true);
  expect(result.promptTokenReduction).toBeGreaterThanOrEqual(0.6);
});
