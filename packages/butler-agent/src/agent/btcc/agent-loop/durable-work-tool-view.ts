import type { DurableWorkView } from "../work/index.ts";
import {
  availableWorkReviewSubjects,
  executableWorkActionKeys,
  unresolvedWorkActionKeys,
} from "../work/index.ts";

/** Model-facing Work status projection; internal IDs remain model-only. */
export function durableWorkToolView(work: DurableWorkView): Record<string, unknown> {
  const unresolved = unresolvedWorkActionKeys(work.actionProgress);
  const completionBlockers = [
    ...(unresolved.length > 0 ? ["unresolved_actions"] : []),
    ...((work.effectBlockers?.length ?? 0) > 0
      ? ["effect_reconciliation_required"]
      : []),
  ];
  return {
    work_id: work.workId,
    status: work.status,
    current_stage: work.currentStage ?? null,
    execution_mode: work.currentPlan?.executionMode ?? null,
    allowed_next_stages: work.allowedNextStages,
    available_review_subjects: availableWorkReviewSubjects(work),
    executable_action_keys: executableWorkActionKeys(work),
    actions: work.currentPlan?.actions.map((action) => {
      const progress = work.actionProgress.find((item) =>
        item.actionKey === action.actionKey);
      return {
        action_key: action.actionKey,
        status: progress?.status ?? "pending",
      };
    }) ?? [],
    unresolved_action_keys: unresolved,
    completion_blockers: completionBlockers,
    latest_plan_review: work.latestPlanReview?.verdict ?? null,
    latest_result_review: work.latestResultReview?.verdict ?? null,
    latest_completion_validation: work.latestCompletionValidation?.verdict ?? null,
    ...(work.latestDisposition
      ? {
          latest_disposition: {
            disposition: work.latestDisposition.disposition,
            summary: work.latestDisposition.summary,
            remaining_actions: work.latestDisposition.remainingActions,
            next_condition: work.latestDisposition.nextCondition ?? null,
          },
        }
      : {}),
  };
}
