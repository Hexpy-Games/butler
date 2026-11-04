import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { SubtaskView, SubtaskWorkerView } from "@/app/types.ts";
import { Clickable, Separator, Stack, Tooltip, Typo } from "@/butler-ds";
import { openSubtask } from "./subtasks.ts";
import { useRowTitleTooltip } from "./useRowTitleTooltip.ts";

const phases = { active: "executing", waiting: "waiting", completed: "complete", failed: "failed", blocked: "blocked", cancelled: "cancelled" } as const;

/** Worker children retain their server order, including finished sessions. */
export function SubtaskWorkerRows({ parentId, subtask, workers }: { parentId: string; subtask: SubtaskView; workers: SubtaskWorkerView[] }) {
  return <Stack align="row" gap="none" role="group" aria-label={subtask.title} data-test-class="subtask-workers">
    <Separator orientation="vertical" space="lg" />
    <Stack gap="none" grow minWidth="0">{workers.map(worker => <WorkerRow key={worker.session_id} parentId={parentId} worker={worker} />)}</Stack>
  </Stack>;
}

function WorkerRow({ parentId, worker }: { parentId: string; worker: SubtaskWorkerView }) {
  useAppLocale();
  const tooltip = useRowTitleTooltip(worker.title);
  const state = appCopy.guided.workerStatus[phases[worker.status]];
  return <Tooltip label={tooltip.label} wrap={tooltip.wrap}>
    <Clickable bleed="inline" stretch onClick={() => void openSubtask(parentId, worker.session_id)}
      aria-label={appCopy.sessionInfo.subtaskRow(worker.title, state)} data-test-class="subtask-worker-row" data-worker-status={worker.status}
      onPointerEnter={tooltip.measure}>
      <Stack align="row" cross="baseline" gap="xs" grow minWidth="0">
        <Typo.Body ref={tooltip.titleRef} truncate>{worker.title}</Typo.Body>
        <Typo.Caption tone={worker.status === "failed" ? "danger" : "tertiary"} wrap="nowrap" shrink={false}>{state}</Typo.Caption>
      </Stack>
    </Clickable>
  </Tooltip>;
}
