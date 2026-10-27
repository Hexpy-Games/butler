import { appCopy, getAppLocale } from "./copy";
import { initiatedFrequency } from "./scheduleLabels";
import type { InitiatedSchedule } from "./initiatedTypes";

/** A calendar date in the user's zone, advancing only to a matching local day. */
function firstDate(rule: InitiatedSchedule, timeZone: string, now: Date): Date {
  const fields = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(fields.find(field => field.type === name)?.value);
  const day = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  const [hour, minute] = (rule.time ?? "00:00").split(":").map(Number);
  if (part("hour") * 3600 + part("minute") * 60 + part("second") > hour * 3600 + minute * 60) day.setUTCDate(day.getUTCDate() + 1);
  const weekdays = rule.type === "weekdays" ? [1, 2, 3, 4, 5] : rule.type === "weekly" ? rule.weekdays : undefined;
  if (weekdays?.length) while (!weekdays.includes(day.getUTCDay() || 7)) day.setUTCDate(day.getUTCDate() + 1);
  return day;
}

export function initiatedAction(title: string, rule: InitiatedSchedule, timezone: string, start: boolean, nextRun?: string, now = new Date()): string {
  const timeZone = timezone === "local" || !timezone ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;
  const date = start ? new Intl.DateTimeFormat(getAppLocale(), {
    month: "short", day: "numeric", timeZone: nextRun ? timeZone : "UTC",
  }).format(nextRun ? new Date(nextRun) : firstDate(rule, timeZone, now)) : undefined;
  return appCopy.conversation.initiated.action(initiatedFrequency(rule), title, date);
}
