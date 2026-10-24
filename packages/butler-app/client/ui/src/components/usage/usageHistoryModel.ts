import type { UsageHistoryView } from "@/app/types";

export type HistoryMode = "daily" | "weekly" | "cumulative";
export type UsageLevel = 0 | 1 | 2 | 3 | 4;
const DAY = 86_400_000;

/** Date keys are host calendar dates, not instants in the browser's time zone. */
export function calendarDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

export function historyDate(key: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(calendarDate(key));
}

export function durationMinutes(totalMinutes: number, copy: { durationHours: (n: number) => string; elapsedMinutes: (n: number) => string }): string {
  const minutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? copy.durationHours(hours) : "", rest || !hours ? copy.elapsedMinutes(rest) : ""].filter(Boolean).join(" ");
}

export function localeWeekStart(locale: string): number {
  const info = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number };
  };
  return (info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 7) % 7;
}

export function dailyLevels(values: number[]): UsageLevel[] {
  const active = values.filter(value => value > 0).sort((a, b) => a - b);
  const middle = Math.floor(active.length / 2);
  const median = active.length % 2 ? active[middle]! : ((active[middle - 1] ?? 0) + (active[middle] ?? 0)) / 2;
  const max = active.at(-1) ?? 0;
  return values.map(value => {
    if (value <= 0) return 0;
    if (value <= median || max === median) return 1;
    const ratio = Math.log(value / median) / Math.log(max / median);
    // Keep exact log-third boundaries inclusive despite floating-point division.
    return ratio <= 1 / 3 + Number.EPSILON ? 2 : ratio <= 2 / 3 + Number.EPSILON ? 3 : 4;
  });
}

/** 53 aligned columns, including the entire current week for the unit-bar views. */
export function historyWindow(history: Pick<UsageHistoryView, "days" | "priorTotal">, weekStart: number, today: string) {
  const end = calendarDate(today).getTime();
  const offset = (new Date(end).getUTCDay() - weekStart + 7) % 7;
  const start = end - (52 * 7 + offset) * DAY;
  const tokens = new Map(history.days);
  const dates = Array.from({ length: 371 }, (_, index) => new Date(start + index * DAY).toISOString().slice(0, 10));
  const values = dates.map(date => date <= today ? tokens.get(date) ?? 0 : 0);
  const weeks = Array.from({ length: 53 }, (_, week) => values.slice(week * 7, week * 7 + 7).reduce((a, b) => a + b, 0));
  let running = history.priorTotal + history.days.reduce((sum, [date, value]) => date < dates[0]! ? sum + value : sum, 0);
  const cumulative = weeks.map(value => (running += value));
  const maxWeek = Math.max(...weeks);
  return { dates, values, levels: dailyLevels(values), weeks, cumulative,
    weeklyHeights: weeks.map(value => maxWeek ? Math.ceil(7 * value / maxWeek) : 0),
    cumulativeHeights: cumulative.map(value => running ? Math.ceil(7 * value / running) : 0) };
}
