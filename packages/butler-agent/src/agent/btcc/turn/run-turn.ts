import {
  conceiveCorrection,
  deliberateGoal,
  openConception,
  reviewGoalContract,
} from "../conception/index.ts";
import { assureOriginalGoal } from "../consolidation/index.ts";
import { insertCanonicalMessage } from "../delivery/index.ts";
import { performTask } from "../execution/index.ts";
import {
  proposeCorrectionOrRevision,
  proposePlan,
  reviewCorrection,
  reviewPlan,
} from "../planning/index.ts";
import { prepareReport } from "../reporting/index.ts";
import { reviewTask } from "../review/index.ts";
import { selectNextTaskOrClose } from "../work/index.ts";
import type { BtccTurnCommand, BtccTurnOutcome } from "../contracts.ts";

export async function runTurn(
  _command: Exclude<BtccTurnCommand, { kind: "stop" }>,
): Promise<BtccTurnOutcome> {
  return runCurrentPhase("admitted");
}

type TurnState =
  | "admitted"
  | "conception_opening"
  | "conception_deliberation"
  | "contract_review"
  | "planning"
  | "planning_review"
  | "work_frontier"
  | "task_execution"
  | "task_review"
  | "feedback_conception"
  | "feedback_planning"
  | "feedback_planning_review"
  | "consolidation"
  | "reporting"
  | "delivery_committed"
  | "delivered"
  | "cancelled";

function runCurrentPhase(state: TurnState): Promise<never> {
  switch (state) {
    case "admitted":
      return activateTurn();
    case "conception_opening":
      return openConception();
    case "conception_deliberation":
      return deliberateGoal();
    case "contract_review":
      return reviewGoalContract();
    case "planning":
      return proposePlan();
    case "planning_review":
      return reviewPlan();
    case "work_frontier":
      return selectNextTaskOrClose();
    case "task_execution":
      return performTask();
    case "task_review":
      return reviewTask();
    case "feedback_conception":
      return conceiveCorrection();
    case "feedback_planning":
      return proposeCorrectionOrRevision();
    case "feedback_planning_review":
      return reviewCorrection();
    case "consolidation":
      return assureOriginalGoal();
    case "reporting":
      return prepareReport();
    case "delivery_committed":
      return insertCanonicalMessage();
    case "delivered":
    case "cancelled":
      return terminalDispatchError(state);
  }
}

function activateTurn(): Promise<never> {
  throw new Error("BTCC Turn activation is not implemented");
}

function terminalDispatchError(state: TurnState): never {
  throw new Error(`Terminal BTCC state cannot be dispatched: ${state}`);
}
