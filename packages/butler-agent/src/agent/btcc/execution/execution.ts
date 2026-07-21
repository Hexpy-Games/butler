import type { PhaseInvocation } from "../core/index.ts";
import {
  isManagedDeferral,
  isPromotionDeferral,
  withManagedDeferralState,
} from "../deferral/index.ts";
import {
  requireCurrentAttempt,
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { performTask } from "./perform-task.ts";

export async function execution(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<Extract<TurnEvent, {
  kind: "ResultCandidateSubmitted" | "ManagedDeferralAccepted" | "PromotionDeferralAccepted";
}>> {
  if (command.turn.semanticState !== "task_execution") {
    throw new Error(`Execution cannot advance ${command.turn.semanticState}`);
  }
  const program = requireManagedProgram(command.turn);
  const attempt = requireCurrentAttempt(program);
  const target = attempt.executionTarget.target;
  const invocation = withManagedDeferralState(command.phase, command.turn, {
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    workRef: program.currentWork.work.ref,
    taskRef: program.currentTask.task.ref,
    taskRevisionSha256: program.currentTask.task.ref.sha256,
    attemptRef: attempt.ref,
    executionTargetRef: attempt.executionTargetRef,
    executionTarget: attempt.executionTarget,
    targetScopeRefs: target.kind === "non_artifact"
      ? target.targetScopeRefs
      : target.kind === "provisioned_workspace"
        ? [program.currentTask.task.artifactPolicy.kind === "workspace_artifact"
          ? program.currentTask.task.artifactPolicy.targetScopeRef
          : ""]
        : [],
  });
  const product = await performTask({
    ...invocation,
    operationAuthority: target.kind === "provisioned_workspace"
      ? {
          observationScopeRefs: command.phase.operationAuthority.observationScopeRefs,
          mutation: { kind: "workspace_only", workspaceRef: target.workspaceRef },
        }
      : target.kind === "repository_promotion"
        ? {
            observationScopeRefs: command.phase.operationAuthority.observationScopeRefs,
            mutation: {
              kind: "repository_promotion_only",
              authorizationRef: target.authorizationRef,
            },
          }
        : invocation.operationAuthority,
  });
  if (isPromotionDeferral(product)) return { kind: "PromotionDeferralAccepted", product };
  return isManagedDeferral(product)
    ? { kind: "ManagedDeferralAccepted", product }
    : { kind: "ResultCandidateSubmitted", product };
}
