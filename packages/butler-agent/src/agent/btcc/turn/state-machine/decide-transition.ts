import { createHash } from "node:crypto";
import type {
  AcceptedTurnTransition,
  TurnEvent,
  TurnRecord,
} from "../contracts.ts";

export function decideTransition(
  turn: TurnRecord,
  event: TurnEvent,
): AcceptedTurnTransition {
  if (turn.semanticState === "admitted" && event.kind === "TurnActivated") {
    return {
      kind: "activate_opening",
      successor: "conception_opening",
      successorCheckpointKind: "phase",
    };
  }
  if (
    turn.semanticState === "conception_opening" &&
    event.kind === "OpeningAnswerAccepted"
  ) {
    const committedRevision = turn.revision + 1;
    const payload = event.product.finalPayload;
    const outboxId = digest(
      `btcc-canonical-delivery.v1\0${turn.turnId}\0${committedRevision}\0${payload.ref.sha256}`,
    );
    return {
      kind: "accept_opening_answer",
      successor: "delivery_committed",
      successorCheckpointKind: "runtime",
      product: event.product,
      deliveryOutbox: {
        outboxId,
        finalPayloadRef: payload.ref,
        expectedMessageId: digest(`btcc-assistant-message.v1\0${outboxId}`),
        content: payload.content,
        status: "pending",
      },
    };
  }
  if (turn.semanticState === "conception_opening" && event.kind === "OpeningContinuationAccepted") {
    return { kind: "accept_opening_continuation", successor: "conception_deliberation", product: event.product };
  }
  if (turn.semanticState === "conception_deliberation" && event.kind === "GoalContractCandidateSubmitted") {
    return { kind: "submit_goal_candidate", successor: "contract_review", product: event.product };
  }
  if (turn.semanticState === "contract_review" && event.kind === "GoalContractReviewAccepted") {
    return { kind: "accept_goal_contract", successor: "planning", product: event.product };
  }
  if (turn.semanticState === "planning" && event.kind === "PlanCandidateSubmitted") {
    return { kind: "submit_plan_candidate", successor: "planning_review", product: event.product };
  }
  if (turn.semanticState === "planning_review" && event.kind === "PlanningReviewAccepted") {
    return { kind: "accept_plan", successor: "work_frontier", product: event.product };
  }
  if (turn.semanticState === "work_frontier" && event.kind === "WorkTaskSelected") {
    return { kind: "select_work_task", successor: "task_execution", attempt: event.attempt };
  }
  if (turn.semanticState === "work_frontier" && event.kind === "WorkFrontierClosed") {
    return { kind: "close_work_frontier", successor: "consolidation" };
  }
  if (turn.semanticState === "task_execution" && event.kind === "ResultCandidateSubmitted") {
    return { kind: "submit_result", successor: "task_review", product: event.product };
  }
  if (turn.semanticState === "task_review" && event.kind === "TaskReviewPassed") {
    return { kind: "pass_task_review", successor: "work_frontier", product: event.product };
  }
  if (turn.semanticState === "task_review" && event.kind === "TaskReviewFailed") {
    return { kind: "fail_task_review", successor: "feedback_conception", product: event.product };
  }
  if (turn.semanticState === "feedback_conception" && event.kind === "FeedbackIntentAccepted") {
    return { kind: "accept_feedback_intent", successor: "feedback_planning", product: event.product };
  }
  if (turn.semanticState === "feedback_planning" && event.kind === "FeedbackPlanCandidateSubmitted") {
    return { kind: "submit_feedback_plan", successor: "feedback_planning_review", product: event.product };
  }
  if (turn.semanticState === "feedback_planning_review" && event.kind === "FeedbackPlanningReviewAccepted") {
    return { kind: "accept_feedback_plan", successor: "work_frontier", product: event.product };
  }
  if (turn.semanticState === "consolidation" && event.kind === "FinalDossierAccepted") {
    return { kind: "accept_final_dossier", successor: "reporting", product: event.product };
  }
  if (turn.semanticState === "reporting" && event.kind === "PreparedReportAccepted") {
    const committedRevision = turn.revision + 1;
    const payload = event.product.finalPayload;
    const outboxId = digest(
      `btcc-canonical-delivery.v1\0${turn.turnId}\0${committedRevision}\0${payload.ref.sha256}`,
    );
    return {
      kind: "accept_prepared_report",
      successor: "delivery_committed",
      product: event.product,
      deliveryOutbox: {
        outboxId,
        finalPayloadRef: payload.ref,
        expectedMessageId: digest(`btcc-assistant-message.v1\0${outboxId}`),
        content: payload.content,
        status: "pending",
      },
    };
  }
  if (
    turn.semanticState === "delivery_committed" &&
    event.kind === "DeliveryObserved" &&
    event.assistantMessageId === turn.deliveryOutbox?.expectedMessageId
  ) {
    return {
      kind: "observe_delivery",
      successor: "delivered",
      assistantMessageId: event.assistantMessageId,
    };
  }
  throw new Error(`BTCC state/event mismatch: ${turn.semanticState}/${event.kind}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
