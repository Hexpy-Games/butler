import { useAppLocale } from "@/app/copy.ts";
import type { SubtaskView } from "@/app/types.ts";
import { NavRow, Separator, Stack } from "@/butler-ds";
import { SubtaskMark } from "../session-info/SubtaskMark.tsx";
import { openSubtask } from "../session-info/subtasks.ts";

/** One unfinished subtask on one sidebar line; the reserved icon column lines its title up with the parent's. */
function SubtaskLine({ parentId, subtask }: { parentId: string; subtask: SubtaskView }) {
  useAppLocale();
  return <NavRow dataTestClass="subtask-line" reserveIcon label={subtask.title} ariaLabel={subtask.title}
    actionsVisibility="visible" actions={<SubtaskMark parentId={parentId} subtask={subtask} size="sidebar" />}
    onClick={() => void openSubtask(parentId, subtask)} />;
}

/** The parent's unfinished subtasks beside a zero-width guide line on the parent row's start edge. */
export function SubtaskLines({ parentId, subtasks }: { parentId: string; subtasks: SubtaskView[] }) {
  if (subtasks.length === 0) return null;
  return <Stack align="row" cross="stretch" gap="none" data-test-class="subtask-lines">
    <Separator orientation="vertical" space="none" />
    <Stack gap="none" grow minWidth="0">
      {subtasks.map(subtask => <SubtaskLine key={subtask.session_id} parentId={parentId} subtask={subtask} />)}
    </Stack>
  </Stack>;
}
