import type { ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ProjectDashboardDocument, ProjectDashboardView } from "@/app/types.ts";
import { Button, Card, Section, Stack, Typo, Circle, AlertCircle } from "@/butler-ds";
import styles from "./ProjectInformation.module.css";

export function ProjectOverviewPanel({ overview, projectId, onSelect, onShowAll, aside }: {
  overview: ProjectDashboardView["overview"]; projectId?: string;
  onSelect?: (document: ProjectDashboardDocument) => void; onShowAll?: () => void;
  aside?: ReactNode;
}) {
  useAppLocale();
  const copy = appCopy.projectSignpost;
  if (!overview || overview.status === "unavailable") {
    return <div className={styles.overviewPair}><Section title={copy.position}><Typo.Body>
      {overview?.reason === "unbound" ? copy.unbound : copy.unavailable}
    </Typo.Body></Section>{aside}</div>;
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
    <div className={styles.overviewPair}>
    <Section title={copy.remaining}>
      <div className={styles.cards}>{overview.remaining.slice(0, 4).map((work) => <Card key={work.id} padding="none" interactive>
        <Button variant="borderless" className={styles.workCard} onClick={() => onSelect?.({ id: work.id, project_id: projectId,
          revision: work.revision ?? overview.sourceRevision, kind: "plan", document_type: "work", title: work.title,
          markdown: "", safe_path_label: work.id, updated_at: work.updatedAt })}>
          <Stack gap="md">
            <Typo.Body className={styles.title}>{work.title}</Typo.Body>
            <Typo.Caption className={styles.workMeta}>
              {work.executionStatus === "blocked" ? <AlertCircle /> : <Circle />}
              {copy[work.executionStatus]}{work.taskProgress && ` · ${copy.tasks} ${work.taskProgress.done}/${work.taskProgress.total}`}
            </Typo.Caption>
          </Stack>
        </Button>
      </Card>)}</div>
      {overview.remaining.length === 0 && <Typo.Body>
        {overview.progress.unknown ? copy.unavailable : copy.noRemaining}
      </Typo.Body>}
      {onShowAll && <Button variant="borderless" onClick={onShowAll}>{copy.loaded(Math.min(4, overview.remaining.length), overview.remainingCount)} · {copy.work}</Button>}
    </Section>
    {aside}
    </div>
  </Stack>;
}
