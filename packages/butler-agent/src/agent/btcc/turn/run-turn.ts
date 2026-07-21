import {
  conceiveCorrection,
  deliberateGoal,
  openConception,
  reviewGoalContract,
} from "../conception/index.ts";
import { assureOriginalGoal } from "../consolidation/index.ts";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnOutcome,
} from "../contracts.ts";
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
import { admitTurn } from "./admission/index.ts";
import { decideTransition } from "./state-machine/index.ts";
import type {
  StateExecutionClaim,
  TurnEvent,
  TurnRecord,
} from "./contracts.ts";

type RunCommand = Exclude<BtccTurnCommand, { kind: "stop" }>;

export async function runTurn(
  command: RunCommand,
  dependencies: BtccRuntimeDependencies,
): Promise<BtccTurnOutcome> {
  let turn = await loadOrAdmitTurn(command, dependencies);
  while (turn.semanticState !== "delivered" && turn.semanticState !== "cancelled") {
    const claim = await dependencies.turns.acquireStateExecutionClaim(turn);
    const event = await runCurrentPhase(turn, claim, dependencies);
    const transition = decideTransition(turn, event);
    await dependencies.turns.commitTransition({ turn, claim, transition });
    turn = await loadRequiredTurn(turn.turnId, dependencies);
  }
  return projectTerminalOutcome(turn);
}

async function loadOrAdmitTurn(
  command: RunCommand,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnRecord> {
  if (command.kind === "wake") {
    throw new Error("BTCC fresh continuation wake admission is not implemented");
  }
  const existing = await dependencies.turns.findTurn(command.turnId);
  if (existing) {
    if (command.kind === "run") assertExactRunReplay(existing, command);
    return existing;
  }
  if (command.kind !== "run") {
    throw new Error(`BTCC Turn is not admitted: ${command.turnId}`);
  }
  return admitTurn(command, dependencies.admission, dependencies.turns);
}

function assertExactRunReplay(
  turn: TurnRecord,
  command: Extract<BtccTurnCommand, { kind: "run" }>,
): void {
  if (
    turn.sessionId !== command.sessionId ||
    turn.triggerKey !== command.triggerKey ||
    turn.originalMessageId !== command.message.messageId ||
    turn.originalMessage !== command.message.content ||
    canonicalJson(turn.modelSelection) !== canonicalJson(command.modelSelection) ||
    canonicalJson(turn.context) !== canonicalJson(command.context)
  ) {
    throw new Error(`BTCC run replay does not match admitted Turn: ${turn.turnId}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function runCurrentPhase(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnEvent> {
  switch (turn.semanticState) {
    case "admitted":
      return { kind: "TurnActivated" };
    case "conception_opening": {
      const product = await openConception({
        binding: {
          turnId: turn.turnId,
          turnRevision: turn.revision,
          semanticState: "conception_opening",
          checkpointId: claim.checkpointId,
          checkpointRevision: claim.checkpointRevision,
          claimId: claim.claimId,
          executionFence: claim.executionFence,
        },
        modelSelection: turn.modelSelection,
        context: {
          originalMessageId: turn.originalMessageId,
          originalMessage: turn.originalMessage,
          ...turn.context,
        },
        conversations: dependencies.phaseConversations,
        model: dependencies.model,
      });
      return { kind: "OpeningAnswerAccepted", product };
    }
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
    case "delivery_committed": {
      const observation = await insertCanonicalMessage({
        turn,
        messages: dependencies.messages,
      });
      return { kind: "DeliveryObserved", assistantMessageId: observation.messageId };
    }
    case "delivered":
    case "cancelled":
      throw new Error(`Terminal BTCC state cannot be dispatched: ${turn.semanticState}`);
  }
}

async function loadRequiredTurn(
  turnId: string,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnRecord> {
  const turn = await dependencies.turns.findTurn(turnId);
  if (!turn) throw new Error(`BTCC Turn disappeared after commit: ${turnId}`);
  return turn;
}

function projectTerminalOutcome(turn: TurnRecord): BtccTurnOutcome {
  if (turn.semanticState === "cancelled") {
    return { kind: "cancelled", turnId: turn.turnId };
  }
  if (!turn.canonicalAssistantMessageId || !turn.openingAnswer) {
    throw new Error("Delivered BTCC Turn is missing its canonical delivery");
  }
  return {
    kind: "delivered",
    turnId: turn.turnId,
    messageId: turn.canonicalAssistantMessageId,
    content: turn.openingAnswer.finalPayload.content,
  };
}
