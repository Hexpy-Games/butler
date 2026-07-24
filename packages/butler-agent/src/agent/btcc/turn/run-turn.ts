import type {
  BtccRuntimeDependencies,
} from "../contracts.ts";
import type { TurnExecutionSupervisor } from "../recovery/index.ts";
import { advanceTurn } from "./advance-turn.ts";
import { activateCommittedSuccessor } from "./activate-committed-successor.ts";
import type { ContinuingTurnCommand } from "./load-or-admit-turn.ts";
import { loadOrAdmitTurn } from "./load-or-admit-turn.ts";
import { publishTurnProgress } from "./turn-progress.ts";
import type { TurnRecord } from "./contracts.ts";

export type OpenedTurn = {
  route: "immediate" | "managed";
  turn: TurnRecord;
};

export async function openTurn(
  command: ContinuingTurnCommand,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<OpenedTurn> {
  let turn = await loadOrAdmitTurn(command, dependencies);
  const permit = supervisor.enter({
    turnId: turn.turnId,
    executionFence: turn.executionFence,
    semanticState: turn.semanticState,
  });
  try {
    turn = await activateCommittedSuccessor({
      turnId: turn.turnId,
      expectedState: turn.semanticState,
      dependencies,
      permit,
    });
  } finally {
    permit.close();
  }
  await publishTurnProgress(dependencies.progress, turn);

  while (isOpening(turn)) {
    turn = await advanceTurn(turn, dependencies, supervisor);
  }
  return {
    route: isManaged(turn) ? "managed" : "immediate",
    turn,
  };
}

export async function runImmediateTurn(turn: TurnRecord): Promise<TurnRecord> {
  if (isTerminal(turn) || turn.semanticState === "delivery_committed") return turn;
  throw new Error(`Immediate Turn stopped before delivery: ${turn.semanticState}`);
}

export async function runManagedTurn(
  initial: TurnRecord,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<TurnRecord> {
  let turn = initial;
  while (!isTerminal(turn) && turn.semanticState !== "delivery_committed") {
    turn = await advanceTurn(turn, dependencies, supervisor);
  }
  return turn;
}

export async function deliverTurn(
  initial: TurnRecord,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<TurnRecord> {
  let turn = initial;
  while (!isTerminal(turn)) {
    if (turn.semanticState !== "delivery_committed") {
      throw new Error(`Turn reached Delivery from ${turn.semanticState}`);
    }
    turn = await advanceTurn(turn, dependencies, supervisor);
  }
  return turn;
}

function isOpening(turn: TurnRecord): boolean {
  return turn.semanticState === "admitted" ||
    turn.semanticState === "conception_opening" ||
    turn.semanticState === "assisted_answer";
}

function isManaged(turn: TurnRecord): boolean {
  if (turn.route === "managed") return true;
  return !isTerminal(turn) && turn.semanticState !== "delivery_committed";
}

function isTerminal(turn: TurnRecord): boolean {
  return turn.semanticState === "delivered" || turn.semanticState === "cancelled";
}
