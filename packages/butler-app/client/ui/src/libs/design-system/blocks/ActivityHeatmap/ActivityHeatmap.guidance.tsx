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

const YEAR = Array.from({ length: 371 }, (_, index) => ({ id: `year-${index}`, label: `Day ${index + 1}`, count: index % 5,
  level: (index % 5) as 0 | 1 | 2 | 3 | 4 }));

// #region recipe: Year at a glance
function YearAtAGlance() {
  return <ActivityHeatmap ariaLabel="Usage over the past year" cell="compact" scrollAnchor="end" days={YEAR}
    weekdayLabels={["", "Mon", "", "Wed", "", "Fri", ""]} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A calendar of days shaded by activity count or by a screen-computed level, optionally selectable with a legend.",
  whenToUse: ["Show activity over weeks on a project dashboard", "A year of daily usage at a glance (cell=\"compact\", scrollAnchor=\"end\")"],
  whenNotToUse: [
    { when: "Exact values per series", use: "ChartContainer" },
    { when: "One total", use: "MetricCard" },
  ],
  recipes: [
    { name: "Recent activity calendar", description: "Each day carries a label read by screen readers; null counts mean unavailable.", render: () => <RecentActivity /> },
    { name: "Year at a glance", description: "53 weeks of 10px cells opened at the latest week; the screen passes each day's level.", render: () => <YearAtAGlance /> },
  ],
  doDont: [
    {
      do: { caption: "Weeks as columns, intensity as shade, labels per day.", render: () => <RecentActivity /> },
      dont: { caption: "A list of daily counts is hard to compare.", render: () => <Stack gap="none"><Typo.Caption>Mon 3</Typo.Caption><Typo.Caption>Tue 5</Typo.Caption><Typo.Caption>Wed 1</Typo.Caption></Stack> },
    },
  ],
  content: ["Day labels say the date and the count; weekday and month labels follow the locale.", "The tooltip reads \"label · countLabel\"; pass blank weekday labels for alternate rows with compact cells.", "Skip the legend when the shade alone tells the story."],
  accessibility: ["Every cell has a label and is one roving tab stop: arrow keys move by day and week, Home and End jump to the ends.", "The tooltip opens on hover and keyboard focus; level changes ease in a wave that reduced motion makes instant."],
  tokens: ["--selection", "--blue-02", "--blue-04", "--blue-06", "--blue-08", "--motion-base", "--focus-ring-room", "--radius-control"],
};
