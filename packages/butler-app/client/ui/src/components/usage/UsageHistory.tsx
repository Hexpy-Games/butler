import { useEffect, useMemo, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import type { UsageHistoryView } from "@/app/types";
import { ActivityHeatmap, MetricCard, MetricGrid, SegmentedControl, Stack, type ActivityHeatmapDay } from "@/butler-ds";
import { calendarDate, durationMinutes, historyDate, historyWindow, localeWeekStart, type HistoryMode } from "./usageHistoryModel";
import { compactTokens } from "./compactTokens";

function HistoryStats({ history, locale }: { history: UsageHistoryView; locale: string }) {
  const copy = appCopy.composer.usage;
  const tokens = (value: number) => compactTokens(value, locale);
  const days = (value: number) => copy.days(Math.round(value));
  const date = (key: string) => historyDate(key, locale);
  const streak = history.longestStreak;
  const [started, setStarted] = useState(false);
  useEffect(() => { setStarted(true); }, []);
  const entering = (value: number) => started ? value : 0;
  return <MetricGrid variant="joined">
    <MetricCard label={copy.lifetimeTokens} value={entering(history.lifetimeTokens)} format={tokens} change=" " />
    <MetricCard label={copy.busiestDay} value={history.busiestDay ? entering(history.busiestDay.tokens) : "—"} format={tokens}
      change={history.busiestDay ? date(history.busiestDay.date) : " "} trend="neutral" />
    <MetricCard label={copy.longestTask} value={history.longestTask ? entering(history.longestTask.durationMs / 60000) : "—"}
      format={value => durationMinutes(value, copy)} change={history.longestTask?.title ?? " "} trend="neutral" />
    <MetricCard label={copy.longestStreak} value={entering(streak.days)} format={days}
      change={streak.start && streak.end ? `${date(streak.start)} – ${date(streak.end)}` : " "} trend="neutral" />
    <MetricCard label={copy.currentStreak} value={entering(history.currentStreak.days)} format={days} change=" " />
  </MetricGrid>;
}

// Reserve the optional caption line without visible loading copy so wrapped rows keep their height.
function HistorySkeleton() {
  const copy = appCopy.composer.usage;
  return <MetricGrid variant="joined">{[copy.lifetimeTokens, copy.busiestDay, copy.longestTask, copy.longestStreak, copy.currentStreak]
    .map(label => <MetricCard key={label} label={label} value="—" change=" " />)}</MetricGrid>;
}

function heatmapDays(history: Pick<UsageHistoryView, "days" | "priorTotal">, today: string, locale: string, mode: HistoryMode): ActivityHeatmapDay[] {
  const model = historyWindow(history, localeWeekStart(locale), today);
  const copy = appCopy.composer.usage;
  return model.dates.flatMap((date, index) => {
    if (mode === "daily" && date > today) return [];
    const week = Math.floor(index / 7), row = index % 7;
    const weeklyDate = historyDate(model.dates[week * 7]!, locale);
    const value = mode === "daily" ? model.values[index]! : mode === "weekly" ? model.weeks[week]! : model.cumulative[week]!;
    const height = mode === "weekly" ? model.weeklyHeights[week]! : model.cumulativeHeights[week]!;
    return [{ id: date, count: value,
      label: mode === "daily" ? historyDate(date, locale) : mode === "weekly" ? copy.weekOf(weeklyDate) : copy.throughWeek(weeklyDate),
      countLabel: value ? compactTokens(value, locale) : copy.noUsage,
      monthLabel: new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(calendarDate(date)),
      level: mode === "daily" ? model.levels[index]! : row >= 7 - height ? 3 : 0 }];
  });
}

export function UsageHistory({ history }: { history: UsageHistoryView | null }) {
  const locale = useAppLocale(), copy = appCopy.composer.usage;
  const [mode, setMode] = useState<HistoryMode>("daily");
  const today = history?.days.at(-1)?.[0] ?? new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const days = useMemo(() => heatmapDays(history ?? { days: [], priorTotal: 0 }, today, locale, mode)
    .map(day => history ? day : { ...day, count: 0, countLabel: "", level: 0 as const }), [history, today, locale, mode]);
  const weekdays = Array.from({ length: 7 }, (_, row) => row % 2 === 0 ? "" : new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(1970, 0, 4 + localeWeekStart(locale) + row))));
  return <Stack gap="lg" aria-busy={!history} data-test-class="usage-history">
    {history ? <HistoryStats history={history} locale={locale} /> : <HistorySkeleton />}
    <SegmentedControl ariaLabel={copy.historyTitle} value={mode} onValueChange={value => setMode(value as HistoryMode)}
      options={[{ value: "daily", label: copy.viewDaily }, { value: "weekly", label: copy.viewWeekly }, { value: "cumulative", label: copy.viewCumulative }]} />
    <ActivityHeatmap ariaLabel={copy.historyTitle} cell="compact" scrollAnchor="end" startWeekday={0} weekdayLabels={weekdays} days={days} />
  </Stack>;
}
