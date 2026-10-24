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

// #region recipe: Joined stat row
function StatRow() {
  return (
    <MetricGrid variant="joined">
      <MetricCard label="Lifetime tokens" value="4.41B" />
      <MetricCard label="Busiest day" value="300M" change="Sep 14" trend="neutral" />
      <MetricCard label="Longest task" value="6h 41m" change="Rewrite the release notes" trend="neutral" />
      <MetricCard label="Longest streak" value="41 days" change="Aug 2 – Sep 11" trend="neutral" />
      <MetricCard label="Current streak" value="23 days" />
    </MetricGrid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A responsive grid for MetricCards (150px+ columns by default, or a column preset), or one joined card of stat tiles.",
  whenToUse: ["A row of metrics on a dashboard", "A summary stat strip at the top of a section (variant=\"joined\")"],
  whenNotToUse: [
    { when: "Cards that are not metrics", use: "Grid" },
    { when: "One metric", use: "MetricCard" },
  ],
  recipes: [
    { name: "Overview metrics", description: "Three or four metrics per row; they wrap on narrow widths.", render: () => <OverviewMetrics /> },
    { name: "Joined stat row", description: "One card split by hairlines; tiles grow so a wrapped row never leaves a hole.", render: () => <StatRow /> },
  ],
  doDont: [
    {
      do: { caption: "Equal columns that wrap.", render: () => <OverviewMetrics /> },
      dont: { caption: "A row of metrics that never wraps overflows on phones.", render: () => <Stack align="row" gap="sm"><MetricCard label="Open work" value={12} /><MetricCard label="Done this week" value={31} /></Stack> },
    },
  ],
  content: ["Keep the same unit style across a row.", "In a joined row each label and caption stays on one line and truncates; keep captions short (a date or a title)."],
  accessibility: ["Metrics read in DOM order; keep the most important first."],
  tokens: ["--space-md", "--layout-basis-xs", "--line", "--surface-raised", "--radius-control"],
};
