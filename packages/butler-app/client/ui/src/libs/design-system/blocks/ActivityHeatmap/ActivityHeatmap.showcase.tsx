import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ActivityHeatmap } from "./ActivityHeatmap";

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

export const stories: ShowcaseStory[] = [
  { name: "Project statistics (selectable)", states: ["selected"], widths: ["375", "app", "wide"], render: (context) => <Statistics context={context} /> },
  {
    // ProjectActivityPanel: compact, read-only, no legend.
    name: "Recent activity (read-only)",
    render: (context) => <ActivityHeatmap ariaLabel={labels[context.locale].recent} startWeekday={START.getDay()} days={days(context, 35, false)} />,
  },
];
