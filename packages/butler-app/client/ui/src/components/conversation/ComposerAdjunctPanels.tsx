import type { ProgressRow, QueuedMessageRecord } from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import { QueuedComposerPanel } from "./QueuedComposerPanel";
import { TodoComposerPanel } from "./TodoComposerPanel";
import { WorkerComposerPanel } from "./WorkerComposerPanel";

export function ComposerAdjunctPanels({
  queuedMessages,
  onEditQueued,
  onDeleteQueued,
  todoRows,
  showWorkers,
}: {
  queuedMessages: QueuedMessageRecord[];
  onEditQueued: (message: QueuedMessageRecord) => void;
  onDeleteQueued: (message: QueuedMessageRecord) => void;
  todoRows: ProgressRow[];
  showWorkers: boolean;
}) {
  if (queuedMessages.length === 0 && todoRows.length === 0 && !showWorkers)
    return null;

  return (
    <Stack gap="md">
      <QueuedComposerPanel
        messages={queuedMessages}
        onEdit={onEditQueued}
        onDelete={onDeleteQueued}
      />
      <TodoComposerPanel rows={todoRows} />
      {showWorkers ? <WorkerComposerPanel /> : null}
    </Stack>
  );
}
