import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";

const PLANNED_REVIEW_FORBIDDEN_START_TOOLS = new Set<string>([
  "create_planned_task",
  "run_planned_task",
  "dispatch_worker",
  "resume_worker",
  "create_work_orchestration",
  "run_ready_work_streams",
]);

export const PLANNED_REVIEW_SCOPED_TOOLS = new Set<string>([
  "review_planned_task",
  "repair_planned_task",
  "request_principal_decision",
  "write_planned_public_report",
]);

export interface PlannedReviewToolPolicyBlock {
  error: string;
  reviewTaskId: string;
  result: {
    ok: false;
    error: string;
    planned_review_task_id: string;
    blocked_tool: string;
    allowed_next_tools: string[];
  };
}

export function applyPlannedReviewToolPolicy(input: {
  plannedReview: PlannedReviewTurnContext | null;
  toolName: string;
  args: Record<string, unknown>;
}): PlannedReviewToolPolicyBlock | null {
  if (!input.plannedReview) return null;
  const reviewTaskId = input.plannedReview.taskId;
  if (PLANNED_REVIEW_SCOPED_TOOLS.has(input.toolName)) {
    applyPlannedReviewOwnership(input.args, input.plannedReview);
  }

  const requestedTaskId =
    typeof input.args.task_id === "string" ? input.args.task_id.trim() : "";
  const blocksSiblingStart = PLANNED_REVIEW_FORBIDDEN_START_TOOLS.has(input.toolName);
  const targetsDifferentPlannedTask =
    PLANNED_REVIEW_SCOPED_TOOLS.has(input.toolName) &&
    Boolean(requestedTaskId) &&
    requestedTaskId !== reviewTaskId;
  if (!blocksSiblingStart && !targetsDifferentPlannedTask) return null;

  const error = blocksSiblingStart
    ? [
        `planned-review turns cannot start sibling work with ${input.toolName};`,
        "use review_planned_task, repair_planned_task,",
        `request_principal_decision, or write_planned_public_report for ${reviewTaskId}`,
      ].join(" ")
    : `planned-review turn for ${reviewTaskId} cannot operate on ${requestedTaskId}`;
  return {
    error,
    reviewTaskId,
    result: {
      ok: false,
      error,
      planned_review_task_id: reviewTaskId,
      blocked_tool: input.toolName,
      allowed_next_tools: [
        "review_planned_task",
        "repair_planned_task",
        "request_principal_decision",
        "write_planned_public_report",
      ],
    },
  };
}

function applyPlannedReviewOwnership(
  args: Record<string, unknown>,
  plannedReview: PlannedReviewTurnContext,
): void {
  if (typeof args.task_id !== "string" || !args.task_id.trim()) {
    args.task_id = plannedReview.taskId;
  }
  if (plannedReview.attempt && typeof args.attempt !== "number") {
    args.attempt = plannedReview.attempt;
  }
  if (
    plannedReview.workerTaskId &&
    (typeof args.worker_task_id !== "string" || !args.worker_task_id.trim())
  ) {
    args.worker_task_id = plannedReview.workerTaskId;
  }
  if (
    plannedReview.reviewEventId &&
    (typeof args.review_event_id !== "string" || !args.review_event_id.trim())
  ) {
    args.review_event_id = plannedReview.reviewEventId;
  }
}
