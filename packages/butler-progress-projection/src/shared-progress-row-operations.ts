import type { SharedProgressRow } from "./progress-projection-contract.ts";

const TOOL_ACTIVITY_KINDS = new Set([
  "searched",
  "read",
  "ran_command",
  "edited",
  "dispatch",
  "used_tool",
  "context",
  "model",
  "explored",
]);

const INTERNAL_PROGRESS_TOOL_NAMES = new Set([
  "Update Todo List",
  "List Todo List",
  "Model preparation",
  "모델 준비",
  "update_todo_list",
  "list_todo_list",
  "model_preparation",
]);

export function sortProjectionRows<Row extends SharedProgressRow>(rows: Row[]): Row[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const sequenceDelta = projectionOrder(left.row) - projectionOrder(right.row);
      return sequenceDelta || left.index - right.index;
    })
    .map(({ row }) => row);
}

function projectionOrder(row: SharedProgressRow): number {
  const eventSequence = Number(row.turn_event_sequence);
  if (Number.isFinite(eventSequence) && eventSequence >= 0) return eventSequence;
  const safeOrder = Number(row.safe_order);
  return Number.isFinite(safeOrder) && safeOrder >= 0
    ? safeOrder
    : Number.POSITIVE_INFINITY;
}

export function isLegacyDecisionCarrier(row: SharedProgressRow): boolean {
  return row.kind === "message" && Boolean(row.work_block_id && row.work_block_label);
}

export function isToolActivityRow(row: SharedProgressRow): boolean {
  if (row.kind === "todo" || row.kind === "message" || row.kind === "system") return false;
  if (row.kind === "thinking" || row.kind === "worked_duration") return false;
  if (
    INTERNAL_PROGRESS_TOOL_NAMES.has(row.safe_tool_name ?? "") ||
    INTERNAL_PROGRESS_TOOL_NAMES.has(row.safe_label) ||
    INTERNAL_PROGRESS_TOOL_NAMES.has(row.safe_input_label ?? "")
  ) {
    return false;
  }
  if (row.kind === "dispatch" && !row.tool_call_id) return false;
  return Boolean(
    row.tool_call_id ||
      row.safe_input_label ||
      row.safe_detail_rows?.length ||
      TOOL_ACTIVITY_KINDS.has(row.kind ?? ""),
  );
}

export function stripBlockFields<Row extends SharedProgressRow>(row: Row): Row {
  const {
    work_block_id: _workBlockId,
    work_block_label: _workBlockLabel,
    work_block_phase: _workBlockPhase,
    work_block_sequence: _workBlockSequence,
    work_decision_id: _workDecisionId,
    work_decision_title: _workDecisionTitle,
    work_decision_summary: _workDecisionSummary,
    work_decision_rationale: _workDecisionRationale,
    work_decision_next_step: _workDecisionNextStep,
    work_decision_source: _workDecisionSource,
    work_decision_evidence_refs: _workDecisionEvidenceRefs,
    ...toolRow
  } = row;
  return Object.fromEntries(
    Object.entries(toolRow).filter(([, value]) => value !== undefined),
  ) as Row;
}

export function mergeToolRow<Row extends SharedProgressRow>(current: Row, incoming: Row): Row {
  const state = mergeProgressState(current.state, incoming.state);
  const incomingWins = state === incoming.state;
  const merged = incomingWins
    ? { ...current, ...stripBlockFields(incoming), state }
    : { ...stripBlockFields(incoming), ...current, state };
  return {
    ...merged,
    created_at: current.created_at ?? incoming.created_at,
    turn_event_sequence: minimumOptionalNumber(
      current.turn_event_sequence,
      incoming.turn_event_sequence,
    ),
  } as Row;
}

function minimumOptionalNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

export function mergeProgressState(current: string, incoming: string): string {
  if (isTerminalProgressState(incoming)) return incoming;
  if (isTerminalProgressState(current)) return current;
  return progressStateRank(incoming) >= progressStateRank(current)
    ? incoming
    : current;
}

export function isTerminalProgressState(state: string): boolean {
  return ["failed", "cancelled", "delivered", "complete", "completed", "stopped"].includes(state);
}

function progressStateRank(state: string): number {
  if (state === "running" || state === "streaming") return 2;
  if (state === "thinking" || state === "accepted") return 1;
  return 0;
}
