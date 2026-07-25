import type { PhaseInvocation } from "../core/index.ts";
import { isManagedDeferral, withManagedDeferralState } from "../deferral/index.ts";
import {
  requireManagedProgram,
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { reviewTask } from "./review-task.ts";
import { projectDirectSuccessorHandoffs } from "./project-successor-handoffs.ts";
import {
  projectReviewValidationSource,
  taskReviewAuthority,
} from "./source-authority.ts";
import type { TaskReviewProduct } from "./contracts.ts";

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
  const accepted = requireManagedState(command.turn).goalAcceptance;
  if (!accepted) throw new Error("Review is missing accepted Goal authority");
  const result = program.currentTask.currentResult;
  if (!result) throw new Error("Review requires the current ResultCandidate");
  if (
    program.currentTask.status !== "result_submitted" ||
    result.result.taskRef.id !== program.currentTask.task.ref.id ||
    result.result.taskRevisionSha256 !== program.currentTask.task.ref.sha256
  ) {
    throw new Error("Review result is not bound to the exact current Task revision");
  }
  const priorFindings = priorCorrectionFindings(program);
  const correctionContext = priorFindings.length > 0
    ? projectCorrectionContext(command.turn, program, priorFindings)
    : undefined;
  const invocation = withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    acceptedPlanRef: program.plan.ref,
    currentWork: program.currentWork.work,
    currentTask: program.currentTask.task,
    directSuccessorHandoffs: projectDirectSuccessorHandoffs(program),
    resultCandidate: result,
    reviewAuthorityRef: program.authorityRef,
    criteria: resolveCriteria(program),
    verificationQuestions: resolveVerificationQuestions(program),
    priorCorrectionFindings: priorFindings,
    ...(correctionContext ? { correctionContext } : {}),
    ...projectReviewValidationSource(result.result),
  });
  const product = await reviewTask({
    ...invocation,
    operationAuthority: taskReviewAuthority({
      baseline: command.phase.operationAuthority,
      result: result.result,
    }),
  });
  if (isManagedDeferral(product)) return { kind: "ManagedDeferralAccepted", product };
  return product.review.verdict === "passed"
    ? { kind: "TaskReviewPassed", product }
    : { kind: "TaskReviewFailed", product };
}

function priorCorrectionFindings(
  program: ReturnType<typeof requireManagedProgram>,
) {
  if (
    program.correctionPlanRef &&
    program.currentTask.status === "result_submitted" &&
    program.currentTask.currentReview?.review.verdict === "not_passed"
  ) {
    return requiredFindings(program.currentTask.currentReview);
  }
  const attempt = program.currentTask.attempts.at(-1);
  if (!attempt?.attemptRecord.correctionPlanRef || !attempt.attemptRecord.previousAttemptRef) {
    return [];
  }
  const previous = program.currentTask.attempts.find((candidate) =>
    candidate.attemptRecord.ref.id === attempt.attemptRecord.previousAttemptRef?.id);
  if (!previous?.review || previous.review.review.verdict !== "not_passed") return [];
  return requiredFindings(previous.review);
}

function projectCorrectionContext(
  turn: TurnRecord,
  program: ReturnType<typeof requireManagedProgram>,
  frozenFindings: ReturnType<typeof priorCorrectionFindings>,
) {
  const managed = requireManagedState(turn);
  const intent = managed.feedbackIntent?.feedbackIntent;
  const acceptance = managed.feedbackAcceptance;
  const correctionPlan = acceptance?.candidate.correctionPlan;
  if (!intent || !acceptance || !correctionPlan || acceptance.review.verdict !== "accepted") {
    throw new Error("Task re-review is missing its accepted correction context");
  }
  if (
    !program.correctionPlanRef ||
    !sameRef(program.correctionPlanRef, correctionPlan.ref) ||
    !sameRef(intent.ref, acceptance.candidate.feedbackIntentRef)
  ) {
    throw new Error("Task re-review correction context changed");
  }
  const expected = new Set(frozenFindings.map((finding) => finding.ref.id));
  const decisions = intent.findingDecisions;
  if (
    decisions.length !== frozenFindings.length ||
    new Set(decisions.map((decision) => decision.findingRef.id)).size !== decisions.length ||
    decisions.some((decision) => !expected.has(decision.findingRef.id))
  ) {
    throw new Error("Task re-review finding decisions changed");
  }
  if (
    correctionPlan.findingDecisions.length !== decisions.length ||
    correctionPlan.findingDecisions.some((decision, index) => {
      const accepted = decisions[index]!;
      return !sameRef(decision.findingRef, accepted.findingRef) ||
        decision.decision !== accepted.decision ||
        decision.rationale !== accepted.rationale;
    })
  ) {
    throw new Error("Task re-review CorrectionPlan changed its finding decisions");
  }
  return {
    frozenFindings,
    findingDecisions: decisions,
    correctionPlan,
    correctionPlanningReview: acceptance.review,
  };
}

function requiredFindings(product: TaskReviewProduct) {
  return product.review.findings
    .filter((finding) => finding.recommendedDisposition === "required_now");
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function resolveCriteria(program: ReturnType<typeof requireManagedProgram>) {
  return program.currentTask.task.criterionRefs.map((ref) => {
    const criterion = program.criteria.find((candidate) => candidate.ref.id === ref.id);
    if (!criterion) throw new Error("Review cannot resolve a current Task criterion");
    return criterion;
  });
}

function resolveVerificationQuestions(program: ReturnType<typeof requireManagedProgram>) {
  return program.currentTask.task.verificationQuestionRefs.map((ref) => {
    const question = program.verificationQuestions.find((candidate) => candidate.ref.id === ref.id);
    if (!question) throw new Error("Review cannot resolve a current verification question");
    return question;
  });
}
