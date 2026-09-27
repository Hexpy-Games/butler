import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Typo } from "../../components/Typo";
import { MetricCard } from "./MetricCard";

// #region recipe: Counting metric with a trend
function DoneThisWeek() {
  return <MetricCard label="Done this week" value={31} trend="up" change="+8" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One labelled number, counting to new values, with an optional trend and icon.",
  whenToUse: ["Key numbers on a dashboard or usage page"],
  whenNotToUse: [
    { when: "A trend over time", use: "ChartContainer" },
    { when: "A fraction of a budget", use: "ProgressMeter" },
  ],
  recipes: [{ name: "Counting metric with a trend", description: "Numeric values animate through AnimatedNumber; strings render as is.", render: () => <DoneThisWeek /> }],
  doDont: [
    {
      do: { caption: "Label, value and change in the metric roles.", render: () => <DoneThisWeek /> },
      dont: { caption: "A Card with body text loses the metric scale.", render: () => <Card><Typo.Body>31 done this week</Typo.Body></Card> },
    },
  ],
  content: ["Labels are short nouns; format large numbers compactly (1.2K) with format."],
  accessibility: ["The final value is announced; the trend is also in words (change)."],
  tokens: ["--typo-metric-value-size", "--typo-metric-value-weight", "--surface-raised", "--radius-panel"],
};
