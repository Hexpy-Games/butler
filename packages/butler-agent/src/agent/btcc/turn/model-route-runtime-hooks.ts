import type { BtccAgentLoop } from "../agent-loop/index.ts";
import {
  ModelRouteDurabilityError,
} from "../model-route/index.ts";
import type { ModelRouteDurabilityPhase } from "../model-route/index.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";
import { isSqliteContention } from "../../../foundation/sqlite-contention.ts";
import type {
  StateExecutionClaim,
  TurnRecord,
  TurnStateRepository,
} from "./contracts.ts";
import { isTurnContinuationBudgetExhaustedError } from
  "./continuation-budget.ts";

type AgentRunInput = Parameters<BtccAgentLoop["run"]>[0];
type RouteRuntimeHooks = Pick<AgentRunInput,
  | "recordModelRouteEvent"
  | "loadModelRouteAttemptHistory"
  | "loadModelRoundAcceptance"
  | "recordModelRoundAcceptance"
  | "executionClaim"
>;

const MAX_DURABILITY_ATTEMPTS = 3;

export function createModelRouteRuntimeHooks(input: {
  turn: TurnRecord;
  claim: StateExecutionClaim;
  turns: TurnStateRepository;
}): RouteRuntimeHooks {
  const routeAcceptanceReader = input.turns.loadModelRoundAcceptance?.bind(input.turns);
  const routeAcceptanceWriter = input.turns.recordModelRoundAcceptance?.bind(input.turns);
  const routeDigest = input.turn.modelRoute?.routeDigest ?? "unknown";

  return {
    executionClaim: input.claim,
    recordModelRouteEvent: (event) => withDurabilityRetry(
      "attempt_event_write",
      () => input.turns.recordModelRouteEvent?.({
        event,
        route: event.route,
        turnId: input.turn.turnId,
        expectedRevision: input.turn.revision,
        executionFence: input.turn.executionFence,
        claimId: input.claim.claimId,
      }),
    ),
    loadModelRouteAttemptHistory: (attempt) => withDurabilityRetry(
      "attempt_history_read",
      async () => await input.turns.loadModelRouteAttemptHistory?.({
        turnId: input.turn.turnId,
        routeDigest,
        ...attempt,
      }) ?? { started: [], failed: [], succeeded: [], abandoned: [] },
    ),
    ...(routeAcceptanceReader
      ? { loadModelRoundAcceptance: loadAcceptance(routeAcceptanceReader, input, routeDigest) }
      : {}),
    ...(routeAcceptanceWriter
      ? { recordModelRoundAcceptance: recordAcceptance(routeAcceptanceWriter, input, routeDigest) }
      : {}),
  };
}

function loadAcceptance(
  reader: NonNullable<TurnStateRepository["loadModelRoundAcceptance"]>,
  input: { turn: TurnRecord; claim: StateExecutionClaim },
  routeDigest: string,
): NonNullable<RouteRuntimeHooks["loadModelRoundAcceptance"]> {
  return (acceptance) => withDurabilityRetry(
    "response_acceptance_read",
    () => reader({
      turnId: input.turn.turnId,
      routeDigest,
      checkpointId: input.claim.checkpointId,
      checkpointRevision: input.claim.checkpointRevision,
      ...acceptance,
    }),
  );
}

function recordAcceptance(
  writer: NonNullable<TurnStateRepository["recordModelRoundAcceptance"]>,
  input: { turn: TurnRecord; claim: StateExecutionClaim },
  routeDigest: string,
): NonNullable<RouteRuntimeHooks["recordModelRoundAcceptance"]> {
  return async (acceptance: {
    roundId: string;
    candidateIndex: number;
    transportAttempt: number;
    modelRef: string;
    continuationBudgetEnabled?: boolean;
    requestHash?: string;
    serializedRequestBytes?: number;
    durableResultRefCount?: number;
    result: ModelRoundResult;
  }) => {
    return withDurabilityRetry("response_acceptance_write", () => writer({
      ...acceptance,
      turnId: input.turn.turnId,
      expectedRevision: input.turn.revision,
      executionFence: input.turn.executionFence,
      claimId: input.claim.claimId,
      checkpointId: input.claim.checkpointId,
      checkpointRevision: input.claim.checkpointRevision,
      routeDigest,
    }));
  };
}

async function withDurabilityRetry<T>(
  phase: ModelRouteDurabilityPhase,
  operation: () => Promise<T> | T,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_DURABILITY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isTurnContinuationBudgetExhaustedError(error)) throw error;
      lastError = error;
      if (!isSqliteContention(error) || attempt === MAX_DURABILITY_ATTEMPTS) {
        throw new ModelRouteDurabilityError(phase, error);
      }
      // Let an already-active writer release its turn before the next bounded
      // attempt; this is deliberately a microtask handoff, not timer polling.
      await Promise.resolve();
    }
  }
  throw new ModelRouteDurabilityError(phase, lastError);
}
