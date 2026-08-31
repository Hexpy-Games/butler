import { stableJson } from "../identity/index.ts";
import type {
  DelegationRequest,
  ReviewedDelegationPlan,
  SubsessionDelegationDependencies,
} from "./contracts.ts";

/** Loads the reviewed Plan provenance shared by Steward and Worker dispatch. */
export async function loadReviewedDelegationPlan(
  input: Pick<SubsessionDelegationDependencies, "durableWork">,
  parent: { parentSessionId: string; parentTurnId: string },
): Promise<ReviewedDelegationPlan> {
  const work = await input.durableWork.boundWorkForTurn(parent.parentTurnId);
  if (!work || work.sessionId !== parent.parentSessionId ||
      (work.status !== "open" && work.status !== "blocked")) {
    throw new Error("subsession_reviewed_parent_work_required");
  }
  const plan = work.currentPlan;
  const review = work.latestPlanReview;
  if (!plan || !review || review.subject !== "plan" || review.verdict !== "accept" ||
      review.boundPlanRevisionId !== plan.planRevisionId) {
    throw new Error("subsession_accepted_parent_plan_review_required");
  }
  return {
    parent_work_ref: {
      work_id: work.workId,
      session_id: work.sessionId,
      turn_id: parent.parentTurnId,
      plan_revision_id: plan.planRevisionId,
      review_revision_id: review.reviewRevisionId,
    },
    objective: plan.objective,
    acceptance_criteria: [...plan.checks],
    task_or_plan_refs: [...(plan.governingRefs ?? [])],
    actions: plan.actions.map((action) => ({
      ...action,
      dependencyKeys: [...action.dependencyKeys],
      ...(action.effect ? { effect: { ...action.effect } } : {}),
    })),
    action_progress: work.actionProgress.map((progress) => ({ ...progress })),
    ...(work.latestCheckpoint?.planRevisionId === plan.planRevisionId ? {
      latest_checkpoint: {
        publicSummary: work.latestCheckpoint.publicSummary,
        nextStep: work.latestCheckpoint.nextStep,
      },
    } : {}),
  };
}

/** Keeps the durable parent Work identity exact without rewriting the request. */
export function assertDelegationParentWorkRef(
  request: DelegationRequest,
  reviewed: ReviewedDelegationPlan,
): void {
  if (stableJson(request.parent_work_ref) !== stableJson(reviewed.parent_work_ref)) {
    throw new Error("subsession_parent_work_ref_mismatch");
  }
  if (request.constraints_and_non_goals.length > 0) {
    throw new Error("subsession_unreviewed_constraints_forbidden");
  }
}
