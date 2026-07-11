import type { ProgressRow } from "../../app/types.ts";
import { semanticProgressRows } from "../../app/utils.ts";

export interface TodoComposerItem {
  id: string;
  label: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
}

interface RankedTodoComposerItem {
  item: TodoComposerItem;
  order: number;
  index: number;
}

export function todoRowsForDisplay(rows: ProgressRow[]): TodoComposerItem[] {
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
        state: todoState(row.state),
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

function todoState(state?: string): TodoComposerItem["state"] {
  if (state === "delivered" || state === "complete" || state === "completed")
    return "completed";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "running" || state === "streaming") return "running";
  return "pending";
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
