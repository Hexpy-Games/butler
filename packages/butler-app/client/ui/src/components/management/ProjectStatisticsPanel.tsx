import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, ChartContainer, ChartTooltip, ChartTooltipContent, ChevronRight, ArrowLeft, DisclosureRow, IconButton, Notice, Section, Stack, Tabs, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import type { DashboardStatisticsView } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import styles from "./ProjectStatisticsPanel.module.css";
import { ProjectWorkTimeline } from "./ProjectWorkTimeline.tsx";

export function ProjectStatisticsPanel({ projectId, revision }: { projectId: string; revision?: string }) {
  const locale = useAppLocale();
  const copy = appCopy.projectSignpost;
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [attempt, setAttempt] = useState(0);
  const [keyboard, setKeyboard] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>();
  const [methodOpen, setMethodOpen] = useState(false);
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
  const selectedIndex = data ? Math.max(0, data.days.findIndex((day) => day.date === (selectedDate ?? data.days.at(-1)?.date))) : 0;
  const selected = data?.days[selectedIndex];
  const selectDay = (index: number) => { if (data?.days[index]) setSelectedDate(data.days[index]!.date); };
  return <Stack gap="xl">
    <Tabs value={String(period)} onValueChange={(value) => setPeriod(Number(value) as 7 | 30 | 90)}>
      <TabsList>{[7, 30, 90].map((days) => <TabsTrigger key={days} value={String(days)}>{copy.periodDays(days)}</TabsTrigger>)}</TabsList>
    </Tabs>
    {result?.key === key && result.error && <Notice tone="error" message={appCopy.feedback.dashboardRetry}
      action={<Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{appCopy.feedback.retry}</Button>} />}
    {!data && !result?.error && <Typo.Body role="status">{appCopy.feedback.dashboardLoading}</Typo.Body>}
    {data && <>
      {selected && <Stack gap="sm" className={styles.selection}>
        <Stack align="row" justify="between" cross="center" gap="md">
          <Typo.Body>{new Date(`${selected.date}T12:00:00`).toLocaleDateString(locale, { month: "long", day: "numeric" })}</Typo.Body>
          <ButtonContainer size="sm">
            <IconButton label={`${copy.selectedDay} −1`} disabled={selectedIndex === 0} onClick={() => selectDay(selectedIndex - 1)}><ArrowLeft /></IconButton>
            <IconButton label={`${copy.selectedDay} +1`} disabled={selectedIndex === data.days.length - 1} onClick={() => selectDay(selectedIndex + 1)}><ChevronRight /></IconButton>
          </ButtonContainer>
        </Stack>
        <Typo.Caption aria-live="polite">{copy.userMessages} {selected.userMessages} · {copy.activeConversations} {selected.activeConversations}</Typo.Caption>
      </Stack>}
      {(["userMessages", "activeConversations"] as const).map((metric) => <Section key={metric} title={copy[metric]}>
        <ChartContainer className={styles.chart} config={{ [metric]: { label: copy[metric], color: "var(--context-chart-1)" } }} aria-label={copy[metric]}
          onKeyDownCapture={(event) => { setKeyboard(true); if (event.key === "ArrowLeft") selectDay(selectedIndex - 1); if (event.key === "ArrowRight") selectDay(selectedIndex + 1); }} onPointerDownCapture={() => setKeyboard(false)}>
          <BarChart accessibilityLayer data={data.days} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}
            onClick={(state) => { if (state.activeTooltipIndex == null) return; const index = Number(state.activeTooltipIndex); if (Number.isInteger(index)) selectDay(index); }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" tickFormatter={dateLabel} minTickGap={24} tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} width={36} domain={[0, "auto"]} tickLine={false} axisLine={false} />
            <ChartTooltip trigger={keyboard ? "hover" : "click"} content={<ChartTooltipContent labelKey="date" />} />
            <Bar dataKey={metric} maxBarSize={24} radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.days.map((day) => <Cell key={day.date} fill={day.date === selected?.date ? "var(--context-chart-1)" : "var(--text-tertiary)"} />)}
            </Bar>
          </BarChart>
        </ChartContainer>
      </Section>)}
      <DisclosureRow surface="plain" title={copy.calculation} open={methodOpen} onToggle={() => setMethodOpen(!methodOpen)}>
        <Typo.Caption>{copy.statisticsZone(data.timezone)} · {copy.statisticsHelp}</Typo.Caption>
      </DisclosureRow>
      <ProjectWorkTimeline data={data} />
    </>}
  </Stack>;
}
