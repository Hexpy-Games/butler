import { appCopy } from "@/app/copy.ts";
import {
  groupWorkerActivities,
  workerActivityCollapsedSummaryLine,
  workerActivityDescription,
  workerActivityMeta,
} from "@/app/utils.ts";
import type { WorkerActivitySummary } from "@/app/types.ts";
import { useComposerStore } from "./composerStore";
import { WorkerActivityPanel } from "@/butler-ds";

function activityRow(worker: WorkerActivitySummary, depth = 0) {
  return {
    id: worker.worker_id,
    title: worker.worker_label,
    description: workerActivityDescription(worker),
    meta: workerActivityMeta(worker),
    phase: worker.semantic_phase ?? worker.phase,
    depth,
  };
}

export function WorkerComposerPanel() {
  const workers = useComposerStore((store) => store.workers);
  const groups = groupWorkerActivities(workers).slice(0, 4);

  const items = groups.flatMap((group) => [
    ...(group.parent ? [activityRow(group.parent)] : []),
    ...group.workers.map((worker) =>
      activityRow(worker, group.parent ? 1 : 0),
    ),
  ]);
  const collapsedSummary = workerCollapsedSummary(
    items.length,
    groups.flatMap((group) => [
      ...(group.parent ? [group.parent] : []),
      ...group.workers,
    ]),
  );

  return (
    <WorkerActivityPanel
      heading={appCopy.inspector.tabs.workers}
      collapsedSummary={collapsedSummary}
      items={items}
      data-test-class="worker-composer-panel"
      aria-label={appCopy.inspector.tabs.workers}
    />
  );
}

function workerCollapsedSummary(
  count: number,
  workers: WorkerActivitySummary[],
): string | undefined {
  const first = workers[0];
  if (!first) return undefined;
  const summary = workerActivityCollapsedSummaryLine(first);
  const remaining = count - 1;
  return remaining > 0 ? `${summary} 외 ${remaining}개` : summary;
}
