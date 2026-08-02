import { appCopy } from "@/app/copy.ts";
import type { ProgressRow } from "@/app/types.ts";
import { TodoProgressPanel } from "@/butler-ds";
import {
  projectComposerTasks,
  type ComposerTaskItem,
} from "@/app/conversation-progress";

export function WorkProgressPanel({
  rows,
  turnState,
}: {
  rows: ProgressRow[];
  turnState?: string;
}) {
  const items = projectComposerTasks(rows, turnState);
  if (items.length === 0) return null;
  const copy = appCopy.conversation.work;
  return (
    <TodoProgressPanel
      heading={copy.todoListTitle}
      ariaLabel={copy.todoListRegionLabel}
      data-test-class="work-progress-panel"
      items={items.map((item) => ({
        id: item.id,
        title: item.label,
        fullTitle: item.fullLabel,
        state: item.state,
        statusLabel: workStatusLabel(item.state),
      }))}
    />
  );
}

function workStatusLabel(state: ComposerTaskItem["state"]): string {
  const copy = appCopy.conversation.work;
  if (state === "completed") return copy.todoItemCompletedLabel;
  if (state === "reviewing") return copy.todoItemReviewingLabel;
  if (state === "correction-required") return copy.todoItemCorrectionLabel;
  if (state === "blocked") return copy.todoItemBlockedLabel;
  if (state === "skipped") return copy.todoItemSkippedLabel;
  if (state === "stopped") return copy.todoItemStoppedLabel;
  if (state === "running") return copy.todoItemRunningLabel;
  return copy.todoItemPendingLabel;
}
