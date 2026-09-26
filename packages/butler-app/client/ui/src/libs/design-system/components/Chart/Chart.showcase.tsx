import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./Chart";
import { CHART_COLORS, ChartLegend, chartColor, type ChartColor } from "./ChartLegend";
import styles from "./Chart.module.css";

export const meta: ShowcaseMeta = {
  title: "Chart",
  category: "Data display",
  tags: ["data", "visualization", "analytics", "legend", "chart"],
  status: "stable",
};

const copy = {
  "en-US": { created: "Created", completed: "Completed", failed: "Failed", days: ["Mon", "Tue", "Wed", "Thu", "Fri"], label: "Work by day" },
  "ko-KR": { created: "생성", completed: "완료", failed: "실패", days: ["월", "화", "수", "목", "금"], label: "요일별 작업" },
} as const;

const SERIES: Array<{ key: "created" | "completed" | "failed"; color: ChartColor }> = [
  { key: "created", color: "chart-1" },
  { key: "completed", color: "success" },
  { key: "failed", color: "danger" },
];
const VALUES = [[4, 3, 0], [6, 4, 1], [3, 5, 0], [7, 5, 2], [5, 6, 1]];

/** Bars and legend take their colors from the same chartColor() tokens. */
function WorkChart({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const config: ChartConfig = Object.fromEntries(SERIES.map(({ key, color }) => [key, { label: text[key], color: chartColor(color) }]));
  const data = text.days.map((day, index) => ({ day, created: VALUES[index]![0], completed: VALUES[index]![1], failed: VALUES[index]![2] }));
  return (
    <Stack gap="md">
      <ChartLegend items={SERIES.map(({ key, color }) => ({ key, label: text[key], color }))} />
      <ChartContainer className={styles.chart} config={config} aria-label={text.label}>
        <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} width={24} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent labelKey="day" />} />
          {SERIES.map(({ key }) => <Bar key={key} dataKey={key} stackId="total" fill={`var(--color-${key})`} isAnimationActive={false} />)}
        </BarChart>
      </ChartContainer>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Stacked bars with legend", render: (context) => <WorkChart {...context} /> },
  {
    name: "Legend colors",
    render: () => <ChartLegend items={CHART_COLORS.map((color) => ({ key: color, label: color, color }))} />,
  },
  {
    name: "Legend shapes",
    render: ({ locale }) => (
      <ChartLegend items={[
        { key: "dot", label: `${copy[locale].created} (dot)`, color: "chart-1" },
        { key: "bar", label: `${copy[locale].failed} (bar)`, color: "danger", shape: "bar" },
      ]} />
    ),
  },
];
