import type {
  ProgressRow,
  QueuedMessageRecord,
  StewardSessionSummaryView,
} from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import { QueuedComposerPanel } from "./QueuedComposerPanel";
import { WorkerComposerPanel } from "./WorkerComposerPanel";
import { WorkProgressPanel } from "./WorkProgressPanel";
import { StewardComposerPanel } from "./StewardComposerPanel";

export function ComposerAdjunctPanels({
  queuedMessages,
  onEditQueued,
  onDeleteQueued,
  showWorkers,
  taskRows,
  taskTurnState,
  stewardChildren,
}: {
  queuedMessages: QueuedMessageRecord[];
  onEditQueued: (message: QueuedMessageRecord) => void;
  onDeleteQueued: (message: QueuedMessageRecord) => void;
  showWorkers: boolean;
  taskRows: ProgressRow[];
  taskTurnState?: string;
  stewardChildren?: StewardSessionSummaryView[];
}) {
  const runningStewardChildren = stewardChildren ?? [];
  if (!composerHasAdjunct(
    queuedMessages.length,
    showWorkers ? 1 : 0,
    taskRows.length,
    runningStewardChildren.length,
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
      {runningStewardChildren.map((child) => (
        <StewardComposerPanel child={child} key={child.session_id} />
      ))}
    </Stack>
  );
}

export function composerHasAdjunct(
  queuedCount: number,
  workerCount: number,
  taskCount: number,
  stewardCount = 0,
): boolean {
  return queuedCount > 0 || workerCount > 0 || taskCount > 0 || stewardCount > 0;
}
