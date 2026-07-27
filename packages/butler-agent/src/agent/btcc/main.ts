import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnOutcome,
  BtccTurnRuntime,
} from "./contracts.ts";
import { scheduleRetrospective } from "./delivery/index.ts";
import { createTurnExecutionSupervisor } from "./recovery/index.ts";
import {
  deliverTurn,
  openTurn,
  projectTerminalOutcome,
  runImmediateTurn,
  runManagedTurn,
  stopTurn,
  type ContinuingTurnCommand,
  type TurnExecutionSupervisor,
} from "./turn/index.ts";
import { publishTurnProgress } from "./turn/turn-progress.ts";

class DefaultBtccTurnRuntime implements BtccTurnRuntime {
  private readonly supervisor = createTurnExecutionSupervisor();
  private readonly activeTurns = new Map<string, Promise<BtccTurnOutcome>>();

  constructor(private readonly dependencies: BtccRuntimeDependencies) {}

  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    if (command.kind === "stop") {
      return stopAndPublish(command, this.dependencies, this.supervisor);
    }
    const active = this.activeTurns.get(command.turnId);
    if (active) return active;

    const running = runTurn(command, this.dependencies, this.supervisor)
      .finally(() => this.activeTurns.delete(command.turnId));
    this.activeTurns.set(command.turnId, running);
    return running;
  }
}

async function stopAndPublish(
  command: Extract<BtccTurnCommand, { kind: "stop" }>,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<BtccTurnOutcome> {
  const outcome = await stopTurn(command, dependencies.turns, supervisor);
  if (outcome.kind !== "cancelled") return outcome;
  try {
    const turn = await dependencies.turns.findTurn(command.turnId);
    if (turn?.semanticState === "cancelled") {
      await publishTurnProgress(dependencies.progress, turn);
    }
  } catch {
    // Durable Stop remains authoritative when optional projection is unavailable.
  }
  return outcome;
}

async function runTurn(
  command: ContinuingTurnCommand,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<BtccTurnOutcome> {
  const opened = await openTurn(command, dependencies, supervisor);
  const completed = opened.route === "managed"
    ? await runManagedTurn(opened.turn, dependencies, supervisor)
    : await runImmediateTurn(opened.turn);
  const delivered = await deliverTurn(completed, dependencies, supervisor);

  scheduleRetrospective({ turn: delivered, scheduler: dependencies.retrospective });
  return projectTerminalOutcome(delivered);
}

export function createBtccTurnRuntime(
  dependencies: BtccRuntimeDependencies,
): BtccTurnRuntime {
  return new DefaultBtccTurnRuntime(dependencies);
}
