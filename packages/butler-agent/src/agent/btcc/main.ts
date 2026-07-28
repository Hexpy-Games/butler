import type {
  BtccRuntimeDependencies,
  BtccRunCommand,
  BtccStopCommand,
  BtccTurnOutcome,
  BtccTurnRuntime,
} from "./contracts.ts";
import { scheduleRetrospective } from "./delivery/index.ts";
import { createTurnExecutionSupervisor } from "./recovery/index.ts";
import {
  consolidateTurn,
  deliverTurn,
  openTurn,
  projectTerminalOutcome,
  reportTurn,
  runImmediateTurn,
  runManagedConceptionPlanningExecutionReview,
  stopTurn,
  type ContinuingTurnCommand,
  type TurnExecutionSupervisor,
} from "./turn/index.ts";
import { publishTurnProgress } from "./turn/turn-progress.ts";

class DefaultBtccTurnRuntime implements BtccTurnRuntime {
  private readonly supervisor = createTurnExecutionSupervisor();
  private readonly activeTurns = new Map<string, Promise<BtccTurnOutcome>>();

  constructor(private readonly dependencies: BtccRuntimeDependencies) {}

  runTurn(command: BtccRunCommand): Promise<BtccTurnOutcome> {
    const active = this.activeTurns.get(command.turnId);
    if (active) return active;

    const running = runTurnWorkflow(command, this.dependencies, this.supervisor)
      .finally(() => this.activeTurns.delete(command.turnId));
    this.activeTurns.set(command.turnId, running);
    return running;
  }

  stopTurn(command: BtccStopCommand): Promise<BtccTurnOutcome> {
    return stopAndPublish(command, this.dependencies, this.supervisor);
  }
}

async function stopAndPublish(
  command: BtccStopCommand,
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

async function runTurnWorkflow(
  command: ContinuingTurnCommand,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<BtccTurnOutcome> {
  const opened = await openTurn(command, dependencies, supervisor);
  const prepared = opened.route === "managed"
    ? await runManagedConceptionPlanningExecutionReview(
      opened.turn,
      dependencies,
      supervisor,
    )
    : await runImmediateTurn(opened.turn);
  const consolidated = await consolidateTurn(prepared, dependencies, supervisor);
  const reported = await reportTurn(consolidated, dependencies, supervisor);
  const delivered = await deliverTurn(reported, dependencies, supervisor);

  scheduleRetrospective({ turn: delivered, scheduler: dependencies.retrospective });
  return projectTerminalOutcome(delivered);
}

export function createBtccTurnRuntime(
  dependencies: BtccRuntimeDependencies,
): BtccTurnRuntime {
  return new DefaultBtccTurnRuntime(dependencies);
}
