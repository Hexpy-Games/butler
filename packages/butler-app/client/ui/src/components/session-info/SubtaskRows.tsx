import { Fragment, useState } from "react";
import { useAppLocale } from "@/app/copy.ts";
import type { SubtaskView } from "@/app/types.ts";
import { Clickable, Stack, Tooltip, Typo } from "@/butler-ds";
import { SubtaskWorkerRows } from "./SubtaskWorkerRows.tsx";
import { SubtaskMark } from "./SubtaskMark.tsx";
import { openSubtask, subtaskLabel, subtaskStateLabel } from "./subtasks.ts";
import { useRowTitleTooltip } from "./useRowTitleTooltip.ts";

/** One line per unfinished subtask; a row opens that subtask's observer. */
export function SubtaskRows({ parentId, subtasks }: { parentId: string; subtasks: SubtaskView[] }) {
  return <Stack gap="none">{subtasks.map(subtask => <Fragment key={subtask.session_id}><SubtaskRow parentId={parentId} subtask={subtask} />{subtask.workers?.length ? <SubtaskWorkerRows parentId={parentId} subtask={subtask} workers={subtask.workers} /> : null}</Fragment>)}</Stack>;
}

function SubtaskRow({ parentId, subtask }: { parentId: string; subtask: SubtaskView }) {
  useAppLocale();
  const tooltip = useRowTitleTooltip(subtask.title);
  const [overAction, setOverAction] = useState(false);
  const state = subtaskStateLabel(subtask.state);
  return <Tooltip label={overAction ? undefined : tooltip.label} wrap={tooltip.wrap}>
    <Clickable bleed="inline" stretch onClick={() => void openSubtask(parentId, subtask.session_id)} aria-label={subtaskLabel(subtask)}
      data-test-class="subtask-row" data-subtask-state={subtask.state} onPointerEnter={tooltip.measure}>
      <Stack align="row" cross="center" gap="sm" grow minWidth="0">
        <Stack align="row" cross="baseline" gap="xs" grow minWidth="0">
          <Typo.Body ref={tooltip.titleRef} truncate data-test-class="subtask-title">{subtask.title}</Typo.Body>
          <Typo.Caption tone="tertiary" wrap="nowrap" shrink={false}>{state}</Typo.Caption>
        </Stack>
        <SubtaskMark parentId={parentId} subtask={subtask} size="sm" onActionHover={setOverAction} />
      </Stack>
    </Clickable>
  </Tooltip>;
}
