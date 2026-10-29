import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { SubtaskView } from "@/app/types.ts";
import { Eye, IconButton, NavRow, NavRowChildren, NavRowSwap } from "@/butler-ds";
import { SubtaskMark } from "../session-info/SubtaskMark.tsx";
import { openSubtask, subtaskStatus } from "../session-info/subtasks.ts";

/**
 * One unfinished subtask on one sidebar line; the reserved icon column lines its title up with the parent's.
 * The trailing slot has the parent's shape: a status mark resting in a row-action swap (or the resume
 * action itself), so every mark centres on the parent's spinner column at every sidebar density.
 */
function SubtaskLine({ parentId, subtask }: { parentId: string; subtask: SubtaskView }) {
  useAppLocale();
  const open = () => void openSubtask(parentId, subtask);
  const mark = <SubtaskMark parentId={parentId} subtask={subtask} size="sidebar" />;
  const actions = subtask.state === "paused" ? mark : (
    <NavRowSwap rest={mark}>
      <IconButton label={appCopy.interfaceDetails.progressDetails} onClick={open}><Eye size="sm" /></IconButton>
    </NavRowSwap>
  );
  return <NavRow dataTestClass="subtask-line" reserveIcon label={subtask.title} ariaLabel={subtask.title} ariaDescription={subtaskStatus(subtask)}
    actionsVisibility="visible" actions={actions} onClick={open} />;
}

/** The parent's unfinished subtasks, joined to it by a guide line on its icon column. */
export function SubtaskLines({ parentId, subtasks }: { parentId: string; subtasks: SubtaskView[] }) {
  if (subtasks.length === 0) return null;
  return <NavRowChildren dataTestClass="subtask-lines">
    {subtasks.map(subtask => <SubtaskLine key={subtask.session_id} parentId={parentId} subtask={subtask} />)}
  </NavRowChildren>;
}
