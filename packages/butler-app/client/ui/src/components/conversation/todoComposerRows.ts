import type { ProgressRow } from "../../app/types.ts";
import { semanticProgressRows } from "../../app/utils.ts";

export interface TodoComposerItem {
  id: string;
  label: string;
  workLabel?: string;
  state:
    | "pending"
    | "running"
    | "reviewing"
    | "completed"
    | "correction-required"
    | "stopped";
}

interface RankedTodoComposerItem {
  item: TodoComposerItem;
  order: number;
  index: number;
}

export function todoRowsForDisplay(
  rows: ProgressRow[],
  turnState?: string,
): TodoComposerItem[] {
  const byKey = new Map<string, RankedTodoComposerItem>();
  const semanticRows = semanticProgressRows(rows);
  for (const [index, row] of semanticRows.entries()) {
    if (row.kind !== "todo") continue;
    const label = row.safe_label.trim();
    if (!label) continue;
    const todoId = row.safe_input_label?.trim() || row.id;
    if (!todoId) continue;
    const previous = byKey.get(todoId);
    byKey.set(todoId, {
      item: {
        id: todoId,
        label,
        workLabel: workLabel(row),
        state: todoState(row.state, turnState),
      },
      order: previous
        ? mergeTodoOrder(previous.order, todoOrder(row.safe_order))
        : todoOrder(row.safe_order),
      index: previous?.index ?? index,
    });
  }
  return [...byKey.values()]
    .sort(
      (left, right) =>
        compareTodoOrder(left.order, right.order) || left.index - right.index,
    )
    .map((entry) => entry.item);
}

function todoState(state?: string, turnState?: string): TodoComposerItem["state"] {
  if (turnState === "cancelled" && state !== "completed" && state !== "delivered")
    return "stopped";
  if (state === "delivered" || state === "complete" || state === "completed")
    return "completed";
  if (state === "reviewing") return "reviewing";
  if (state === "failed" || state === "correction_required")
    return "correction-required";
  if (state === "cancelled" || state === "stopped") return "stopped";
  if (state === "running" || state === "streaming" || state === "active")
    return "running";
  return "pending";
}

function workLabel(row: ProgressRow): string | undefined {
  return row.safe_detail_rows
    ?.find((detail) => detail.kind === "work" && detail.id === "work")
    ?.safe_value?.trim() || undefined;
}

function todoOrder(value?: number): number {
  const order = Number(value);
  return Number.isFinite(order) && order >= 0
    ? order
    : Number.POSITIVE_INFINITY;
}

function compareTodoOrder(left: number, right: number): number {
  if (left === right) return 0;
  if (!Number.isFinite(left)) return 1;
  if (!Number.isFinite(right)) return -1;
  return left - right;
}

function mergeTodoOrder(left: number, right: number): number {
  if (!Number.isFinite(left)) return right;
  if (!Number.isFinite(right)) return left;
  return Math.min(left, right);
}
