import { useState } from "react";
import { useProjectStatistics } from "@/hooks/useProjectStatistics.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Button, Grid, Notice, Section, SegmentedControl, Stack, Typo, Box } from "@/butler-ds";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import { ProjectStatisticsContext } from "./projectStatisticsContext.ts";
import { ProjectStatisticChart } from "./ProjectStatisticChart.tsx";
import { ProjectWorkStatistics } from "./ProjectWorkStatistics.tsx";
import { ProjectActivityStatistics } from "./ProjectActivityStatistics.tsx";
import { ProjectMaterialStatistics } from "./ProjectMaterialStatistics.tsx";

export function ProjectStatisticsPanel({ projectId, revision, onSelect }: {
  projectId: string; revision?: string; onSelect: (document: ProjectDashboardDocument) => void;
}) {
  useAppLocale();
  const copy = appCopy.projectStatistics;
  const openSession = useButlerStore((state) => state.openSession);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data, error, loading, retry } = useProjectStatistics(projectId, period, timezone, revision);
  const openSource = (sourceKey: string) => {
    const item = data?.sources[sourceKey];
    if (!item) return;
    if (!item.source) { if (item.session) openSession(item.session.id); return; }
    onSelect({ id: item.source.id, project_id: projectId, revision: item.source.revision,
      kind: item.source.kind === "spec" ? "spec" : item.source.kind === "report" ? "report" : "plan",
      document_type: item.source.kind as ProjectDashboardDocument["document_type"], title: item.title,
      markdown: "", safe_path_label: item.source.id, updated_at: item.at });
  };
  return <Stack gap="xl" data-test-class="project-statistics">
    <Stack gap="sm">
      <SegmentedControl ariaLabel={appCopy.projectSignpost.period} value={String(period)}
        onValueChange={(value) => setPeriod(Number(value) as 7 | 30 | 90)}
        options={[7, 30, 90].map((days) => ({ value: String(days), label: appCopy.projectSignpost.periodDays(days) }))} />
      <Typo.Caption>{appCopy.projectSignpost.statisticsZone(timezone)} · {copy.partialDay}</Typo.Caption>
    </Stack>
    {error && <Notice tone="error" message={copy.loadFailed}
      action={<Button variant="outline" onClick={retry}>{appCopy.feedback.retry}</Button>} />}
    {loading && <Typo.Caption role="status">{data ? copy.refreshing : copy.loading(period)}</Typo.Caption>}
    {data && <ProjectStatisticsContext.Provider key={`${projectId}:${period}`} value={{ data, openSource }}>
      <ProjectWorkStatistics />
      <ProjectActivityStatistics />
      <ProjectMaterialStatistics />
      {data.sessionHistoryAvailable ? <>
      <Grid columns={{ base: "1", wide: "2" }} gap="xl">
      <ProjectStatisticChart title={copy.outcomes} description={copy.outcomesHelp} series={data.execution.outcomes} stacked />
      <ProjectStatisticChart title={copy.duration} description={copy.durationHelp} series={data.execution.duration} stacked horizontal />
      </Grid>
      {data.execution.excluded > 0 && <Typo.Caption>{copy.excluded(data.execution.excluded)}</Typo.Caption>}
      </> : <Section title={copy.outcomes}><Typo.Caption>{copy.sessionUnavailable}</Typo.Caption></Section>}
      <Section title={copy.usage}><Box border="hairline" radius="control" paddingX="lg" paddingY="md"><Typo.Caption>{copy.usageHelp}</Typo.Caption></Box></Section>
    </ProjectStatisticsContext.Provider>}
  </Stack>;
}
