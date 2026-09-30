import { appCopy, getAppLocale } from "./copy";
import type { AutomationSummary, CalendarSchedule } from "./types";

export function scheduleState(state: string): string {
  return state === "enabled" ? appCopy.automations.on : appCopy.automations.off;
}

export function scheduleWeekday(day: number): string {
  return new Intl.DateTimeFormat(getAppLocale(), { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(2026, 5, day)));
}

export function scheduleFrequency(value: Pick<AutomationSummary, "schedule" | "schedule_type" | "interval_seconds">): string {
  const copy = appCopy.automations;
  const rule = value.schedule;
  if (rule) {
    const [hour, minute] = rule.time.split(":").map(Number);
    const time = new Intl.DateTimeFormat(getAppLocale(), { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
      .format(new Date(Date.UTC(2026, 0, 1, hour, minute)));
    if (rule.kind === "daily") return copy.dailyAt(time);
    if (rule.weekdays.join(",") === "1,2,3,4,5") return copy.weekdaysAt(time);
    return copy.weeklyAt(rule.weekdays.map(scheduleWeekday).join(", "), time);
  }
  if (value.schedule_type === "once") return copy.once;
  const seconds = value.interval_seconds ?? 1800;
  if (seconds % 3600 === 0) return copy.everyHours(seconds / 3600);
  if (seconds % 60 === 0) return copy.everyMinutes(seconds / 60);
  return copy.everySeconds(seconds);
}

export function scheduleNextRun(value: Pick<AutomationSummary, "schedule" | "next_run_at" | "state">): string {
  if (!value.next_run_at || value.state !== "enabled") return "";
  return appCopy.automations.next(new Intl.DateTimeFormat(getAppLocale(), {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: value.schedule?.tz,
  }).format(new Date(value.next_run_at)));
}

export function localSchedule(kind: CalendarSchedule["kind"], weekdays: number[] = []): CalendarSchedule {
  return { kind, time: "08:00", weekdays, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
