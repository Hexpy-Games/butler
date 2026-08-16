import type {
  DurableWorkActionProgress,
  DurableWorkActionUpdate,
  DurableWorkPlanAction,
  DurableWorkView,
  WorkCorrectionScope,
  WorkStage,
} from "./contracts.ts";

export type WorkReviewSubject = "plan" | "result" | "completion";
type WorkReviewVerdict = "accept" | "revise" | "partial";

const NEXT_STAGES: Readonly<Record<WorkStage, readonly WorkStage[]>> = {
  conception: ["planning"],
  planning: ["review"],
  execution: ["review"],
  review: ["planning", "execution", "validation"],
  validation: ["planning", "execution", "review", "reporting"],
  reporting: ["validation"],
};

export class WorkStageTransitionError extends Error {
  readonly code = "invalid_work_stage_transition";

  constructor(
    readonly currentStage: WorkStage,
    readonly attemptedStage: WorkStage,
    readonly allowedNextStages: WorkStage[],
  ) {
    super(
      `Work cannot move from ${currentStage} to ${attemptedStage}; ` +
        `allowed next stages: ${allowedNextStages.join(", ") || "none"}`,
    );
  }
}

export class WorkTransitionGuardError extends Error {
  readonly code = "work_transition_guard_unmet";

  constructor(
    readonly currentStage: WorkStage,
    readonly requestedAction: string,
    readonly unmetGuard: string,
    readonly nextAction: string,
  ) {
    super(
      `Work cannot ${requestedAction} from ${currentStage}; ` +
        `${unmetGuard}. Next action: ${nextAction}`,
    );
  }
}

export function workReviewTargetStage(input: {
  subject: WorkReviewSubject;
  verdict: WorkReviewVerdict;
  correctionScope?: WorkCorrectionScope;
}): WorkStage {
  if (input.verdict === "accept") {
    if (input.subject === "plan") return "execution";
    if (input.subject === "result") return "validation";
    return "reporting";
  }
  if (input.subject === "plan") return "planning";
  if (input.correctionScope) return input.correctionScope;
  throw new Error(
    `Work ${input.subject} ${input.verdict} requires correctionScope`,
  );
}

export function resolveWorkReviewTransition(input: {
  currentStage: WorkStage;
  subject: WorkReviewSubject;
  verdict: WorkReviewVerdict;
  correctionScope?: WorkCorrectionScope;
}): { entryStage: "review" | "validation"; nextStage: WorkStage } {
  const entryStage = input.subject === "completion" ? "validation" : "review";
  if (!reviewEntryStages(input.subject).includes(input.currentStage)) {
    throw new WorkTransitionGuardError(
      input.currentStage,
      `${input.subject}_review_${input.verdict}`,
      reviewGuard(input.currentStage),
      reviewNextAction(input.currentStage),
    );
  }
  if (input.verdict !== "accept" && input.subject !== "plan" &&
    !input.correctionScope) {
    throw new WorkTransitionGuardError(
      input.currentStage,
      `${input.subject}_review_${input.verdict}`,
      "correction_scope_required",
      "choose_planning_or_execution_correction",
    );
  }
  assertWorkStageTransition(input.currentStage, entryStage);
  const nextStage = workReviewTargetStage(input);
  assertWorkStageTransition(entryStage, nextStage);
  return { entryStage, nextStage };
}

export function acceptedCurrentResultReview(
  work: Pick<DurableWorkView, "currentPlan" | "latestResultReview" | "resultRefs">,
): DurableWorkView["latestResultReview"] | undefined {
  const review = work.latestResultReview;
  if (!work.currentPlan || review?.verdict !== "accept") return undefined;
  const resultRefs = work.resultRefs.map(({ resultRef }) => resultRef);
  if (review.boundResultRefs.length !== resultRefs.length) return undefined;
  return review.boundResultRefs.every((resultRef, index) =>
      resultRef === resultRefs[index])
    ? review
    : undefined;
}

