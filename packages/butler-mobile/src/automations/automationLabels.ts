import type { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { AutomationRunSummary, AutomationSummary } from "../../../butler-protocol/src/index.ts";

type Copy = ReturnType<typeof getAppCopy>["automations"];

export function scheduleState(state: string, copy: Copy): string {
  return state === "enabled" ? copy.on : copy.off;
}

export function scheduleFrequency(a: Pick<AutomationSummary, "schedule" | "schedule_type" | "interval_seconds">, copy: Copy, locale: string): string {
  const rule = a.schedule;
  if (rule) {
    const [hour, minute] = rule.time.split(":").map(Number);
    const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
      .format(new Date(Date.UTC(2026, 0, 1, hour, minute)));
    if (rule.kind === "daily") return copy.dailyAt(time);
    if (rule.weekdays.join(",") === "1,2,3,4,5") return copy.weekdaysAt(time);
    return copy.weeklyAt(rule.weekdays.map(day => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(2026, 5, day)))).join(", "), time);
  }
  if (a.schedule_type === "once") return copy.once;
  const seconds = a.interval_seconds ?? 1800;
  if (seconds % 3600 === 0) return copy.everyHours(seconds / 3600);
  if (seconds % 60 === 0) return copy.everyMinutes(seconds / 60);
  return copy.everySeconds(seconds);
}

export function nextRunTime(a: Pick<AutomationSummary, "schedule" | "next_run_at" | "state">, locale: string): string {
  if (!a.next_run_at || a.state !== "enabled") return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: a.schedule?.tz })
    .format(new Date(a.next_run_at));
}

export function automationMeta(a: AutomationSummary, copy: Copy, locale: string): string {
  const next = nextRunTime(a, locale);
  return [scheduleState(a.state, copy), scheduleFrequency(a, copy, locale), next ? copy.next(next) : ""].filter(Boolean).join(" · ");
}

export function runLabel({ state, safe_error_code }: Pick<AutomationRunSummary, "state" | "safe_error_code">, copy: Copy["runs"]): string {
  if (safe_error_code === "schedule_signin_off") return copy.signinOff;
  if (safe_error_code === "schedule_payment_off") return copy.paymentOff;
  if (safe_error_code === "schedule_permission_required") return copy.needsPermission;
  if (state === "queued") return copy.queued;
  if (state === "succeeded") return copy.succeeded;
  if (state === "failed") return copy.failed;
  if (state === "running") return copy.running;
  if (state === "skipped_target_unavailable") return copy.skippedTargetUnavailable;
  if (state === "cancelled") return copy.cancelled;
  return copy.notRun;
}
