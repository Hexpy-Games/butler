import type {
  SharedProgressRow,
  SharedTurnEvent,
} from "./progress-projection-contract.ts";
import { SHARED_WORK_BLOCK_MARKER_KIND } from "./progress-projection-contract.ts";
import {
  blockSequence,
  completedBlockState,
  detailRows,
  eventRowBase,
  optionalNonNegativeInteger,
  optionalText,
  progressKind,
  recordPayload,
  safeText,
  standaloneDecisionFields,
  workBlockPhase,
  workDecisionFields,
} from "./progress-row-projection-fields.ts";

const TURN_ACKNOWLEDGED_EVENT_KIND = "turn.acknowledged";
const TURN_DECISION_EVENT_KIND = "assistant.decision";
const FIRST_VISIBLE_PROGRESS_EVENT_KIND = "turn.first_progress";

export function progressRowFromSharedTurnEvent(
  event: SharedTurnEvent,
): (SharedProgressRow & { kind: string }) | null {
  if (event.visibility === "internal") return null;
  const payload = recordPayload(event.payload);
  const base = eventRowBase(event);
  if (event.kind === "assistant.public_note") {
    const note = safeText(payload.note, "Working");
    const workBlockId = optionalText(payload.workBlockId);
    return {
      ...base,
      kind: "message",
      safe_label: note,
      state: "running",
      work_block_id: workBlockId,
      work_block_label:
        optionalText(payload.decisionTitle ?? payload.workBlockLabel) ??
        (workBlockId ? note : undefined),
      bridge_phase:
        optionalText(payload.bridgePhase) ??
        (payload.operational === true ? "operational_recovery" : undefined),
      ...workDecisionFields(payload),
    };
  }
  if (event.kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) {
    return {
      ...base,
      kind: "turn",
      safe_label: safeText(payload.note ?? payload.safeLabel, "Working"),
      state: "thinking",
    };
  }
  if (event.kind === TURN_ACKNOWLEDGED_EVENT_KIND) {
    return {
      ...base,
      kind: "turn",
      safe_label: safeText(
        payload.safeLabel,
        "Request received. Preparing the work.",
      ),
      state: "accepted",
      receipt_kind: TURN_ACKNOWLEDGED_EVENT_KIND,
    };
  }
  if (event.kind === TURN_DECISION_EVENT_KIND) {
    const decision = standaloneDecisionFields(payload);
    if (!decision.public_decision_summary || !decision.public_decision_source) {
      return null;
    }
    return {
      ...base,
      kind: "decision",
      safe_label: decision.public_decision_summary,
      state: "running",
      ...decision,
    };
  }
  const blockPhase = workBlockPhase(event.kind);
  if (blockPhase) {
    const decision = workDecisionFields(payload);
    const title =
      decision.work_decision_title ??
      optionalText(payload.label ?? payload.safeLabel) ??
      "Working";
    return {
      ...base,
      kind: SHARED_WORK_BLOCK_MARKER_KIND,
      safe_label: title,
      state: blockPhase === "completed" ? completedBlockState(payload) : "running",
      work_block_id: optionalText(payload.workBlockId) ?? event.id,
      work_block_label: title,
      work_block_phase: blockPhase,
      work_block_sequence: blockSequence(payload),
      ...decision,
    };
  }
  if (event.kind === "guard.started" || event.kind === "guard.completed") {
    return {
      ...base,
      kind: "system",
      safe_label:
        event.kind === "guard.started" ? "Checking response" : "Response checked",
      state: event.kind === "guard.started" ? "running" : "delivered",
    };
  }
  if (event.kind.startsWith("tool.")) {
    if (event.kind === "tool.progress" && payload.activityKind === "todo") {
      const todoId = optionalText(payload.todoId ?? payload.inputLabel);
      return {
        ...base,
        id: todoId ?? base.id,
        kind: "todo",
        safe_label: safeText(payload.safeLabel, "Working step"),
        state: optionalText(payload.state) ?? "running",
        safe_input_label: todoId,
        safe_detail_rows: detailRows(payload.detailRows),
        safe_order: optionalNonNegativeInteger(payload.safeOrder),
      };
    }
    const toolName = safeText(payload.toolName, "Tool");
    const inputLabel = optionalText(payload.inputLabel);
    const decision = workDecisionFields(payload);
    return {
      ...base,
      kind: progressKind(payload.activityKind),
      safe_label: safeText(
        payload.safeLabel,
        inputLabel ? `${toolName}: ${inputLabel}` : toolName,
      ),
      state:
        event.kind === "tool.failed"
          ? "failed"
          : event.kind === "tool.completed"
            ? "delivered"
            : "running",
      safe_tool_name: toolName,
      safe_input_label: inputLabel,
      tool_call_id: optionalText(payload.toolCallId),
      bridge_phase: optionalText(payload.bridgePhase),
      work_block_id: optionalText(payload.workBlockId),
      work_block_label:
        decision.work_decision_title ?? optionalText(payload.workBlockLabel),
      work_block_sequence: blockSequence(payload),
      ...decision,
      safe_detail_rows: detailRows(payload.detailRows),
    };
  }
  if (event.kind === "runtime.fault") {
    const publicSummary = safeText(
      payload.publicSummary,
      "Butler runtime was interrupted before the turn could continue.",
    );
    return {
      ...base,
      kind: "runtime_fault",
      safe_label: publicSummary,
      state: "runtime_fault",
      runtime_fault_id: safeText(payload.faultId, event.id),
      runtime_fault_kind: safeText(payload.kind, "runtime_fault"),
      runtime_fault_retryable: payload.retryable === true,
      runtime_fault_public_summary: publicSummary,
      runtime_fault_safe_error_code: optionalText(payload.safeErrorCode),
      runtime_fault_safe_cause: optionalText(payload.safeCause),
    };
  }
  if (
    event.kind === "turn.accepted" ||
    event.kind === "turn.started" ||
    event.kind === "turn.iteration.started"
  ) {
    return {
      ...base,
      kind: "turn",
      safe_label: event.kind === "turn.accepted" ? "Accepted" : "Working on request",
      state: event.kind === "turn.accepted" ? "accepted" : "thinking",
    };
  }
  if (event.kind === "message.final.started") {
    return {
      ...base,
      kind: "message",
      safe_label: "Preparing final answer",
      state: "running",
    };
  }
  if (event.kind === "message.final.completed" || event.kind === "turn.completed") {
    return {
      ...base,
      kind: "turn",
      safe_label: event.kind === "message.final.completed" ? "Final answer ready" : "Completed",
      state: "delivered",
    };
  }
  if (event.kind === "turn.failed" || event.kind === "turn.cancelled") {
    return {
      ...base,
      kind: "turn",
      safe_label:
        event.kind === "turn.failed"
          ? safeText(payload.safeLabel, "Failed")
          : "Cancelled",
      state: event.kind === "turn.failed" ? "failed" : "cancelled",
    };
  }
  return null;
}
