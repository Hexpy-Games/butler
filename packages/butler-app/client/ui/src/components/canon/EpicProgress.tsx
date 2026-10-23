import { appCopy } from "@/app/copy.ts";
import type { TaskCounts, WorkTasks } from "@/app/canonApi.ts";
import { DisclosureRow, Section, Stack, Tag, Typo } from "@/butler-ds";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";
export function EpicProgress({ tasks, counts }: { tasks: WorkTasks | null; counts: TaskCounts }) {
  return <Section title={appCopy.canon.progress} actions={<Typo.Caption>{appCopy.canon.done(counts.completed ?? 0, counts.total)}</Typo.Caption>} gap="sm">
    {tasks?.chains.some(chain => chain.steps.some(step => step.tasks.length)) ? tasks.chains.map(chain =>
      <Stack key={chain.id} gap="sm" data-chain-id={chain.id}>
        {chain.steps.map(step => <Stack key={step.index} gap="xs" data-step-index={step.index}>
          {step.tasks.map(task => <DisclosureRow key={task.id} surface="plain" affordance="none" title={task.title}
            icon={<CanonStatusGlyph status={task.status} />} meta={<Tag tone={task.status === "failed" ? "danger" : task.status === "blocked" || task.status === "held" ? "warning" : "neutral"}>{appCopy.canon.taskStatuses[task.status]}</Tag>} />)}
        </Stack>)}
      </Stack>) : <Typo.Caption tone="secondary">{appCopy.canon.noTasks}</Typo.Caption>}
  </Section>;
}
