import type {
  Btcc,
  BtccHost,
  BtccStopRequest,
  BtccTurnOutcome,
  BtccTurnRequest,
  BtccWakeProjectionHost,
} from "./contracts.ts";
import {
  createBtccProgressProjectionHost,
} from "./projection/index.ts";
import {
  createTurnFacade,
  type TurnFacade,
  type TurnFacadeDependencies,
} from "./turn/index.ts";

export type BtccDependencies = TurnFacadeDependencies & {
  wake?: BtccWakeProjectionHost;
  close?: () => Promise<void> | void;
};

export type BtccAssembly = {
  btcc: Btcc;
  host: BtccHost;
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
): BtccAssembly {
  const activeTurns = new Map<string, Promise<BtccTurnOutcome>>();
  const sessionTails = new Map<string, Promise<void>>();
  const progress = createBtccProgressProjectionHost(dependencies.progressEvents);
  const turn: TurnFacade = createTurnFacade({
    ...dependencies,
    publishCommitted: (event) => progress.publishCommitted(event),
  });
  let closePromise: Promise<void> | null = null;

  const runTurn = (request: BtccTurnRequest): Promise<BtccTurnOutcome> => {
    const active = activeTurns.get(request.turnId);
    if (active) return active;
    if (closePromise) throw new Error("BTCC is closing");

    const previous = sessionTails.get(request.sessionId);
    const running = (async () => {
      if (previous) await previous;
      return await turn.run(request);
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

  const stopTurn = async (request: BtccStopRequest): Promise<BtccTurnOutcome> => {
    if (closePromise) throw new Error("BTCC is closing");
    return await turn.stop(request);
  };

  const host: BtccHost = {
    progress,
    ...(dependencies.wake ? { wake: dependencies.wake } : {}),
    close() {
      closePromise ??= (async () => {
        await Promise.allSettled([...activeTurns.values()]);
        await dependencies.close?.();
      })();
      return closePromise;
    },
  };

  return {
    btcc: { runTurn, stopTurn },
    host,
  };
}
