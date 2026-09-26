import { Bar, BarChart, XAxis } from "recharts";
import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { ChartContainer, ChartLegend, LegendSwatch, chartColor, type ChartConfig } from "./index";

const DATA = [{ day: "Mon", done: 4 }, { day: "Tue", done: 6 }, { day: "Wed", done: 3 }];

// #region recipe: Bar chart with a matching legend
function DoneChart() {
  const config: ChartConfig = { done: { label: "Done", color: chartColor("success") } };
  return (
    <Stack gap="md">
      <ChartLegend items={[{ key: "done", label: "Done", color: "success" }]} />
      <ChartContainer config={config} aria-label="Work done per day" initialDimension={{ width: 280, height: 140 }}>
        <BarChart data={DATA}>
          <XAxis dataKey="day" tickLine={false} axisLine={false} />
          <Bar dataKey="done" fill="var(--color-done)" radius={4} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Recharts wrapped with DS colors, tooltip and legend so series and legend never drift.",
  whenToUse: ["Show a trend or distribution in a dashboard or statistics panel"],
  whenNotToUse: [
    { when: "A single number", use: "MetricCard" },
    { when: "Activity per day on a calendar", use: "ActivityHeatmap" },
    { when: "A fraction of one budget", use: "ProgressMeter" },
  ],
  recipes: [{ name: "Bar chart with a matching legend", description: "chartColor() feeds ChartConfig and the legend the same token.", render: () => <DoneChart /> }],
  doDont: [
    {
      do: { caption: "Legend swatches come from chartColor like the bars.", render: () => <Stack align="row" gap="xs" cross="center"><LegendSwatch color="success" /><Typo.Caption>Done</Typo.Caption></Stack> },
      dont: { caption: "Hex fills in Recharts bypass the theme and dark mode.", render: () => <Typo.Code>{'<Bar fill="#2a9f48" />'}</Typo.Code> },
    },
  ],
  content: ["Series labels are short nouns; always label the chart (aria-label or a heading)."],
  accessibility: ["Use accessibilityLayer on Recharts charts; never rely on color alone (legend shapes help)."],
  tokens: ["--context-chart-1", "--context-chart-2", "--color-success", "--color-danger", "--line"],
  internalExports: { ChartStyle: "Injected by ChartContainer to map ChartConfig colors to --color-* variables." },
};
