import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Stack } from "../../components/Stack";
import { ActivityHeatmap, type ActivityHeatmapDay, type ActivityHeatmapLevel } from "./ActivityHeatmap";

export const meta: ShowcaseMeta = {
  title: "ActivityHeatmap",
  category: "Dashboard & Metrics",
  tags: ["dashboard", "calendar", "heatmap", "statistics"],
  status: "stable",
};

const labels = {
  "en-US": { calendar: "Activity calendar", recent: "Recent activity", legend: "Active items per day", unavailable: "Unavailable", items: (count: number) => `${count} active items` },
  "ko-KR": { calendar: "활동 달력", recent: "최근 활동", legend: "하루 활동 항목", unavailable: "사용할 수 없음", items: (count: number) => `활동 항목 ${count}개` },
} as const;

const START = new Date(2026, 5, 29);

function days(context: ShowcaseRenderContext, length: number, withUnavailable: boolean) {
  const copy = labels[context.locale];
  return Array.from({ length }, (_, index) => {
    const date = new Date(START.getFullYear(), START.getMonth(), START.getDate() + index);
    const count = withUnavailable && index === 3 ? null : (index * 7) % 18;
    return {
      id: `day-${index}`,
      label: `${date.toLocaleDateString(context.locale, { month: "long", day: "numeric" })} · ${count === null ? copy.unavailable : copy.items(count)}`,
      monthLabel: date.toLocaleDateString(context.locale, { month: "short" }),
      countLabel: count === null ? copy.unavailable : copy.items(count),
      count,
    };
  });
}

function weekdays(context: ShowcaseRenderContext) {
  return Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + index).toLocaleDateString(context.locale, { weekday: "short" }));
}

/** ProjectActivityStatistics: 90 selectable days with a legend. */
function Statistics({ context }: { context: ShowcaseRenderContext }) {
  const [selected, setSelected] = useState<string>();
  const copy = labels[context.locale];
  return (
    <ActivityHeatmap ariaLabel={copy.calendar} startWeekday={START.getDay()} weekdayLabels={weekdays(context)}
      selectedId={selected} onSelect={setSelected} days={days(context, 90, true)}
      legend={{ title: copy.legend, labels: ["0", "1", "2–4", "5–9", "10+", copy.unavailable] }} />
  );
}

const YEAR_START = new Date(2025, 9, 19);
const yearCopy = {
  "en-US": { year: "Usage over the past year", none: "No usage", daily: "Daily", weekly: "Weekly", view: "View" },
  "ko-KR": { year: "지난 1년 사용량", none: "사용 없음", daily: "일별", weekly: "주별", view: "보기" },
} as const;

/** A deterministic, heavy-tailed year of usage: idle weekends, a few huge days. */
function yearTokens(index: number) {
  const weekday = (YEAR_START.getDay() + index) % 7;
  if (weekday === 0 || (index * 13) % 11 === 0) return 0;
  return ((index * 7919) % 97) * 1_000_000 * (index % 37 === 0 ? 8 : 1);
}

/** Usage page pattern: 53 full weeks of compact cells; levels come from the screen, Weekly fills columns bottom-up. */
function UsageYear({ context }: { context: ShowcaseRenderContext }) {
  const [view, setView] = useState("daily");
  const copy = yearCopy[context.locale];
  const tokens = Array.from({ length: 371 }, (_, index) => yearTokens(index));
  const max = Math.max(...tokens);
  const weekTotals = Array.from({ length: 53 }, (_, week) => tokens.slice(week * 7, week * 7 + 7).reduce((sum, value) => sum + value, 0));
  const maxWeek = Math.max(...weekTotals);
  const days: ActivityHeatmapDay[] = tokens.map((count, index) => {
    const date = new Date(YEAR_START.getFullYear(), YEAR_START.getMonth(), YEAR_START.getDate() + index);
    const week = Math.floor(index / 7);
    const filled = Math.ceil(7 * weekTotals[week]! / maxWeek);
    const level: ActivityHeatmapLevel = view === "weekly" ? (6 - (index % 7) < filled ? 3 : 0)
      : count === 0 ? 0 : (Math.min(4, Math.ceil(4 * count / max)) as ActivityHeatmapLevel);
    return {
      id: `year-${index}`,
      label: date.toLocaleDateString(context.locale, { month: "short", day: "numeric" }),
      monthLabel: date.toLocaleDateString(context.locale, { month: "short" }),
      countLabel: count === 0 ? copy.none : `${Math.round(count / 1_000_000)}M`,
      count,
      level,
    };
  });
  const weekdayLabels = Array.from({ length: 7 }, (_, index) => index % 2 === 1
    ? new Date(2026, 0, 4 + index).toLocaleDateString(context.locale, { weekday: "short" }) : "");
  return <Stack gap="md">
    <SegmentedControl ariaLabel={copy.view} options={[{ value: "daily", label: copy.daily }, { value: "weekly", label: copy.weekly }]} value={view} onValueChange={setView} />
    <ActivityHeatmap ariaLabel={copy.year} cell="compact" scrollAnchor="end" startWeekday={0} weekdayLabels={weekdayLabels} days={days} />
  </Stack>;
}

export const stories: ShowcaseStory[] = [
  { name: "Usage year (compact, levels, wave)", widths: ["375", "app", "wide"], render: (context) => <UsageYear context={context} /> },
  { name: "Project statistics (selectable)", states: ["selected"], widths: ["375", "app", "wide"], render: (context) => <Statistics context={context} /> },
  {
    // ProjectActivityPanel: compact, read-only, no legend.
    name: "Recent activity (read-only)",
    render: (context) => <ActivityHeatmap ariaLabel={labels[context.locale].recent} startWeekday={START.getDay()} days={days(context, 35, false)} />,
  },
];
