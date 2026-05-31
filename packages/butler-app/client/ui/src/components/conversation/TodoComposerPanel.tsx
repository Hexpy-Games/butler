import { appCopy } from "@/app/copy.ts";
import type { ProgressRow } from "@/app/types.ts";
import { TodoProgressPanel } from "@/butler-ds";
import { todoRowsForDisplay, type TodoComposerItem } from "./todoComposerRows";

export function TodoComposerPanel({ rows }: { rows: ProgressRow[] }) {
  const items = todoRowsForDisplay(rows);
  if (items.length === 0) return null;
  const copy = appCopy.conversation.work;
  return (
    <TodoProgressPanel
      heading={copy.todoListTitle}
      ariaLabel={copy.todoListRegionLabel}
      data-test-class="todo-composer-panel"
      items={items.map((item) => ({
        id: item.id,
        title: item.label,
        state: item.state,
        statusLabel: todoStatusLabel(item.state),
      }))}
    />
  );
}

function todoStatusLabel(state: TodoComposerItem["state"]): string {
  const copy = appCopy.conversation.work;
  if (state === "completed") return copy.todoItemCompletedLabel;
  if (state === "failed") return copy.todoItemFailedLabel;
  if (state === "cancelled") return copy.todoItemCancelledLabel;
  if (state === "running") return copy.todoItemRunningLabel;
  return copy.todoItemPendingLabel;
}
