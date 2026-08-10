import type {
  BtccProgressDestination,
  BtccProgressEventRepository,
  BtccStopRequest,
  BtccTurnPreparation,
  BtccTurnOutcome,
  BtccTurnRequest,
  BtccTurnRuntime,
} from "../contracts.ts";
import { projectTurnProgressToEvents } from "../projection/index.ts";
import type { TurnStateRepository } from "./contracts.ts";

export type TurnFacadeDependencies = {
  runtime: BtccTurnRuntime;
  preparation: BtccTurnPreparation;
  progressEvents: BtccProgressEventRepository;
  turns: Pick<TurnStateRepository, "findTurn">;
};

export type TurnFacade = {
  run(request: BtccTurnRequest): Promise<BtccTurnOutcome>;
  stop(request: BtccStopRequest): Promise<BtccTurnOutcome>;
};

/**
 * The single Turn boundary used by BTCC. Preparation, admission progress,
 * finalization, and Stop projection are owned here; BTCC only sequences it.
 */
export function createTurnFacade(dependencies: TurnFacadeDependencies): TurnFacade {
  return {
    run: (request) => runPreparedTurn(request, dependencies),
    stop: (request) => stopPreparedTurn(request, dependencies),
  };
}

async function runPreparedTurn(
  request: BtccTurnRequest,
  dependencies: TurnFacadeDependencies,
): Promise<BtccTurnOutcome> {
  const observationStartedAtMs = Date.now();
  const prepared = await dependencies.preparation.prepare(request);
  const admittedTurn = await dependencies.turns.findTurn(request.turnId);
  const progressDestination = admittedTurn?.progressDestination ??
    destinationForRequest(request);
  const progress = projectTurnProgressToEvents(async (event) => {
    prepared.recordEvent(event);
    dependencies.progressEvents.append({
      sessionId: request.sessionId,
      turnId: request.turnId,
      destination: progressDestination,
      event,
    });
  });
  const runtimeOutcome = await dependencies.runtime.runTurn(
    prepared.command,
    progress,
    async (runtimeFresh) => {
      if (!runtimeFresh || !prepared.isFresh) return;
      const admitted = await dependencies.turns.findTurn(request.turnId).catch(() => null);
      if (admitted?.semanticState === "cancelled") return;
      prepared.recordEvent({ kind: "turn.started" });
      dependencies.progressEvents.append({
        sessionId: request.sessionId,
        turnId: request.turnId,
        destination: progressDestination,
        event: { kind: "turn.started" },
      });
    },
    observationStartedAtMs,
  );
  const outcome: BtccTurnOutcome = {
    ...runtimeOutcome,
    admission: prepared.isFresh ? "fresh" : "replay",
  };
  if (outcome.kind === "delivered" || outcome.kind === "already_delivered") {
    await prepared.complete(outcome);
  } else if (outcome.kind === "cancelled" || outcome.kind === "already_cancelled") {
    await prepared.cancel(outcome);
  }
  return outcome;
}

async function stopPreparedTurn(
  request: BtccStopRequest,
  dependencies: TurnFacadeDependencies,
): Promise<BtccTurnOutcome> {
  const outcome = await dependencies.runtime.stopTurn({
    kind: "stop",
    turnId: request.turnId,
  });
  if (outcome.kind !== "cancelled" && outcome.kind !== "already_cancelled") {
    return outcome;
  }
  const turn = await dependencies.turns.findTurn(request.turnId).catch(() => null);
  if (!turn || turn.semanticState !== "cancelled") {
    return outcome.kind === "cancelled"
      ? { kind: "fenced_pending_persistence", turnId: request.turnId }
      : outcome;
  }
  const destination = turn.progressDestination ??
    dependencies.progressEvents.forTurn(turn.turnId)[0]?.destination;
  if (!destination) {
    return { kind: "fenced_pending_persistence", turnId: request.turnId };
  }
  dependencies.progressEvents.append({
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    destination,
    event: { kind: "turn.cancelled" },
  });
  return outcome;
}

function destinationForRequest(request: BtccTurnRequest): BtccProgressDestination {
  return request.progressDestination ?? {
    transport: request.transport,
    accountId: request.accountId,
    peer: { ...request.peer },
    replyToMessageId: request.message.id,
  };
}
