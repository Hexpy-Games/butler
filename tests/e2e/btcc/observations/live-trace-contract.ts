import type { LiveTurnStep, TraceObservation } from "../contracts.ts";

type TracePoint = Pick<TraceObservation, "state" | "acceptedEvent">;

const IMPLEMENTATION_REPAIR_ALTERNATIVE =
  "TRACE-ALT-ADDITIONAL-IMPLEMENTATION-REPAIR-CYCLES";

export function satisfiesLiveTraceContract(
  actual: TraceObservation[],
  step: LiveTurnStep,
): boolean {
  if (containsTrace(actual, step.requiredTrace)) return true;
  if (
    !step.allowedAlternativeTraceRefs.includes(
      IMPLEMENTATION_REPAIR_ALTERNATIVE,
    )
  ) {
    return false;
  }
  return satisfiesImplementationRepairAlternative(actual);
}

function satisfiesImplementationRepairAlternative(
  actual: TraceObservation[],
): boolean {
  if (!containsTrace(actual, REQUIRED_MANAGED_MILESTONES)) return false;
  if (!containsOneFinalizationPath(actual)) return false;
  return observedCorrectionBranchesAreClosed(actual);
}

const REQUIRED_MANAGED_MILESTONES: TracePoint[] = [
  point("admitted", "TurnActivated"),
  point("conception_opening", "OpeningContinuationAccepted"),
  point("conception_deliberation", "GoalContractCandidateSubmitted"),
  point("contract_review", "GoalContractReviewAccepted"),
  point("planning_review", "PlanningReviewAccepted"),
  point("work_frontier", "WorkTaskSelected"),
  point("task_execution", "ResultCandidateSubmitted"),
  point("task_review", "TaskReviewPassed"),
  point("work_frontier", "WorkFrontierClosed"),
];

const DIRECT_FINALIZATION: TracePoint[] = [
  point("consolidation", "FinalDossierAccepted"),
  point("reporting", "PreparedReportAccepted"),
  point("delivery_committed", "DeliveryObserved"),
];

const PROMOTION_FINALIZATION: TracePoint[] = [
  point("consolidation", "PromotionAuthorized"),
  point("work_frontier", "WorkTaskSelected"),
  point("task_execution", "ResultCandidateSubmitted"),
  point("task_review", "TaskReviewPassed"),
  point("reporting", "PreparedReportAccepted"),
  point("delivery_committed", "DeliveryObserved"),
];

const PLANNING_CORRECTION: TracePoint[] = [
  point("planning_review", "PlanningRevisionRequested"),
  point("planning", "PlanCandidateSubmitted"),
  point("planning_review", "PlanningReviewAccepted"),
];

const TASK_CORRECTION: TracePoint[] = [
  point("task_review", "TaskReviewFailed"),
  point("feedback_conception", "FeedbackIntentAccepted"),
  point("feedback_planning", "FeedbackPlanCandidateSubmitted"),
  point("feedback_planning_review", "FeedbackPlanningReviewAccepted"),
  point("work_frontier", "WorkTaskSelected"),
  point("task_execution", "ResultCandidateSubmitted"),
  point("task_review", "TaskReviewPassed"),
];

function containsOneFinalizationPath(actual: TraceObservation[]): boolean {
  return (
    containsTrace(actual, DIRECT_FINALIZATION) ||
    containsTrace(actual, PROMOTION_FINALIZATION)
  );
}

function observedCorrectionBranchesAreClosed(
  actual: TraceObservation[],
): boolean {
  return (
    occurrencesCloseWith(actual, PLANNING_CORRECTION) &&
    occurrencesCloseWith(actual, TASK_CORRECTION)
  );
}

function occurrencesCloseWith(
  actual: TraceObservation[],
  branch: TracePoint[],
): boolean {
  const trigger = branch[0];
  for (let index = 0; index < actual.length; index += 1) {
    if (!samePoint(actual[index], trigger)) continue;
    if (!containsTrace(actual.slice(index), branch)) return false;
  }
  return true;
}

function containsTrace(actual: TracePoint[], required: TracePoint[]): boolean {
  let cursor = 0;
  for (const row of actual) {
    const expected = required[cursor];
    if (expected && samePoint(row, expected)) cursor += 1;
  }
  return cursor === required.length;
}

function samePoint(
  actual: TracePoint | undefined,
  expected: TracePoint,
): boolean {
  return (
    actual?.state === expected.state &&
    actual.acceptedEvent === expected.acceptedEvent
  );
}

function point(state: string, acceptedEvent: string): TracePoint {
  return { state, acceptedEvent };
}
