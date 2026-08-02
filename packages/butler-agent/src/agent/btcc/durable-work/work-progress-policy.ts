import type {
  DurableWorkActionProgress,
  DurableWorkActionUpdate,
  DurableWorkPlanAction,
  DurableWorkView,
  WorkStage,
} from "./contracts.ts";

const NEXT_STAGES: Readonly<Record<WorkStage, readonly WorkStage[]>> = {
  conception: ["planning"],
  planning: ["review"],
  execution: ["review"],
  review: ["planning", "execution", "reporting"],
  reporting: ["review"],
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

export function allowedNextWorkStages(stage?: WorkStage): WorkStage[] {
  return stage ? [...NEXT_STAGES[stage]] : ["planning"];
}

export function assertWorkStageTransition(
  currentStage: WorkStage | undefined,
  attemptedStage: WorkStage,
): void {
  if (currentStage === attemptedStage) return;
  const allowed = allowedNextWorkStages(currentStage);
  if (allowed.includes(attemptedStage)) return;
  if (!currentStage) {
    throw new Error(`Work must start in planning, not ${attemptedStage}`);
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
