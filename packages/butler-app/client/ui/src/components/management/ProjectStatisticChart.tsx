import { useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ChartContainer, ChartLegend, ChartTooltip, ChartTooltipContent, Inline, Section, Stack, Typo, Box, chartColor, type ChartColor } from "@/butler-ds";
import type { DashboardStatisticSeries } from "../../../../shared/app-contracts.ts";
import { ProjectStatisticSources } from "./ProjectStatisticSources.tsx";

/** Series colors: bars and the legend share these DS chart tokens. */
const TONES: Record<string, ChartColor> = {
  created: "chart-1", completed: "success", executed: "chart-4", delivered: "success", failed: "danger",
  cancelled: "chart-5", updated: "chart-2", spec: "chart-1", plan: "chart-2", report: "chart-3", artifacts: "chart-4",
};

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
  const tone = (key: string): ChartColor => TONES[key] ?? "chart-1";
  const config = Object.fromEntries(keys.map((key) => [key, { label: copy.labels[key] ?? key, color: chartColor(tone(key)) }]));
  const label = (value: string) => copy.labels[value] ?? value.slice(5);
  const selection = selected === undefined ? undefined : series.buckets[selected];
  const select = (index: number) => { if (index >= 0 && index < rows.length) { setSelected(index); setMetric(undefined); } };
  return <Section title={title} description={description} actions={actions}>
    <Box border="hairline" radius="control" paddingX="lg" paddingY="md"><Stack gap="md">
      {!hasData ? <Typo.Caption>{keys.length ? copy.empty : copy.unavailable}</Typo.Caption> : <>
        <ChartLegend items={keys.map((key) => ({ key, label: copy.labels[key] ?? key, color: tone(key) }))} />
        <ChartContainer size="panel" config={config} aria-label={title}
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
        <Inline gap="sm" rowGap="sm">
          <Button size="sm" variant="inline" aria-label={`${copy.selected} −1`} onClick={() => select(Math.max(0, (selected ?? rows.length) - 1))}>←</Button>
          <Button size="sm" variant="inline" aria-label={`${copy.selected} +1`} onClick={() => select(Math.min(rows.length - 1, (selected ?? -1) + 1))}>→</Button>
          <Typo.Caption>{selection ? label(selection.label) : copy.selected}</Typo.Caption>
        </Inline>
        {selection && <>
          <Inline gap="sm" rowGap="sm">
            <Button size="sm" variant={metric ? "borderless" : "outline"} onClick={() => setMetric(undefined)}>{copy.all}</Button>
            {keys.map((key) => <Button size="sm" key={key} variant={metric === key ? "outline" : "borderless"} onClick={() => setMetric(key)}>
              {copy.labels[key] ?? key} {selection.values[key]?.length ?? 0}
            </Button>)}
          </Inline>
          <ProjectStatisticSources key={`${selected}:${metric}`} sourceKeys={metric ? selection.values[metric] ?? [] : Object.values(selection.values).flat()} />
        </>}
      </>}
    </Stack></Box>
  </Section>;
}