export function availableWorkReviewSubjects(
  work: Pick<
    DurableWorkView,
    "currentStage" | "currentPlan" | "latestResultReview" | "resultRefs"
  >,
): WorkReviewSubject[] {
  const currentStage = work.currentStage;
  if (!work.currentPlan || !currentStage) return [];
  return (["plan", "result", "completion"] as const).filter((subject) =>
    reviewEntryStages(subject).includes(currentStage) &&
    (subject !== "completion" || acceptedCurrentResultReview(work) !== undefined),
  );
}

export function assertWorkPlanReplacementStage(currentStage: WorkStage): void {
  try {
    assertWorkStageTransition(currentStage, "planning");
  } catch (error) {
    if (!(error instanceof WorkStageTransitionError)) throw error;
    throw new WorkTransitionGuardError(
      currentStage,
      "replace_work_plan",
      reviewGuard(currentStage),
      reviewNextAction(currentStage),
    );
  }
}

function reviewEntryStages(subject: WorkReviewSubject): WorkStage[] {
  if (subject === "plan") return ["planning", "execution", "review"];
  if (subject === "result") return ["execution", "review"];
  return ["review", "validation", "reporting"];
}

function reviewGuard(stage: WorkStage): string {
  if (stage === "conception") return "current_plan_missing";
  if (stage === "planning") return "plan_review_required";
  if (stage === "execution") return "result_review_required";
  if (stage === "review") return "current_review_incomplete";
  return "completion_review_required";
}

function reviewNextAction(stage: WorkStage): string {
  if (stage === "conception") return "replace_work_plan";
  if (stage === "planning") return "record_plan_review";
  if (stage === "execution" || stage === "review") return "record_result_review";
  return "record_completion_review";
}

export function allowedNextWorkStages(stage?: WorkStage): WorkStage[] {
  return stage ? [...NEXT_STAGES[stage]] : ["conception"];
}

export function assertWorkStageTransition(
  currentStage: WorkStage | undefined,
  attemptedStage: WorkStage,
): void {
  if (currentStage === attemptedStage) return;
  const allowed = allowedNextWorkStages(currentStage);
  if (allowed.includes(attemptedStage)) return;
  if (!currentStage) {
    throw new Error(`Work must start in conception, not ${attemptedStage}`);
  }
  throw new WorkStageTransitionError(currentStage, attemptedStage, allowed);
}

export function progressForReplacementPlan(
  actions: DurableWorkPlanAction[],
  prior: DurableWorkActionProgress[],
): DurableWorkActionProgress[] {
  const priorByKey = new Map(prior.map((progress) => [progress.actionKey, progress]));
  return actions.map((action) => {
    const existing = priorByKey.get(action.actionKey);
    return existing ? { ...existing } : { actionKey: action.actionKey, status: "pending" };
  });
}

export function applyWorkActionUpdates(
  work: Pick<DurableWorkView, "currentPlan" | "actionProgress">,
  updates: DurableWorkActionUpdate[],
): DurableWorkActionProgress[] {
  const plan = work.currentPlan;
  if (!plan) throw new Error("Durable Work progress requires a current Plan");
  const actionKeys = new Set(plan.actions.map((action) => action.actionKey));
  const updateKeys = new Set<string>();
  for (const update of updates) {
    if (!actionKeys.has(update.actionKey)) {
      throw new Error(`Durable Work action is not in the current Plan: ${update.actionKey}`);
    }
    if (updateKeys.has(update.actionKey)) {
      throw new Error(`Durable Work action update is duplicated: ${update.actionKey}`);
    }
    updateKeys.add(update.actionKey);
  }
  const updatesByKey = new Map(updates.map((update) => [update.actionKey, update]));
  return progressForReplacementPlan(plan.actions, work.actionProgress).map((progress) => {
    const update = updatesByKey.get(progress.actionKey);
    return update ? { ...update } : progress;
  });
}

export function unresolvedWorkActionKeys(
  progress: DurableWorkActionProgress[],
): string[] {
  return progress
    .filter((action) => action.status !== "done" && action.status !== "skipped")
    .map((action) => action.actionKey);
}
