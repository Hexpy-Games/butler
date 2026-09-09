import { useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, ChartContainer, ChartTooltip, ChartTooltipContent, Section, Stack, Typo } from "@/butler-ds";
import type { DashboardStatisticSeries } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import { ProjectStatisticSources } from "./ProjectStatisticSources.tsx";
import styles from "./ProjectStatisticsPanel.module.css";

export function ProjectStatisticChart({ title, description, series, stacked = false, actions, horizontal = false }: {
  title: string; description: string; series: DashboardStatisticSeries; stacked?: boolean; actions?: ReactNode; horizontal?: boolean;
}) {
  useAppLocale();
  const copy = appCopy.projectStatistics;
  const [selected, setSelected] = useState<number>();
  const [metric, setMetric] = useState<string>();
  const keys = series.keys;
  const hasData = series.buckets.some((bucket) => Object.values(bucket.values).some((items) => items.length));
  const rows = series.buckets.map((bucket) => ({ label: bucket.label, displayLabel: copy.labels[bucket.label] ?? bucket.label.slice(5),
    ...Object.fromEntries(series.keys.map((key) => [key, bucket.values[key]?.length ?? 0])) }));
  const colors: Record<string, string> = { created: "var(--context-chart-1)", completed: "var(--ok)", executed: "var(--context-chart-4)",
    delivered: "var(--ok)", failed: "var(--danger)", cancelled: "var(--text-tertiary)", updated: "var(--context-chart-2)",
    spec: "var(--context-chart-1)", plan: "var(--context-chart-2)", report: "var(--context-chart-3)", artifacts: "var(--context-chart-4)" };
  const config = Object.fromEntries(keys.map((key) => [key, { label: copy.labels[key] ?? key, color: colors[key] ?? "var(--context-chart-1)" }]));
  const label = (value: string) => copy.labels[value] ?? value.slice(5);
  const selection = selected === undefined ? undefined : series.buckets[selected];
  const select = (index: number) => { if (index >= 0 && index < rows.length) { setSelected(index); setMetric(undefined); } };
  return <Section title={title} description={description} actions={actions}>
    <Stack gap="md" className={styles.surface}>
      {!hasData ? <Typo.Caption>{keys.length ? copy.empty : copy.unavailable}</Typo.Caption> : <>
        <div className={styles.legend}>{keys.map((key) => <Typo.Caption key={key}>
          <span className={styles.swatch} style={{ background: config[key]!.color }} />{copy.labels[key] ?? key}
        </Typo.Caption>)}</div>
        <ChartContainer className={styles.chart} config={config} aria-label={title}
          onKeyDownCapture={(event) => {
            if (event.key === "ArrowRight") select(Math.min(rows.length - 1, (selected ?? -1) + 1));
            if (event.key === "ArrowLeft") select(Math.max(0, (selected ?? rows.length) - 1));
          }}>
          <BarChart accessibilityLayer layout={horizontal ? "vertical" : "horizontal"} data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
            onClick={(state) => { if (state.activeTooltipIndex != null) select(Number(state.activeTooltipIndex)); }}>
            <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--line)" />
            <XAxis type={horizontal ? "number" : "category"} dataKey={horizontal ? undefined : "displayLabel"} allowDecimals={false} minTickGap={24} tickLine={false} axisLine={false} />
            <YAxis type={horizontal ? "category" : "number"} dataKey={horizontal ? "displayLabel" : undefined} allowDecimals={false} width={horizontal ? 80 : 32} tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent labelKey="displayLabel" />} />
            {keys.map((key) => <Bar key={key} dataKey={key} fill={`var(--color-${key})`} maxBarSize={24}
              stackId={stacked ? "total" : undefined} radius={stacked ? 0 : [3, 3, 0, 0]} isAnimationActive={false}>
              {rows.map((row, index) => <Cell key={row.label} opacity={selected === undefined || selected === index ? 1 : 0.45} />)}
            </Bar>)}
          </BarChart>
        </ChartContainer>
        <ButtonContainer size="sm" className={styles.legend}>
          <Button size="sm" variant="inline" aria-label={`${copy.selected} −1`} onClick={() => select(Math.max(0, (selected ?? rows.length) - 1))}>←</Button>
          <Button size="sm" variant="inline" aria-label={`${copy.selected} +1`} onClick={() => select(Math.min(rows.length - 1, (selected ?? -1) + 1))}>→</Button>
          <Typo.Caption>{selection ? label(selection.label) : copy.selected}</Typo.Caption>
        </ButtonContainer>
        {selection && <>
          <ButtonContainer size="sm" className={styles.legend}>
            <Button size="sm" variant={metric ? "borderless" : "outline"} onClick={() => setMetric(undefined)}>{copy.all}</Button>
            {keys.map((key) => <Button size="sm" key={key} variant={metric === key ? "outline" : "borderless"} onClick={() => setMetric(key)}>
              {copy.labels[key] ?? key} {selection.values[key]?.length ?? 0}
            </Button>)}
          </ButtonContainer>
          <ProjectStatisticSources key={`${selected}:${metric}`} sourceKeys={metric ? selection.values[metric] ?? [] : Object.values(selection.values).flat()} />
        </>}
      </>}
    </Stack>
  </Section>;
}
