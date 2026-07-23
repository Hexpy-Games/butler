import { describe, expect, test } from "bun:test";
import type { LiveTurnStep, TraceObservation } from "../e2e/btcc/contracts.ts";
import { satisfiesLiveTraceContract } from "../e2e/btcc/observations/live-trace-contract.ts";

const step = {
  requiredTrace: [
    required("task_review", "TaskReviewFailed"),
    required("feedback_conception", "FeedbackIntentAccepted"),
  ],
  allowedAlternativeTraceRefs: [
    "TRACE-ALT-ADDITIONAL-IMPLEMENTATION-REPAIR-CYCLES",
  ],
} as LiveTurnStep;

describe("live trace alternatives", () => {
  test("accepts first-review success with a reviewed promotion path", () => {
    expect(
      satisfiesLiveTraceContract(
        trace(
          ...managedOpening(),
          point("planning_review", "PlanningRevisionRequested"),
          point("planning", "PlanCandidateSubmitted"),
          point("planning_review", "PlanningReviewAccepted"),
          ...passedTask(),
          point("work_frontier", "WorkFrontierClosed"),
          ...promotionFinalization(),
        ),
        step,
      ),
    ).toBe(true);
  });

  test("accepts an observed Task feedback loop only after it closes", () => {
    expect(
      satisfiesLiveTraceContract(
        trace(
          ...managedOpening(),
          point("planning_review", "PlanningReviewAccepted"),
          point("work_frontier", "WorkTaskSelected"),
          point("task_execution", "ResultCandidateSubmitted"),
          point("task_review", "TaskReviewFailed"),
          point("feedback_conception", "FeedbackIntentAccepted"),
          point("feedback_planning", "FeedbackPlanCandidateSubmitted"),
          point("feedback_planning_review", "FeedbackPlanningReviewAccepted"),
          ...passedTask(),
          point("work_frontier", "WorkFrontierClosed"),
          ...directFinalization(),
        ),
        step,
      ),
    ).toBe(true);
  });

  test("rejects an observed Task failure without the complete feedback loop", () => {
    expect(
      satisfiesLiveTraceContract(
        trace(
          ...managedOpening(),
          point("planning_review", "PlanningReviewAccepted"),
          point("work_frontier", "WorkTaskSelected"),
          point("task_execution", "ResultCandidateSubmitted"),
          point("task_review", "TaskReviewFailed"),
          ...passedTask(),
          point("work_frontier", "WorkFrontierClosed"),
          ...directFinalization(),
        ),
        step,
      ),
    ).toBe(false);
  });

  test("rejects an observed Planning revision without accepted re-planning", () => {
    expect(
      satisfiesLiveTraceContract(
        trace(
          ...managedOpening(),
          point("planning_review", "PlanningRevisionRequested"),
          ...passedTask(),
          point("work_frontier", "WorkFrontierClosed"),
          ...directFinalization(),
        ),
        step,
      ),
    ).toBe(false);
  });
});

function managedOpening() {
  return [
    point("admitted", "TurnActivated"),
    point("conception_opening", "OpeningContinuationAccepted"),
    point("conception_deliberation", "GoalContractCandidateSubmitted"),
    point("contract_review", "GoalContractReviewAccepted"),
  ];
}

function passedTask() {
  return [
    point("work_frontier", "WorkTaskSelected"),
    point("task_execution", "ResultCandidateSubmitted"),
    point("task_review", "TaskReviewPassed"),
  ];
}

function directFinalization() {
  return [
    point("consolidation", "FinalDossierAccepted"),
    point("reporting", "PreparedReportAccepted"),
    point("delivery_committed", "DeliveryObserved"),
  ];
}

function promotionFinalization() {
  return [
    point("consolidation", "PromotionAuthorized"),
    ...passedTask(),
    point("work_frontier", "PromotionFrontierClosed"),
    ...directFinalization(),
  ];
}

function point(state: string, acceptedEvent: string) {
  return { state, acceptedEvent };
}

function required(state: string, acceptedEvent: string) {
  return { ordinal: 1, state, acceptedEvent };
}

function trace(
  ...points: Array<{ state: string; acceptedEvent: string }>
): TraceObservation[] {
  return points.map((item, index) => ({
    ...item,
    ordinal: index + 1,
    turnRevision: index,
    source: "persisted_transition_reconstruction",
  }));
}
