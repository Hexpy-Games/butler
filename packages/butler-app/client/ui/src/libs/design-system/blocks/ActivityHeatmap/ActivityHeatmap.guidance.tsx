import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ActivityHeatmap } from "./ActivityHeatmap";

const DAYS = Array.from({ length: 28 }, (_, index) => ({ id: `day-${index}`, label: `Day ${index + 1}`, count: (index * 5) % 9 }));

// #region recipe: Recent activity calendar
function RecentActivity() {
  return <ActivityHeatmap ariaLabel="Recent activity" startWeekday={1} days={DAYS} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A calendar of days shaded by activity count, optionally selectable with a legend.",
  whenToUse: ["Show activity over weeks on a project dashboard"],
  whenNotToUse: [
    { when: "Exact values per series", use: "ChartContainer" },
    { when: "One total", use: "MetricCard" },
  ],
  recipes: [{ name: "Recent activity calendar", description: "Each day carries a label read by screen readers; null counts mean unavailable.", render: () => <RecentActivity /> }],
  doDont: [
    {
      do: { caption: "Weeks as columns, intensity as shade, labels per day.", render: () => <RecentActivity /> },
      dont: { caption: "A list of daily counts is hard to compare.", render: () => <Stack gap="none"><Typo.Caption>Mon 3</Typo.Caption><Typo.Caption>Tue 5</Typo.Caption><Typo.Caption>Wed 1</Typo.Caption></Stack> },
    },
  ],
  content: ["Day labels say the date and the count; weekday and month labels follow the locale."],
  accessibility: ["Every cell has a label; selection is keyboard reachable when onSelect is set."],
  tokens: ["--accent", "--selection", "--radius-control"],
};
