import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { MetricCard } from "../MetricCard";
import { MetricGrid } from "./MetricGrid";

// #region recipe: Overview metrics
function OverviewMetrics() {
  return (
    <MetricGrid columns="3">
      <MetricCard label="Open work" value={12} />
      <MetricCard label="Done this week" value={31} />
      <MetricCard label="Conversations" value={46} />
    </MetricGrid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A responsive grid for MetricCards (150px+ columns by default, or a column preset).",
  whenToUse: ["A row of metrics on a dashboard"],
  whenNotToUse: [
    { when: "Cards that are not metrics", use: "Grid" },
    { when: "One metric", use: "MetricCard" },
  ],
  recipes: [{ name: "Overview metrics", description: "Three or four metrics per row; they wrap on narrow widths.", render: () => <OverviewMetrics /> }],
  doDont: [
    {
      do: { caption: "Equal columns that wrap.", render: () => <OverviewMetrics /> },
      dont: { caption: "A row of metrics that never wraps overflows on phones.", render: () => <Stack align="row" gap="sm"><MetricCard label="Open work" value={12} /><MetricCard label="Done this week" value={31} /></Stack> },
    },
  ],
  content: ["Keep the same unit style across a row."],
  accessibility: ["Metrics read in DOM order; keep the most important first."],
  tokens: ["--space-md", "--layout-basis-xs"],
};
