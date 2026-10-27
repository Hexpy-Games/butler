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

/** When a schedule a request would create runs: its frequency, then its first run time. */
export function scheduleTiming(value: { scheduleType: string; runAt?: string; startAt?: string; intervalSeconds?: number; time?: string }): string {
  if ((value.scheduleType === "daily" || value.scheduleType === "weekdays") && value.time) {
    return initiatedFrequency({ type: value.scheduleType, time: value.time });
  }
  const frequency = scheduleFrequency({ schedule: null, schedule_type: value.scheduleType, interval_seconds: value.intervalSeconds });
  const once = value.scheduleType === "once";
  const at = once ? value.runAt : value.startAt;
  if (!at || Number.isNaN(Date.parse(at))) return frequency;
  const time = new Intl.DateTimeFormat(getAppLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(at));
  return `${frequency} · ${once ? time : appCopy.automations.next(time)}`;
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

/** Local clock fields are formatted without applying a second timezone conversion. */
export function initiatedFrequency(rule: import("./initiatedTypes").InitiatedSchedule): string {
  const [hour, minute] = (rule.time ?? "00:00").split(":").map(Number);
  const time = new Intl.DateTimeFormat(getAppLocale(), { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" })
    .format(new Date(Date.UTC(1970, 0, 1, hour, minute)));
  if (rule.type === "daily") return appCopy.conversation.initiated.dailyAt(time);
  if (rule.type === "weekdays") return appCopy.conversation.initiated.weekdaysAt(time);
  if (rule.type === "weekly") return appCopy.automations.weeklyAt((rule.weekdays ?? []).map(scheduleWeekday).join(", "), time);
  return rule.type === "interval" ? appCopy.automations.interval : appCopy.automations.once;
}
