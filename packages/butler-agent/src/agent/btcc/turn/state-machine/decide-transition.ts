import { createHash } from "node:crypto";
import { stableJson } from "../../core/index.ts";
import type { WorkLedgerMutation } from "../../work-ledger/index.ts";
import type {
  AcceptedTurnTransition,
  TurnEvent,
  TurnRecord,
} from "../contracts.ts";
import { requireManagedProgram } from "../managed-turn-state.ts";

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
    return {
      kind: "accept_goal_contract",
      successor: "planning",
      product: event.product,
      ledgerCommit: ledgerCommit(turn, {
        kind: "bind_program",
        sessionId: turn.sessionId,
        product: event.product,
      }),
    };
  }
  if (turn.semanticState === "planning" && event.kind === "PlanCandidateSubmitted") {
    return { kind: "submit_plan_candidate", successor: "planning_review", product: event.product };
  }
  if (turn.semanticState === "planning_review" && event.kind === "PlanningRevisionRequested") {
    return { kind: "request_plan_revision", successor: "planning", product: event.product };
  }
  if (turn.semanticState === "planning_review" && event.kind === "PlanningReviewAccepted") {
    return {
      kind: "accept_plan",
      successor: "work_frontier",
      product: event.product,
      ledgerCommit: ledgerCommit(turn, {
        kind: "install_reviewed_plan",
        product: event.product,
      }),
    };
  }
  if (turn.semanticState === "work_frontier" && event.kind === "WorkTaskSelected") {
    return {
      kind: "select_work_task",
      successor: "task_execution",
      attempt: event.attempt,
      ledgerCommit: ledgerCommit(turn, {
        kind: "select_attempt",
        cursor: ledgerCursor(turn),
        attempt: event.attempt,
      }),
    };
  }
  if (turn.semanticState === "work_frontier" && event.kind === "WorkFrontierClosed") {
    return {
      kind: "close_work_frontier",
      successor: "consolidation",
      ledgerCommit: ledgerCommit(turn, {
        kind: "close_implementation_frontier",
        cursor: ledgerCursor(turn),
      }),
    };
  }
  if (turn.semanticState === "task_execution" && event.kind === "ResultCandidateSubmitted") {
    return {
      kind: "submit_result",
      successor: "task_review",
      product: event.product,
      ledgerCommit: ledgerCommit(turn, {
        kind: "attach_result",
        cursor: ledgerCursor(turn),
        product: event.product,
      }),
    };
  }
  if (turn.semanticState === "task_review" && event.kind === "TaskReviewPassed") {
    return {
      kind: "pass_task_review",
      successor: "work_frontier",
      product: event.product,
      ledgerCommit: ledgerCommit(turn, {
        kind: "attach_review",
        cursor: ledgerCursor(turn),
        product: event.product,
      }),
    };
  }
  if (turn.semanticState === "task_review" && event.kind === "TaskReviewFailed") {
    return {
      kind: "fail_task_review",
      successor: "feedback_conception",
      product: event.product,
      ledgerCommit: ledgerCommit(turn, {
        kind: "attach_review",
        cursor: ledgerCursor(turn),
        product: event.product,
      }),
    };
  }
  if (turn.semanticState === "feedback_conception" && event.kind === "FeedbackIntentAccepted") {
    return { kind: "accept_feedback_intent", successor: "feedback_planning", product: event.product };
  }
  if (turn.semanticState === "feedback_planning" && event.kind === "FeedbackPlanCandidateSubmitted") {
    return { kind: "submit_feedback_plan", successor: "feedback_planning_review", product: event.product };
  }
  if (
    turn.semanticState === "feedback_planning_review" &&
    event.kind === "FeedbackPlanningRevisionRequested"
  ) {
    return {
      kind: "request_feedback_plan_revision",
      successor: "feedback_planning",
      product: event.product,
    };
  }
  if (turn.semanticState === "feedback_planning_review" && event.kind === "FeedbackPlanningReviewAccepted") {
    return {
      kind: "accept_feedback_plan",
      successor: "work_frontier",
      product: event.product,
      ledgerCommit: ledgerCommit(turn, {
        kind: "accept_implementation_repair",
        cursor: ledgerCursor(turn),
        product: event.product,
      }),
    };
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

function ledgerCursor(turn: TurnRecord) {
  const program = requireManagedProgram(turn);
  return {
    ledgerId: program.ledgerId,
    programId: program.programId,
    expectedManifestRevision: program.manifestRevision,
  };
}

function ledgerCommit<M extends WorkLedgerMutation>(turn: TurnRecord, mutation: M) {
  const expectedTurnRevision = turn.revision + 1;
  return {
    mutationId: digest(
      `btcc-ledger-mutation.v1\0${turn.turnId}\0${expectedTurnRevision}\0${stableJson(mutation)}`,
    ),
    turnId: turn.turnId,
    expectedTurnRevision,
    mutation,
  } as const;
}
