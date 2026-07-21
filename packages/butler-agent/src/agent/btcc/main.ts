import { conception } from "./conception/index.ts";
import { consolidation } from "./consolidation/index.ts";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnOutcome,
  BtccTurnRuntime,
} from "./contracts.ts";
import { insertCanonicalMessage, scheduleLearningSource } from "./delivery/index.ts";
import { planning } from "./planning/index.ts";
import { reporting } from "./reporting/index.ts";
import {
  createTurnExecutionSupervisor,
  type ExecutionPermit,
  type TurnExecutionSupervisor,
} from "./recovery/index.ts";
import {
  createPhaseInvocation,
  decideTransition,
  loadOrAdmitTurn,
  projectTerminalOutcome,
  stopTurn,
  type ContinuingTurnCommand,
  type StateExecutionClaim,
  type TurnEvent,
  type TurnRecord,
} from "./turn/index.ts";
import { work } from "./work/index.ts";

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
    const running = runBtccTurn(command, this.dependencies, this.supervisor)
      .finally(() => this.activeTurns.delete(command.turnId));
    this.activeTurns.set(command.turnId, running);
    return running;
  }
}

async function runBtccTurn(
  command: ContinuingTurnCommand,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<BtccTurnOutcome> {
  let turn = await loadOrAdmitTurn(command, dependencies);
  while (!isTerminal(turn)) {
    const permit = supervisor.enter({
      turnId: turn.turnId,
      executionFence: turn.executionFence,
      semanticState: turn.semanticState,
    });
    try {
      const claim = await dependencies.turns.acquireStateExecutionClaim(turn);
      const event = await advanceBtccAlgorithm(turn, claim, dependencies, permit);
      permit.assertActive();
      const transition = decideTransition(turn, event);
      await dependencies.turns.commitTransition({ turn, claim, transition });
      permit.assertActive();
    } catch (error) {
      const observed = await dependencies.turns.findTurn(turn.turnId);
      if (observed && isTerminal(observed)) {
        turn = observed;
        continue;
      }
      throw error;
    } finally {
      permit.close();
    }
    turn = await activateCommittedSuccessor(turn.turnId, dependencies);
  }
  scheduleLearningSource({ turn, scheduler: dependencies.learning });
  return projectTerminalOutcome(turn);
}

async function advanceBtccAlgorithm(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
  executionPermit: ExecutionPermit,
): Promise<TurnEvent> {
  const phase = () => createPhaseInvocation(turn, claim, dependencies, executionPermit);
  switch (turn.semanticState) {
    case "admitted":
      return { kind: "TurnActivated" };

    case "conception_opening":
    case "conception_deliberation":
    case "contract_review":
      return conception({
        cycle: "initial",
        turn,
        phase: phase(),
      });

    case "planning":
    case "planning_review":
      return planning({
        cycle: "initial",
        turn,
        phase: phase(),
      });

    case "work_frontier":
      return work({ turn, artifacts: dependencies.artifacts });
    case "task_execution":
    case "task_review":
    case "feedback_conception":
    case "feedback_planning":
    case "feedback_planning_review":
      return work({
        turn,
        phase: phase(),
        artifacts: dependencies.artifacts,
      });

    case "consolidation":
      return consolidation({ turn, phase: phase() });

    case "reporting":
      return reporting({ turn, phase: phase() });

    case "delivery_committed": {
      const message = await insertCanonicalMessage({ turn, messages: dependencies.messages });
      return { kind: "DeliveryObserved", assistantMessageId: message.messageId };
    }

    case "delivered":
    case "cancelled":
      throw new Error(`Terminal BTCC state cannot be advanced: ${turn.semanticState}`);
  }
}

function isTerminal(turn: TurnRecord): boolean {
  return turn.semanticState === "delivered" || turn.semanticState === "cancelled";
}

async function activateCommittedSuccessor(
  turnId: string,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnRecord> {
  const turn = await dependencies.turns.findTurn(turnId);
  if (!turn) throw new Error(`BTCC Turn disappeared after commit: ${turnId}`);
  return turn;
}

export function createBtccTurnRuntime(
  dependencies: BtccRuntimeDependencies,
): BtccTurnRuntime {
  return new DefaultBtccTurnRuntime(dependencies);
}
