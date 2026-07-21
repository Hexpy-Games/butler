import { conception } from "./conception/index.ts";
import { consolidation } from "./consolidation/index.ts";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnOutcome,
  BtccTurnRuntime,
} from "./contracts.ts";
import { insertCanonicalMessage } from "./delivery/index.ts";
import { planning } from "./planning/index.ts";
import { reporting } from "./reporting/index.ts";
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
import { runWorkCycle } from "./work/index.ts";

class DefaultBtccTurnRuntime implements BtccTurnRuntime {
  constructor(private readonly dependencies: BtccRuntimeDependencies) {}

  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    return command.kind === "stop"
      ? stopTurn(command)
      : runBtccTurn(command, this.dependencies);
  }
}

async function runBtccTurn(
  command: ContinuingTurnCommand,
  dependencies: BtccRuntimeDependencies,
): Promise<BtccTurnOutcome> {
  let turn = await loadOrAdmitTurn(command, dependencies);
  while (!isTerminal(turn)) {
    const claim = await dependencies.turns.acquireStateExecutionClaim(turn);
    const event = await advanceBtccCycle(turn, claim, dependencies);
    const transition = decideTransition(turn, event);
    await dependencies.turns.commitTransition({ turn, claim, transition });
    turn = await reloadTurn(turn.turnId, dependencies);
  }
  return projectTerminalOutcome(turn);
}

async function advanceBtccCycle(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnEvent> {
  switch (turn.semanticState) {
    case "admitted":
      return { kind: "TurnActivated" };

    case "conception_opening":
    case "conception_deliberation":
    case "contract_review":
      return conception({
        cycle: "initial",
        turn,
        phase: createPhaseInvocation(turn, claim, dependencies),
      });

    case "planning":
    case "planning_review":
      return planning({
        cycle: "initial",
        turn,
        phase: createPhaseInvocation(turn, claim, dependencies),
      });

    case "work_frontier":
      return runWorkCycle({ turn, artifacts: dependencies.artifacts });
    case "task_execution":
    case "task_review":
    case "feedback_conception":
    case "feedback_planning":
    case "feedback_planning_review":
      return runWorkCycle({
        turn,
        phase: createPhaseInvocation(turn, claim, dependencies),
        artifacts: dependencies.artifacts,
      });

    case "consolidation":
      return consolidation({ turn, phase: createPhaseInvocation(turn, claim, dependencies) });

    case "reporting":
      return reporting({ turn, phase: createPhaseInvocation(turn, claim, dependencies) });

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

async function reloadTurn(
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
