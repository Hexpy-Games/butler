import { useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { SubtaskView } from "@/app/types.ts";
import { Clickable, Stack, Tooltip, Typo } from "@/butler-ds";
import { SubtaskMark } from "./SubtaskMark.tsx";
import { openSubtask, subtaskStateLabel } from "./subtasks.ts";

/** One line per unfinished subtask; a row opens that subtask's observer. */
export function SubtaskRows({ parentId, subtasks }: { parentId: string; subtasks: SubtaskView[] }) {
  return <Stack gap="none">{subtasks.map(subtask => <SubtaskRow key={subtask.session_id} parentId={parentId} subtask={subtask} />)}</Stack>;
}

function SubtaskRow({ parentId, subtask }: { parentId: string; subtask: SubtaskView }) {
  useAppLocale();
  const titleRef = useRef<HTMLElement>(null);
  const [truncated, setTruncated] = useState(false);
  const [overAction, setOverAction] = useState(false);
  const state = subtaskStateLabel(subtask.state);
  // At rest the tooltip names the action; a cut title shows in full instead.
  const label = overAction ? undefined : truncated ? subtask.title : appCopy.interfaceDetails.progressDetails;
  return <Tooltip label={label} wrap={truncated}>
    <Clickable bleed="inline" stretch onClick={() => void openSubtask(parentId, subtask)} aria-label={`${subtask.title}, ${state}`}
      data-test-class="subtask-row" data-subtask-state={subtask.state} onPointerEnter={() => {
        const node = titleRef.current;
        setTruncated(Boolean(node && node.scrollWidth > node.clientWidth));
      }}>
      <Stack align="row" cross="center" gap="sm" grow minWidth="0">
        <Stack align="row" cross="baseline" gap="xs" grow minWidth="0">
          <Typo.Body ref={titleRef} truncate data-test-class="subtask-title">{subtask.title}</Typo.Body>
          <Typo.Caption tone="tertiary" wrap="nowrap" shrink={false}>{state}</Typo.Caption>
        </Stack>
        <SubtaskMark parentId={parentId} subtask={subtask} size="sm" onActionHover={setOverAction} />
      </Stack>
    </Clickable>
  </Tooltip>;
}
