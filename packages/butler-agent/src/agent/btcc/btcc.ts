import type {
  Btcc,
  BtccHost,
  BtccProgressDestination,
  BtccProgressEventRepository,
  BtccStopRequest,
  BtccTurnOutcome,
  BtccTurnPreparation,
  BtccTurnRequest,
  BtccTurnRuntime,
  BtccWakeProjectionHost,
} from "./contracts.ts";
import { createBtccProgressProjectionHost } from "./projection/btcc-progress-outbox-consumer.ts";
import { projectTurnProgressToEvents } from "./turn/turn-progress.ts";
import type { TurnStateRepository } from "./turn/contracts.ts";

export type BtccDependencies = {
  runtime: BtccTurnRuntime;
  preparation: BtccTurnPreparation;
  progressEvents: BtccProgressEventRepository;
  turns: Pick<TurnStateRepository, "findTurn">;
  wake?: BtccWakeProjectionHost;
  close?: () => Promise<void> | void;
};

/**
 * Public BTCC lifecycle facade.
 *
 * Turn execution and Stop are the only public semantic calls.  Durable
 * projection delivery and host shutdown live behind the separate host handle
 * so transport adapters cannot turn progress into an execution observer API.
 */
export function createBtcc(
  dependencies: BtccDependencies,
): Btcc & { host: BtccHost } {
  const activeTurns = new Map<string, Promise<BtccTurnOutcome>>();
  const sessionTails = new Map<string, Promise<void>>();
  let closePromise: Promise<void> | null = null;

  const runTurn = (request: BtccTurnRequest): Promise<BtccTurnOutcome> => {
    const active = activeTurns.get(request.turnId);
    if (active) return active;
    if (closePromise) throw new Error("BTCC is closing");

    const previous = sessionTails.get(request.sessionId);
    const running = (async () => {
      if (previous) await previous;
      return await runPreparedTurn(request);
    })();
    activeTurns.set(request.turnId, running);
    const tail = running.then(() => undefined, () => undefined);
    sessionTails.set(request.sessionId, tail);
    void tail.then(() => {
      if (sessionTails.get(request.sessionId) === tail) {
        sessionTails.delete(request.sessionId);
      }
    });
    void running.then(() => {
      if (activeTurns.get(request.turnId) === running) {
        activeTurns.delete(request.turnId);
      }
    }, () => {
      if (activeTurns.get(request.turnId) === running) {
        activeTurns.delete(request.turnId);
      }
    });
    return running;
  };

  const runPreparedTurn = async (request: BtccTurnRequest): Promise<BtccTurnOutcome> => {
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
  };

  const stopTurn = async (request: BtccStopRequest): Promise<BtccTurnOutcome> => {
    if (closePromise) throw new Error("BTCC is closing");
    const outcome = await dependencies.runtime.stopTurn({
      kind: "stop",
      turnId: request.turnId,
    });
    if (outcome.kind !== "cancelled" && outcome.kind !== "already_cancelled") {
      return outcome;
    }

    const turn = await dependencies.turns.findTurn(request.turnId).catch(() => null);
    if (!turn || turn.semanticState !== "cancelled") {
      // Stop-before-admission is retained by the durable Stop request.  The
      // queued Turn will enter this same path and commit the canonical event.
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
  };

  const host: BtccHost = {
    progress: createBtccProgressProjectionHost(dependencies.progressEvents),
    ...(dependencies.wake ? { wake: dependencies.wake } : {}),
    close() {
      closePromise ??= (async () => {
        await Promise.allSettled([...activeTurns.values()]);
        await dependencies.close?.();
      })();
      return closePromise;
    },
  };

  return { runTurn, stopTurn, host };
}

function destinationForRequest(request: BtccTurnRequest): BtccProgressDestination {
  return request.progressDestination ?? {
    transport: request.transport,
    accountId: request.accountId,
    peer: { ...request.peer },
    replyToMessageId: request.message.id,
  };
}
