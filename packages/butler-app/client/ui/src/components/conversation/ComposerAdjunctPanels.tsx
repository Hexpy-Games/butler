import type { ProgressRow } from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import { WorkerComposerPanel } from "./WorkerComposerPanel";
import { WorkProgressPanel } from "./WorkProgressPanel";

export function ComposerAdjunctPanels({
  showWorkers,
  taskRows,
  taskTurnState,
}: {
  showWorkers: boolean;
  taskRows: ProgressRow[];
  taskTurnState?: string;
}) {
  if (!composerHasAdjunct(showWorkers ? 1 : 0, taskRows.length)) return null;

  return (
    <Stack gap="md">
      {taskRows.length > 0 ? (
        <WorkProgressPanel rows={taskRows} turnState={taskTurnState} />
      ) : null}
      {showWorkers ? <WorkerComposerPanel /> : null}
    </Stack>
  );
}

/** Queued follow-ups live in the conversation (QueuedMessage), not here. */
export function composerHasAdjunct(
  workerCount: number,
  taskCount: number,
): boolean {
  return workerCount > 0 || taskCount > 0;
}
