import type { PhaseInvocation } from "../core/index.ts";
import { isManagedDeferral, withManagedDeferralState } from "../deferral/index.ts";
import {
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { reviewTask } from "./review-task.ts";

type ReviewEvent = Extract<TurnEvent, {
  kind: "TaskReviewPassed" | "TaskReviewFailed" | "ManagedDeferralAccepted";
}>;

export async function review(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<ReviewEvent> {
  if (command.turn.semanticState !== "task_review") {
    throw new Error(`Review cannot advance ${command.turn.semanticState}`);
  }
  const program = requireManagedProgram(command.turn);
  const criteria = program.currentTask.task.criterionRefs.map((ref) => {
    const criterion = program.criteria.find((candidate) => candidate.ref.id === ref.id);
    if (!criterion) throw new Error("Review cannot resolve a current Task criterion");
    return criterion;
  });
  const verificationQuestions = program.currentTask.task.verificationQuestionRefs.map((ref) => {
    const question = program.verificationQuestions.find((candidate) => candidate.ref.id === ref.id);
    if (!question) throw new Error("Review cannot resolve a current verification question");
    return question;
  });
  const result = program.currentTask.currentResult;
  if (!result) throw new Error("Review requires the current ResultCandidate");
  const invocation = withManagedDeferralState(command.phase, command.turn, {
    resultCandidate: result,
    criteria,
    verificationQuestions,
    ...(result.result.kind === "workspace_artifact"
      ? { reviewSourceRef: result.result.workspaceRevisionRef }
      : {}),
  });
  const product = await reviewTask({
    ...invocation,
    operationAuthority: result.result.kind === "workspace_artifact"
      ? {
          observationScopeRefs: command.phase.operationAuthority.observationScopeRefs,
          mutation: {
            kind: "validation_overlay_only",
            reviewSourceRef: result.result.workspaceRevisionRef,
          },
        }
      : invocation.operationAuthority,
  });
  if (isManagedDeferral(product)) return { kind: "ManagedDeferralAccepted", product };
  return product.review.verdict === "passed"
    ? { kind: "TaskReviewPassed", product }
    : { kind: "TaskReviewFailed", product };
}
