import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Button, Notice, Section, Stack, Tabs, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import type { DashboardStatisticsView } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import { ProjectStatisticsContext } from "./projectStatisticsContext.ts";
import { ProjectStatisticChart } from "./ProjectStatisticChart.tsx";
import { ProjectWorkStatistics } from "./ProjectWorkStatistics.tsx";
import { ProjectActivityStatistics } from "./ProjectActivityStatistics.tsx";
import { ProjectMaterialStatistics } from "./ProjectMaterialStatistics.tsx";
import styles from "./ProjectStatisticsPanel.module.css";

export function ProjectStatisticsPanel({ projectId, revision, onSelect }: {
  projectId: string; revision?: string; onSelect: (document: ProjectDashboardDocument) => void;
}) {
  useAppLocale();
  const copy = appCopy.projectStatistics;
  const openSession = useButlerStore((state) => state.openSession);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: DashboardStatisticsView; error?: boolean } | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = `${projectId}:${period}:${timezone}:${revision}:${attempt}`;
  useEffect(() => {
    let cancelled = false;
    api<DashboardStatisticsView>(`/projects/${encodeURIComponent(projectId)}/dashboard/statistics?days=${period}&timezone=${encodeURIComponent(timezone)}`)
      .then((data) => {
        if (!data.activity?.buckets || !data.materialTypes?.buckets || !data.execution?.outcomes || !data.sources || typeof data.sessionHistoryAvailable !== "boolean") throw new Error("Statistics version unavailable");
        if (!cancelled) setResult({ key, data });
      })
      .catch(() => { if (!cancelled) setResult({ key, error: true }); });
    return () => { cancelled = true; };
  }, [key, projectId, period, timezone]);
  const data = result?.key === key ? result.data : undefined;
  const error = result?.key === key && result.error;
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
      <Tabs value={String(period)} onValueChange={(value) => setPeriod(Number(value) as 7 | 30 | 90)}>
        <TabsList>{[7, 30, 90].map((days) => <TabsTrigger key={days} value={String(days)}>{appCopy.projectSignpost.periodDays(days)}</TabsTrigger>)}</TabsList>
      </Tabs>
      <Typo.Caption>{appCopy.projectSignpost.statisticsZone(timezone)} · {copy.partialDay}</Typo.Caption>
    </Stack>
    {error && <Notice tone="error" message={appCopy.feedback.dashboardRetry}
      action={<Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{appCopy.feedback.retry}</Button>} />}
    {!data && !error && <Typo.Body role="status">{appCopy.feedback.dashboardLoading}</Typo.Body>}
    {data && <ProjectStatisticsContext.Provider key={`${projectId}:${period}`} value={{ data, openSource }}>
      <ProjectWorkStatistics />
      <ProjectActivityStatistics />
      <ProjectMaterialStatistics />
      {data.sessionHistoryAvailable ? <>
      <div className={styles.pair}>
      <ProjectStatisticChart title={copy.outcomes} description={copy.outcomesHelp} series={data.execution.outcomes} stacked />
      <ProjectStatisticChart title={copy.duration} description={copy.durationHelp} series={data.execution.duration} stacked horizontal />
      </div>
      {data.execution.excluded > 0 && <Typo.Caption>{copy.excluded(data.execution.excluded)}</Typo.Caption>}
      </> : <Section title={copy.outcomes}><Typo.Caption>{copy.sessionUnavailable}</Typo.Caption></Section>}
      <Section title={copy.usage}><div className={styles.surface}><Typo.Caption>{copy.usageHelp}</Typo.Caption></div></Section>
    </ProjectStatisticsContext.Provider>}
  </Stack>;
}
