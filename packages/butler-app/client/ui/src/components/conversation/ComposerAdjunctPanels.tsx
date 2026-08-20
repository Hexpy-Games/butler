import type { ProgressRow, QueuedMessageRecord } from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import { QueuedComposerPanel } from "./QueuedComposerPanel";
import { WorkerComposerPanel } from "./WorkerComposerPanel";
import { WorkProgressPanel } from "./WorkProgressPanel";

export function ComposerAdjunctPanels({
  queuedMessages,
  onEditQueued,
  onDeleteQueued,
  showWorkers,
  taskRows,
  taskTurnState,
}: {
  queuedMessages: QueuedMessageRecord[];
  onEditQueued: (message: QueuedMessageRecord) => void;
  onDeleteQueued: (message: QueuedMessageRecord) => void;
  showWorkers: boolean;
  taskRows: ProgressRow[];
  taskTurnState?: string;
}) {
  if (!composerHasAdjunct(
    queuedMessages.length,
    showWorkers ? 1 : 0,
    taskRows.length,
  ))
    return null;

  return (
    <Stack gap="md">
      {taskRows.length > 0 ? (
        <WorkProgressPanel rows={taskRows} turnState={taskTurnState} />
      ) : null}
      <QueuedComposerPanel
        messages={queuedMessages}
        onEdit={onEditQueued}
        onDelete={onDeleteQueued}
      />
      {showWorkers ? <WorkerComposerPanel /> : null}
    </Stack>
  );
}

export function composerHasAdjunct(
  queuedCount: number,
  workerCount: number,
  taskCount: number,
): boolean {
  return queuedCount > 0 || workerCount > 0 || taskCount > 0;
}
