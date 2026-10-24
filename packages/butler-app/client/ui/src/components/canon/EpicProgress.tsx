import { appCopy } from "@/app/copy.ts";
import type { TaskCounts, EpicProgressSnapshot } from "@/app/canonApi.ts";
import { KeyValueRow, Section, Typo } from "@/butler-ds";
export function EpicProgress({ tasks, counts }: { tasks: EpicProgressSnapshot | null; counts: TaskCounts }) {
  const progress = tasks?.counts ?? { completed: counts.completed ?? 0, total: counts.total };
  return <Section title={appCopy.canon.progress} actions={progress.total > 0 ? <Typo.Caption>{appCopy.canon.done(progress.completed, progress.total)}</Typo.Caption> : undefined} gap="sm">
    {tasks?.stage && <Typo.Caption>{appCopy.canon.stages[tasks.stage]}</Typo.Caption>}
    {tasks?.actions.length ? tasks.actions.map(action => <KeyValueRow key={`${action.work_id}:${action.actionKey}`} label={action.description}
      value={appCopy.canon.actionStatuses[action.status]} />)
      : <Typo.Caption tone="secondary">{appCopy.canon.noTasks}</Typo.Caption>}
  </Section>;
}
