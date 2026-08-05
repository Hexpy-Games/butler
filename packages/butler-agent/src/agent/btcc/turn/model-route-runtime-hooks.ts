import type { BtccAgentLoop } from "../agent-loop/index.ts";
import {
  ModelRouteDurabilityError,
} from "../model-route/index.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";
import type {
  StateExecutionClaim,
  TurnRecord,
  TurnStateRepository,
} from "./contracts.ts";

type AgentRunInput = Parameters<BtccAgentLoop["run"]>[0];
type RouteRuntimeHooks = Pick<AgentRunInput,
  | "recordModelRouteEvent"
  | "loadModelRouteAttemptHistory"
  | "loadModelRoundAcceptance"
  | "recordModelRoundAcceptance"
>;

export function createModelRouteRuntimeHooks(input: {
  turn: TurnRecord;
  claim: StateExecutionClaim;
  turns: TurnStateRepository;
}): RouteRuntimeHooks {
  const routeAcceptanceReader = input.turns.loadModelRoundAcceptance?.bind(input.turns);
  const routeAcceptanceWriter = input.turns.recordModelRoundAcceptance?.bind(input.turns);
  const routeDigest = input.turn.modelRoute?.routeDigest ?? "unknown";

  return {
    recordModelRouteEvent: async (event) => {
      try {
        return await input.turns.recordModelRouteEvent?.({
          event,
          route: event.route,
          turnId: input.turn.turnId,
          expectedRevision: input.turn.revision,
          executionFence: input.turn.executionFence,
          claimId: input.claim.claimId,
        });
      } catch {
        throw new ModelRouteDurabilityError("attempt_event_write");
      }
    },
    loadModelRouteAttemptHistory: async (attempt) => {
      try {
        return await input.turns.loadModelRouteAttemptHistory?.({
          turnId: input.turn.turnId,
          routeDigest,
          ...attempt,
        }) ?? { started: [], failed: [], succeeded: [], abandoned: [] };
      } catch {
        throw new ModelRouteDurabilityError("attempt_history_read");
      }
    },
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
  return (acceptance) => reader({
    turnId: input.turn.turnId,
    routeDigest,
    checkpointId: input.claim.checkpointId,
    checkpointRevision: input.claim.checkpointRevision,
    ...acceptance,
  }).catch(() => {
    throw new ModelRouteDurabilityError("response_acceptance_read");
  });
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
    result: ModelRoundResult;
  }) => {
    try {
      await writer({
        ...acceptance,
        turnId: input.turn.turnId,
        expectedRevision: input.turn.revision,
        executionFence: input.turn.executionFence,
        claimId: input.claim.claimId,
        checkpointId: input.claim.checkpointId,
        checkpointRevision: input.claim.checkpointRevision,
        routeDigest,
      });
    } catch {
      throw new ModelRouteDurabilityError("response_acceptance_write");
    }
  };
}
