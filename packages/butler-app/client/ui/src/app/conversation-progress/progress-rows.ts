import type { ProgressRow } from "../types.ts";

const INTERNAL_TOOL_NAMES = new Set([
  "Update Todo List",
  "List Todo List",
  "Model preparation",
  "모델 준비",
]);
const INTERNAL_RAW_TOOL_NAMES = new Set([
  "update_todo_list",
  "list_todo_list",
  "model_preparation",
]);
const LIFECYCLE_LABELS = new Set([
  "accepted", "started", "thinking", "queued for butler service",
  "working on request", "checking response", "response checked",
  "preparing final answer", "final answer ready", "completed", "delivered",
]);
export function visibleProgressRows(rows: ProgressRow[]): ProgressRow[] {
  return rows.filter((row) => !isInternalProgressRow(row));
}

export function isInternalProgressRow(row: ProgressRow): boolean {
  return (
    isInternalToolName(row.safe_tool_name) ||
    isInternalToolName(row.safe_label) ||
    isInternalToolName(row.safe_input_label)
  );
}

export function semanticProgressRows(rows: ProgressRow[]): ProgressRow[] {
  const visible = visibleProgressRows(rows).filter(
    (row) => row.bridge_phase !== "model_round_waiting",
  );
  const todos = sortedTodoRows(visible.filter((row) => row.kind === "todo"));
  if (todos.length > 0) return todos.slice(0, 8);

  const workRows = dedupeLast(
    visible.filter(
      (row) =>
        row.kind === "work_block" ||
        Boolean(row.work_block_id && row.work_block_label && !row.safe_tool_name),
    ),
    (row) => row.work_block_id ?? row.safe_label.trim().toLowerCase() ?? row.id,
  );
  if (workRows.length > 0) return workRows.slice(-8);

  const messages = dedupeLast(
    visible.filter(
      (row) => row.kind === "message" &&
        !LIFECYCLE_LABELS.has(row.safe_label.trim().toLowerCase()),
    ),
    (row) => row.safe_label.trim().toLowerCase() || row.id,
  );
  if (messages.length > 0) return messages.slice(-8);
  return [];
}

export function summaryProgressRows(rows: ProgressRow[]): ProgressRow[] {
  const visible = visibleProgressRows(rows).filter(
    (row) => row.bridge_phase !== "model_round_waiting",
  );
  const todos = sortedTodoRows(visible.filter(
    (row) => row.kind === "todo" && row.bridge_phase === "btcc_work_ledger",
  ));
  if (todos.length > 0) return todos.slice(0, 8);
  const workRows = dedupeLast(
    visible.filter(
      (row) => row.kind === "work_block" ||
        Boolean(row.work_block_id && row.work_block_label && !row.safe_tool_name),
    ),
    (row) => row.work_block_id ?? row.id,
  );
  if (workRows.length > 0) return workRows.slice(-8);
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const row = visible[index];
    if (row && isModelAuthoredActivity(row)) return [row];
  }
  return [];
}

function isModelAuthoredActivity(row: ProgressRow): boolean {
  if (row.kind === "decision") {
    return row.public_decision_source === "model-authored" &&
      Boolean(row.public_decision_summary);
  }
  return row.kind === "message" &&
    row.work_decision_source === "model-authored" &&
    Boolean(
      row.work_decision_summary &&
      row.work_decision_rationale &&
      row.work_decision_next_step,
    );
}

function sortedTodoRows(rows: ProgressRow[]): ProgressRow[] {
  const byId = new Map<string, { row: ProgressRow; index: number }>();
  rows.forEach((row, index) => {
    const id = normalize(row.safe_input_label ?? row.id);
    if (!id) return;
    const previous = byId.get(id);
    byId.set(id, {
      row: previous ? mergeTodoRow(previous.row, row) : row,
      index: previous?.index ?? index,
    });
  });
  return [...byId.values()]
    .sort((left, right) => {
      const order = rowOrder(left.row) - rowOrder(right.row);
      return order || left.index - right.index;
    })
    .map(({ row }) => row);
}

function mergeTodoRow(current: ProgressRow, incoming: ProgressRow): ProgressRow {
  const state = current.bridge_phase === "btcc_work_ledger" &&
      incoming.bridge_phase === "btcc_work_ledger"
    ? incoming.state
    : mergeState(current.state, incoming.state);
  return {
    ...current,
    ...incoming,
    state,
    created_at: current.created_at ?? incoming.created_at,
    safe_order: minimum(current.safe_order, incoming.safe_order),
  };
}

function mergeState(current: string, incoming: string): string {
  if (isTerminal(incoming)) return incoming;
  if (isTerminal(current)) return current;
  return stateRank(incoming) >= stateRank(current) ? incoming : current;
}

function isTerminal(state: string): boolean {
  return ["failed", "cancelled", "delivered", "complete", "completed", "stopped"]
    .includes(state);
}

function stateRank(state: string): number {
  if (state === "failed" || state === "cancelled") return 4;
  if (["delivered", "complete", "completed"].includes(state)) return 3;
  if (state === "running" || state === "streaming") return 2;
  if (state === "thinking" || state === "accepted") return 1;
  return 0;
}

function rowOrder(row: ProgressRow): number {
  const order = Number(row.safe_order);
  return Number.isFinite(order) && order >= 0 ? order : Number.POSITIVE_INFINITY;
}

function minimum(left?: number, right?: number): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function dedupeLast(
  rows: ProgressRow[],
  keyFor: (row: ProgressRow) => string,
): ProgressRow[] {
  const byKey = new Map<string, ProgressRow>();
  for (const row of rows) byKey.set(keyFor(row), row);
  return [...byKey.values()];
}

function isInternalToolName(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const normalized = trimmed.toLocaleLowerCase("en-US").replace(/\s+/gu, "_");
  return INTERNAL_TOOL_NAMES.has(trimmed) || INTERNAL_RAW_TOOL_NAMES.has(normalized);
}

function normalize(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}
