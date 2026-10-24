import { appCopy } from "@/app/copy.ts";
import type { EpicDetail, EpicProgressSnapshot } from "@/app/canonApi.ts";
import { KeyValueRow, ProgressMeter, Stack } from "@/butler-ds";
import { canonTaskCounts } from "./canonProgressSource.ts";

/** Shared task progress below the editable properties. */
export function EpicSessionSummary({ epic, tasks }: { epic: EpicDetail; tasks: EpicProgressSnapshot | null }) {
  const copy = appCopy.canon;
  const counts = tasks?.counts ?? canonTaskCounts(epic);
  const completed = counts.completed ?? 0;
  return <Stack gap="sm">
    <ProgressMeter label={appCopy.sessionInfo.work} ariaLabel={appCopy.sessionInfo.work}
      value={counts.total ? completed / counts.total * 100 : 0} meta={copy.done(completed, counts.total)} />
    {tasks?.actions.filter(action => action.status === "active").map(action => <KeyValueRow
      key={`${action.work_id}:${action.actionKey}`} label={action.description} value={copy.actionStatuses[action.status]} />)}
  </Stack>;
}
