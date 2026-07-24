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
import { scopeTaskExecution } from "./scope-task-execution.ts";

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
  const correctionContext = projectExecutionCorrectionContext(
    command.turn,
    program,
    attempt.attemptRecord.correctionPlanRef,
  );
  const taskExecution = scopeTaskExecution({
    admittedAuthority: command.phase.operationAuthority,
    target,
    artifactTargetScopeRef: artifactTargetScopeRef(program),
  });
  const invocation = withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    acceptedPlanRef: program.plan.ref,
    currentWork: program.currentWork.work,
    currentTask: program.currentTask.task,
    currentCriteria: criteriaForCurrentTask(program),
    currentVerificationQuestions: questionsForCurrentTask(program),
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    workRef: program.currentWork.work.ref,
    taskRef: program.currentTask.task.ref,
    taskRevisionSha256: program.currentTask.task.ref.sha256,
    attemptRef: attempt.attemptRecord.ref,
    executionTargetRef: attempt.executionTargetRef,
    executionTarget: attempt.executionTarget,
    targetScopeRefs: taskExecution.targetScopeRefs,
    ...(correctionContext ? { correctionContext } : {}),
  });
  const product = await performTask({
    ...invocation,
    operationAuthority: taskExecution.operationAuthority,
  });
  if (isPromotionDeferral(product)) return { kind: "PromotionDeferralAccepted", product };
  return isManagedDeferral(product)
    ? { kind: "ManagedDeferralAccepted", product }
    : { kind: "ResultCandidateSubmitted", product };
}

function projectExecutionCorrectionContext(
  turn: TurnRecord,
  program: ReturnType<typeof requireManagedProgram>,
  correctionPlanRef: { id: string; sha256: string } | undefined,
) {
  if (!correctionPlanRef) return undefined;
  const managed = requireManagedState(turn);
  const intent = managed.feedbackIntent?.feedbackIntent;
  const acceptance = managed.feedbackAcceptance;
  const plan = acceptance?.candidate.correctionPlan;
  if (
    !intent ||
    !acceptance ||
    !plan ||
    !sameRef(plan.ref, correctionPlanRef) ||
    !sameRef(acceptance.candidate.feedbackIntentRef, intent.ref)
  ) {
    throw new Error("Task Execution correction context changed");
  }
  if (
    plan.findingDecisions.length !== intent.findingDecisions.length ||
    plan.findingDecisions.some((decision, index) => {
      const accepted = intent.findingDecisions[index]!;
      return !sameRef(decision.findingRef, accepted.findingRef) ||
        decision.decision !== accepted.decision ||
        decision.rationale !== accepted.rationale;
    })
  ) {
    throw new Error("Task Execution CorrectionPlan changed its finding decisions");
  }
  if (
    plan.findingDecisions.length > 0 &&
    !plan.findingDecisions.some((decision) => decision.decision === "apply_now")
  ) {
    throw new Error("Task Execution cannot run a disposition-only correction");
  }
  return {
    correctionPlan: plan,
    findingDecisions: intent.findingDecisions,
    correctionPlanningReview: acceptance.review,
    currentTaskRef: program.currentTask.task.ref,
  };
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function criteriaForCurrentTask(program: ReturnType<typeof requireManagedProgram>) {
  const ids = new Set(program.currentTask.task.criterionRefs.map((ref) => ref.id));
  return program.criteria.filter((criterion) => ids.has(criterion.ref.id));
}

function questionsForCurrentTask(program: ReturnType<typeof requireManagedProgram>) {
  const ids = new Set(program.currentTask.task.verificationQuestionRefs.map((ref) => ref.id));
  return program.verificationQuestions.filter((question) => ids.has(question.ref.id));
}

function artifactTargetScopeRef(
  program: ReturnType<typeof requireManagedProgram>,
): string | undefined {
  const policy = program.currentTask.task.artifactPolicy;
  return policy.kind === "workspace_artifact" ? policy.workspaceScopeRef : undefined;
}
