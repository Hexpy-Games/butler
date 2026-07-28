import type { QueuedMessageRecord, TurnProgressSnapshot } from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import { QueuedComposerPanel } from "./QueuedComposerPanel";
import { WorkerComposerPanel } from "./WorkerComposerPanel";
import { WorkProgressPanel } from "./WorkProgressPanel";

export function ComposerAdjunctPanels({
  queuedMessages,
  onEditQueued,
  onDeleteQueued,
  showWorkers,
  taskProgress,
}: {
  queuedMessages: QueuedMessageRecord[];
  onEditQueued: (message: QueuedMessageRecord) => void;
  onDeleteQueued: (message: QueuedMessageRecord) => void;
  showWorkers: boolean;
  taskProgress?: TurnProgressSnapshot;
}) {
  if (queuedMessages.length === 0 && !showWorkers && !taskProgress)
    return null;

  return (
    <Stack gap="md">
      {taskProgress ? (
        <WorkProgressPanel
          rows={taskProgress.safe_progress_rows ?? []}
          turnState={taskProgress.state}
        />
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
