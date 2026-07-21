import { conception } from "../conception/index.ts";
import type { ArtifactWorkspaceRuntime } from "../artifact/index.ts";
import type { PhaseInvocation } from "../core/index.ts";
import { execution } from "../execution/index.ts";
import { planning } from "../planning/index.ts";
import { review } from "../review/index.ts";
import {
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { selectNextTaskOrClose } from "./select-next-task-or-close.ts";
import { prepareTaskAttempt } from "./prepare-task-attempt.ts";

type WorkCycleEvent = Extract<TurnEvent, {
  kind:
    | "WorkTaskSelected"
    | "WorkFrontierClosed"
    | "ResultCandidateSubmitted"
    | "TaskReviewPassed"
    | "TaskReviewFailed"
    | "FeedbackIntentAccepted"
    | "FeedbackPlanCandidateSubmitted"
    | "FeedbackPlanningReviewAccepted"
    | "FeedbackPlanningRevisionRequested"
    | "PromotedWorkCompleted";
}>;

export function runWorkCycle(command: {
  turn: TurnRecord;
  phase?: PhaseInvocation;
  artifacts: ArtifactWorkspaceRuntime;
}): Promise<WorkCycleEvent> | WorkCycleEvent {
  return command.turn.semanticState === "work_frontier"
    ? advanceWorkFrontier(command.turn, command.artifacts)
    : continueTaskFeedbackLoop({ turn: command.turn, phase: requirePhase(command) });
}

async function advanceWorkFrontier(
  turn: TurnRecord,
  artifacts: ArtifactWorkspaceRuntime,
): Promise<WorkCycleEvent> {
  const decision = selectNextTaskOrClose({
    turnId: turn.turnId,
    turnRevision: turn.revision,
    program: requireManagedProgram(turn),
  });
  if (decision.kind === "close_frontier") {
    return { kind: "WorkFrontierClosed", promotionAssemblies: decision.promotionAssemblies };
  }
  if (decision.kind === "complete_promotion") {
    return { kind: "PromotedWorkCompleted", product: decision.product };
  }
  const attempt = await prepareTaskAttempt({
    turnId: turn.turnId,
    turnRevision: turn.revision,
    program: requireManagedProgram(turn),
    task: decision.task,
    artifacts,
  });
  return { kind: "WorkTaskSelected", attempt };
}

async function continueTaskFeedbackLoop(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<WorkCycleEvent> {
  switch (command.turn.semanticState) {
    case "task_execution":
      return execution(command);
    case "task_review":
      return review(command);
    case "feedback_conception":
      return conception({ ...command, cycle: "review_feedback" });
    case "feedback_planning":
    case "feedback_planning_review":
      return planning({ ...command, cycle: "review_feedback" });
    default:
      throw new Error(`Work Cycle cannot advance ${command.turn.semanticState}`);
  }
}

function requirePhase(command: {
  turn: TurnRecord;
  phase?: PhaseInvocation;
}): PhaseInvocation {
  if (!command.phase) {
    throw new Error(`Work Cycle phase is missing at ${command.turn.semanticState}`);
  }
  return command.phase;
}
