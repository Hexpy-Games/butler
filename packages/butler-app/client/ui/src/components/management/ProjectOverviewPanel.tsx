import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ProjectDashboardDocument, ProjectDashboardView } from "@/app/types.ts";
import { Button, ChevronRight, NavRow, Section, Stack, Typo, Circle, AlertCircle } from "@/butler-ds";
import styles from "./ProjectInformation.module.css";

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
    <Stack gap="xs">
      <div className={styles.numbers}>
        <Typo.Body>{copy.completed} {overview.progress.completed}</Typo.Body>
        <Typo.Body>{copy.open} {overview.progress.open}</Typo.Body>
        <Typo.Body>{copy.blocked} {overview.progress.blocked}</Typo.Body>
      </div>
      <Typo.Caption className={styles.summary}>{copy.recorded} · {copy.registered} {overview.totalWorks}
        {overview.progress.abandoned > 0 && ` · ${copy.abandoned} ${overview.progress.abandoned}`}
        {overview.progress.unknown > 0 && ` · ${copy.unknown} ${overview.progress.unknown}`}</Typo.Caption>
    </Stack>
    <Section title={copy.remaining}>
      <div className={styles.rows}>{overview.remaining.map((work) => <NavRow key={work.id}
        icon={work.executionStatus === "blocked" ? <AlertCircle /> : <Circle />}
        label={<span className={styles.title}>{work.title}</span>} multiline
        meta={<Typo.Caption className={styles.summary}>{`${copy[work.executionStatus]}${work.taskProgress ? ` · ${copy.tasks} ${work.taskProgress.done}/${work.taskProgress.total}` : ""}`}</Typo.Caption>}
        actions={<ChevronRight size={16} />} onClick={() => onSelect?.({ id: work.id, project_id: projectId,
          revision: work.revision ?? overview.sourceRevision, kind: "plan", document_type: "work", title: work.title,
          markdown: "", safe_path_label: work.id, updated_at: work.updatedAt })} />)}</div>
      {overview.remaining.length === 0 && <Typo.Body>
        {overview.progress.unknown ? copy.unavailable : copy.noRemaining}
      </Typo.Body>}
      {onShowAll && <Button variant="borderless" onClick={onShowAll}>{copy.loaded(overview.remaining.length, overview.remainingCount)} · {copy.work}</Button>}
    </Section>
  </Stack>;
}
