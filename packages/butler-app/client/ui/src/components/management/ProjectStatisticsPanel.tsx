import { useEffect, useState } from "react";
import { Line, LineChart, XAxis, YAxis } from "recharts";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ChartContainer, ChartTooltip, ChartTooltipContent, Notice, Section, Stack, Tabs, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import type { DashboardStatisticsView } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import styles from "./ProjectStatisticsPanel.module.css";
import { ProjectWorkTimeline } from "./ProjectWorkTimeline.tsx";

export function ProjectStatisticsPanel({ projectId, revision }: { projectId: string; revision?: string }) {
  useAppLocale();
  const copy = appCopy.projectSignpost;
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [attempt, setAttempt] = useState(0);
  const [keyboard, setKeyboard] = useState(false);
  const [result, setResult] = useState<{ key: string; data?: DashboardStatisticsView; error?: boolean } | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = `${projectId}:${period}:${timezone}`;
  useEffect(() => {
    let cancelled = false;
    api<DashboardStatisticsView>(`/projects/${encodeURIComponent(projectId)}/dashboard/statistics?days=${period}&timezone=${encodeURIComponent(timezone)}`)
      .then((data) => { if (!cancelled) setResult({ key, data }); })
      .catch(() => { if (!cancelled) setResult({ key, error: true }); });
    return () => { cancelled = true; };
  }, [key, projectId, period, timezone, revision, attempt]);
  const data = result?.key === key ? result.data : undefined;
  const dateLabel = (value: string) => value.slice(5);
  return <Stack gap="xl">
    <Tabs value={String(period)} onValueChange={(value) => setPeriod(Number(value) as 7 | 30 | 90)}>
      <TabsList variant="line">{[7, 30, 90].map((days) => <TabsTrigger key={days} value={String(days)}>{copy.periodDays(days)}</TabsTrigger>)}</TabsList>
    </Tabs>
    {result?.key === key && result.error && <Notice tone="error" message={appCopy.feedback.dashboardRetry}
      action={<Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{appCopy.feedback.retry}</Button>} />}
    {!data && !result?.error && <Typo.Body role="status">{appCopy.feedback.dashboardLoading}</Typo.Body>}
    {data && <>
      <Typo.Caption>{copy.statisticsZone(data.timezone)} · {copy.statisticsHelp}</Typo.Caption>
      {(["userMessages", "activeConversations"] as const).map((metric) => <Section key={metric} title={copy[metric]}>
        <ChartContainer className={styles.chart} config={{ [metric]: { label: copy[metric], color: "var(--context-chart-1)" } }} aria-label={copy[metric]}
          onKeyDownCapture={() => setKeyboard(true)} onPointerDownCapture={() => setKeyboard(false)}>
          <LineChart accessibilityLayer data={data.days} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
            <XAxis dataKey="date" tickFormatter={dateLabel} minTickGap={24} /><YAxis allowDecimals={false} width={36} domain={[0, "auto"]} />
            <ChartTooltip trigger={keyboard ? "hover" : "click"} content={<ChartTooltipContent labelKey="date" />} />
            <Line dataKey={metric} type="linear" stroke={`var(--color-${metric})`} dot={period === 7} isAnimationActive={false} />
          </LineChart>
        </ChartContainer>
      </Section>)}
      <ProjectWorkTimeline data={data} />
    </>}
  </Stack>;
}
