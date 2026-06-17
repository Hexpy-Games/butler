import { useState } from "react";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { appCopy } from "@/app/copy.ts";
import {
  Activity,
  Button,
  InspectorPanel,
  Stack,
  WorkActivityBlock,
  WorkerActivityPanel,
} from "@/butler-ds";
import {
  groupWorkerActivities,
  workerActivityDisplayName,
  workerActivityDescription,
  workerActivityMeta,
  workerControlLabel,
} from "@/app/utils.ts";
import type { WorkerActivitySummary } from "@/app/types.ts";
import { WorkDecisionBody } from "@/components/conversation/WorkDecisionBody";
import { workActivityToolsForBlock } from "@/components/conversation/toolchainUtils";

export function WorkersPanel({
  workers,
  onWorkerControl,
}: {
  workers: WorkerActivitySummary[];
  onWorkerControl: (workerId: string, control: string) => void;
}) {
  const [expandedWorkerIds, setExpandedWorkerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const groups = groupWorkerActivities(workers);
  const toggleWorker = (workerId: string) =>
    setExpandedWorkerIds((current) => {
      const next = new Set(current);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });
  const workerItem = (worker: WorkerActivitySummary, depth = 0) => {
    const blocks = worker.work_blocks ?? [];
    const expanded = expandedWorkerIds.has(worker.worker_id);
    const detailsId = `worker-details-${worker.worker_id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
    const detailAction = blocks.length > 0 ? (
      <Button
        aria-controls={detailsId}
        aria-expanded={expanded}
        key="details"
        size="xs"
        variant="borderless"
        type="button"
        onClick={() => toggleWorker(worker.worker_id)}
      >
        {expanded
          ? appCopy.inspector.workers.hideDetails
          : appCopy.inspector.workers.showDetails}
      </Button>
    ) : null;
    const detailBlocks = expanded && blocks.length > 0 ? (
      <Stack gap="1" id={detailsId}>
        {blocks.map((block, index) => (
          <WorkActivityBlock
            data-work-block-id={block.id}
            density="compact"
            key={`${block.id}:${index}`}
            running={!worker.terminal && block.state === "running"}
            title={block.label}
            description={<WorkDecisionBody block={block} />}
            tools={workActivityToolsForBlock(block)}
          />
        ))}
      </Stack>
    ) : null;
    const actions = worker.supported_controls.map((control) => (
      <Button
        size="xs"
        variant="borderless"
        key={control}
        type="button"
        onClick={() => onWorkerControl(worker.worker_id, control)}
      >
        {workerControlLabel(control)}
      </Button>
    ));
    if (detailAction) actions.unshift(detailAction);
    return {
      id: worker.worker_id,
      icon: <span className={`worker-dot ${worker.phase}`} />,
      title: workerActivityDisplayName(worker),
      description: workerActivityDescription(worker),
      meta: workerActivityMeta(worker),
      phase: worker.semantic_phase ?? worker.phase,
      depth,
      details: detailBlocks,
      actions,
    };
  };
  const items = groups.flatMap((group) => [
    ...(group.parent ? [workerItem(group.parent)] : []),
    ...group.workers.map((worker) =>
      workerItem(worker, group.parent ? 1 : 0),
    ),
  ]);
  return (
    <InspectorPanel
      title="Workers"
      icon={<Activity size={15} />}
    >
      {workers.length > 0 ? (
        <WorkerActivityPanel items={items} />
      ) : (
        <EmptyPanelLine label="No worker history yet" />
      )}
    </InspectorPanel>
  );
}
