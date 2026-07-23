import type { PhaseInvocation } from "../core/index.ts";
import {
  isManagedDeferral,
  isPromotionDeferral,
  withManagedDeferralState,
} from "../deferral/index.ts";
import {
  requireCurrentAttempt,
  requireManagedProgram,
  requireManagedState,
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
  const accepted = requireManagedState(command.turn).goalAcceptance;
  if (!accepted) throw new Error("Execution is missing accepted Goal authority");
  const attempt = requireCurrentAttempt(program);
  const target = attempt.executionTarget.target;
  const invocation = withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    acceptedPlan: program.plan,
    currentWork: program.currentWork.work,
    currentTask: program.currentTask.task,
    currentCriteria: criteriaForCurrentTask(program),
    currentVerificationQuestions: questionsForCurrentTask(program),
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    workRef: program.currentWork.work.ref,
    taskRef: program.currentTask.task.ref,
    taskRevisionSha256: program.currentTask.task.ref.sha256,
    attemptRef: attempt.ref,
    executionTargetRef: attempt.executionTargetRef,
    executionTarget: attempt.executionTarget,
    targetScopeRefs: executionScopeRefs(program, target),
  });
  const product = await performTask({
    ...invocation,
    operationAuthority: executionAuthority(command.phase, invocation, target),
  });
  if (isPromotionDeferral(product)) return { kind: "PromotionDeferralAccepted", product };
  return isManagedDeferral(product)
    ? { kind: "ManagedDeferralAccepted", product }
    : { kind: "ResultCandidateSubmitted", product };
}

function criteriaForCurrentTask(program: ReturnType<typeof requireManagedProgram>) {
  const ids = new Set(program.currentTask.task.criterionRefs.map((ref) => ref.id));
  return program.criteria.filter((criterion) => ids.has(criterion.ref.id));
}

function questionsForCurrentTask(program: ReturnType<typeof requireManagedProgram>) {
  const ids = new Set(program.currentTask.task.verificationQuestionRefs.map((ref) => ref.id));
  return program.verificationQuestions.filter((question) => ids.has(question.ref.id));
}

function executionScopeRefs(
  program: ReturnType<typeof requireManagedProgram>,
  target: ReturnType<typeof requireCurrentAttempt>["executionTarget"]["target"],
): string[] {
  if (target.kind === "non_artifact") return target.targetScopeRefs;
  if (target.kind === "repository_promotion") return [];
  const policy = program.currentTask.task.artifactPolicy;
  if (policy.kind !== "workspace_artifact") {
    throw new Error("Provisioned workspace requires a workspace artifact Task");
  }
  return [policy.workspaceScopeRef];
}

function executionAuthority(
  phase: PhaseInvocation,
  invocation: ReturnType<typeof withManagedDeferralState>,
  target: ReturnType<typeof requireCurrentAttempt>["executionTarget"]["target"],
) {
  const observationScopeRefs = phase.operationAuthority.observationScopeRefs;
  if (target.kind === "provisioned_workspace") {
    return {
      observationScopeRefs,
      mutation: {
        kind: "workspace_only" as const,
        workspaceRef: target.workspaceRef,
        operationRoot: target.operationRoot,
        mutationScope: target.mutationScope,
      },
    };
  }
  if (target.kind === "repository_promotion") {
    return {
      observationScopeRefs,
      mutation: {
        kind: "repository_promotion_only" as const,
        authorizationRef: target.authorizationRef,
        candidateRef: target.candidateRef,
        resolutionRef: target.resolutionRef,
        baselineRef: target.baselineRef,
        finalSnapshotRef: target.finalSnapshotRef,
      },
    };
  }
  return invocation.operationAuthority;
}
