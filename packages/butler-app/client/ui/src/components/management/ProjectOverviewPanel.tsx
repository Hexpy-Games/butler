import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ProjectDashboardDocument, ProjectDashboardView } from "@/app/types.ts";
import { Button, ChevronRight, NavRow, Section, Stack, Typo } from "@/butler-ds";

export function ProjectOverviewPanel({ overview, projectId, onSelect, onShowAll }: {
  overview: ProjectDashboardView["overview"]; projectId?: string;
  onSelect?: (document: ProjectDashboardDocument) => void; onShowAll?: () => void;
}) {
  useAppLocale();
  const copy = appCopy.projectSignpost;
  if (!overview || overview.status === "unavailable") {
    return <Section title={copy.position}><Typo.Body>
      {overview?.reason === "unbound" ? copy.unbound : copy.unavailable}
    </Typo.Body></Section>;
  }
  return <Stack gap="xl" data-test-class="project-overview-facts">
    <Typo.Caption>{copy.recorded} · {copy.registered} {overview.totalWorks} · {copy.completed} {overview.progress.completed}
      {` · ${copy.open} ${overview.progress.open} · ${copy.blocked} ${overview.progress.blocked}`}
      {overview.progress.unknown > 0 && ` · ${copy.unknown} ${overview.progress.unknown}`}
    </Typo.Caption>
    <Section title={copy.remaining}>
      {overview.remaining.map((work) => <NavRow key={work.id} label={work.title} multiline
        meta={`${copy[work.executionStatus]}${work.taskProgress ? ` · ${copy.tasks} ${work.taskProgress.done}/${work.taskProgress.total}` : ""}`}
        actions={<ChevronRight size={16} />} onClick={() => onSelect?.({ id: work.id, project_id: projectId,
          revision: work.revision ?? overview.sourceRevision, kind: "plan", document_type: "work", title: work.title,
          markdown: "", safe_path_label: work.id, updated_at: work.updatedAt })} />)}
      {overview.remaining.length === 0 && <Typo.Body>
        {overview.progress.unknown ? copy.unavailable : copy.noRemaining}
      </Typo.Body>}
      {onShowAll && <Button variant="borderless" onClick={onShowAll}>{copy.loaded(overview.remaining.length, overview.remainingCount)} · {copy.work}</Button>}
    </Section>
  </Stack>;
}
