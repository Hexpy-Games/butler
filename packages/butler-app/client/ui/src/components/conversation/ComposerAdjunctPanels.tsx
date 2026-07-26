import type { QueuedMessageRecord } from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import { QueuedComposerPanel } from "./QueuedComposerPanel";
import { WorkerComposerPanel } from "./WorkerComposerPanel";

export function ComposerAdjunctPanels({
  queuedMessages,
  onEditQueued,
  onDeleteQueued,
  showWorkers,
}: {
  queuedMessages: QueuedMessageRecord[];
  onEditQueued: (message: QueuedMessageRecord) => void;
  onDeleteQueued: (message: QueuedMessageRecord) => void;
  showWorkers: boolean;
}) {
  if (queuedMessages.length === 0 && !showWorkers)
    return null;

  return (
    <Stack gap="md">
      <QueuedComposerPanel
        messages={queuedMessages}
        onEdit={onEditQueued}
        onDelete={onDeleteQueued}
      />
      {showWorkers ? <WorkerComposerPanel /> : null}
    </Stack>
  );
}
