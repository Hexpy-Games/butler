import type { ArtifactWorkspaceRuntime } from "../artifact/index.ts";
import { conception } from "../conception/index.ts";
import type { PhaseInvocation } from "../core/index.ts";
import { execution } from "../execution/index.ts";
import { planning } from "../planning/index.ts";
import { review } from "../review/index.ts";
import {
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { prepareTaskAttempt } from "./prepare-task-attempt.ts";
import { selectNextTaskOrClose } from "./select-next-task-or-close.ts";

type WorkEvent = Extract<TurnEvent, {
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
    | "PromotedWorkCompleted"
    | "PromotedWorkDeferred"
    | "ManagedDeferralAccepted"
    | "PromotionDeferralAccepted";
}>;

export function work(command: {
  turn: TurnRecord;
  phase?: PhaseInvocation;
  artifacts: ArtifactWorkspaceRuntime;
}): Promise<WorkEvent> | WorkEvent {
  return command.turn.semanticState === "work_frontier"
    ? selectTaskOrCompleteWork(command.turn, command.artifacts)
    : continueTaskCycle({ turn: command.turn, phase: requirePhase(command) });
}

async function selectTaskOrCompleteWork(
  turn: TurnRecord,
  artifacts: ArtifactWorkspaceRuntime,
): Promise<WorkEvent> {
  const program = requireManagedProgram(turn);
  const decision = selectNextTaskOrClose({
    turnId: turn.turnId,
    turnRevision: turn.revision,
    program,
  });
  if (decision.kind === "close_frontier") {
    return { kind: "WorkFrontierClosed", promotionAssemblies: decision.promotionAssemblies };
  }
  if (decision.kind === "complete_promotion") {
    return { kind: "PromotedWorkCompleted", product: decision.product };
  }
  if (decision.kind === "defer_promotion") {
    return { kind: "PromotedWorkDeferred", product: decision.product };
  }
  const attempt = await prepareTaskAttempt({
    turnId: turn.turnId,
    turnRevision: turn.revision,
    program,
    task: decision.task,
    artifacts,
  });
  return { kind: "WorkTaskSelected", attempt };
}

async function continueTaskCycle(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<WorkEvent> {
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
      throw new Error(`Work cannot advance ${command.turn.semanticState}`);
  }
}

function requirePhase(command: {
  turn: TurnRecord;
  phase?: PhaseInvocation;
}): PhaseInvocation {
  if (!command.phase) {
    throw new Error(`Work phase is missing at ${command.turn.semanticState}`);
  }
  return command.phase;
}
