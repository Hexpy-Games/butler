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

class DefaultBtccTurnRuntime implements BtccTurnRuntime {
  private readonly supervisor = createTurnExecutionSupervisor();
  private readonly activeTurns = new Map<string, Promise<BtccTurnOutcome>>();

  constructor(private readonly dependencies: BtccRuntimeDependencies) {}

  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    if (command.kind === "stop") {
      return stopTurn(command, this.dependencies.turns, this.supervisor);
    }
    const active = this.activeTurns.get(command.turnId);
    if (active) return active;

    const running = runTurn(command, this.dependencies, this.supervisor)
      .finally(() => this.activeTurns.delete(command.turnId));
    this.activeTurns.set(command.turnId, running);
    return running;
  }
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
