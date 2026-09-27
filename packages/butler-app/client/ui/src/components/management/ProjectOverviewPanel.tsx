import type { ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ProjectDashboardDocument, ProjectDashboardView } from "@/app/types.ts";
import { Button, Card, Grid, MetricCard, MetricGrid, Section, Stack, Typo, Circle, AlertCircle, Inline } from "@/butler-ds";

export function ProjectOverviewPanel({ overview, projectId, onSelect, onShowAll, aside }: {
  overview: ProjectDashboardView["overview"]; projectId?: string;
  onSelect?: (document: ProjectDashboardDocument) => void; onShowAll?: () => void;
  aside?: ReactNode;
}) {
  useAppLocale();
  const copy = appCopy.projectSignpost;
  if (!overview || overview.status === "unavailable") {
    return <Grid columns={{ base: "1", wide: "main-aside" }} gap="xl"><Section title={copy.position}><Typo.Body>
      {overview?.reason === "unbound" ? copy.unbound : copy.unavailable}
    </Typo.Body></Section>{aside}</Grid>;
  }
  return <Stack gap="xl" data-test-class="project-overview-facts">
    <Stack gap="sm">
      <MetricGrid columns={{ base: "3" }}>
        <MetricCard value={overview.progress.completed} label={copy.completed} />
        <MetricCard value={overview.progress.open} label={copy.open} />
        <MetricCard value={overview.progress.blocked} label={copy.blocked} />
      </MetricGrid>
      <Typo.Caption tone="secondary">{copy.recorded} · {copy.registered} {overview.totalWorks}
        {overview.progress.abandoned > 0 && ` · ${copy.abandoned} ${overview.progress.abandoned}`}
        {overview.progress.unknown > 0 && ` · ${copy.unknown} ${overview.progress.unknown}`}</Typo.Caption>
    </Stack>
    <Grid columns={{ base: "1", wide: "main-aside" }} gap="xl">
    <Section title={copy.remaining}>
      <Grid columns="auto-fit" gap="md">{overview.remaining.slice(0, 4).map((work) => <Card key={work.id} interactive
        aria-label={work.title} onClick={() => onSelect?.({ id: work.id, project_id: projectId,
          revision: work.revision ?? overview.sourceRevision, kind: "plan", document_type: "work", title: work.title,
          markdown: "", safe_path_label: work.id, updated_at: work.updatedAt })}>
          <Stack gap="md">
            <Typo.Body lineClamp={2} wrap="anywhere">{work.title}</Typo.Body>
            <Typo.Caption as="div" tone="secondary">
              <Inline as="span" gap="xs">
                {work.executionStatus === "blocked" ? <AlertCircle size="md" /> : <Circle size="md" />}
                {copy[work.executionStatus]}{work.taskProgress && ` · ${copy.tasks} ${work.taskProgress.done}/${work.taskProgress.total}`}
              </Inline>
            </Typo.Caption>
          </Stack>
      </Card>)}</Grid>
      {overview.remaining.length === 0 && <Typo.Body>
        {overview.progress.unknown ? copy.unavailable : copy.noRemaining}
      </Typo.Body>}
      {onShowAll && <Button variant="borderless" onClick={onShowAll}>{copy.loaded(Math.min(4, overview.remaining.length), overview.remainingCount)} · {copy.work}</Button>}
    </Section>
    {aside}
    </Grid>
  </Stack>;
}
