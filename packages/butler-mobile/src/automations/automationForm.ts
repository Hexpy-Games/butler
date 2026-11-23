import type { AutomationDetail, CalendarSchedule } from "../../../butler-protocol/src/index.ts";
import { GatewayError } from "../../../butler-protocol/src/client/envelope.ts";

export interface AutomationDraft {
  title: string;
  promptBody: string;
  targetSessionId: string;
  intervalSeconds: number;
  customInterval: boolean;
  customMinutes: string;
  schedule: CalendarSchedule | null;
  scheduleType: string;
  runAt?: string;
  startAt?: string;
  accessMode: string;
  model: string;
  initialModel: string;
  browserSignin: boolean;
  browserPayment: boolean;
}

export const intervalPresets = [600, 1800, 3600, 7200, 86400];

export function newDraft(target: string, accessMode: string): AutomationDraft {
  return {
    title: "", promptBody: "", targetSessionId: target,
    intervalSeconds: 1800, customInterval: false, customMinutes: "",
    schedule: null, scheduleType: "interval", accessMode,
    model: "", initialModel: "", browserSignin: false, browserPayment: false,
  };
}

export function draftFromDetail(d: AutomationDetail): AutomationDraft {
  return {
    title: d.title, promptBody: d.prompt_body, targetSessionId: d.target_session_id,
    intervalSeconds: d.interval_seconds, customInterval: !intervalPresets.includes(d.interval_seconds),
    customMinutes: String(d.interval_seconds / 60),
    schedule: d.schedule, scheduleType: d.schedule_type, runAt: d.run_at, startAt: d.start_at,
    accessMode: d.access_mode, model: d.model ?? "", initialModel: d.model ?? "",
    browserSignin: d.browser_signin, browserPayment: d.browser_payment,
  };
}

export function frequencyOf({ schedule, scheduleType }: AutomationDraft): string {
  return schedule?.kind === "daily" ? "daily" : schedule?.weekdays.join(",") === "1,2,3,4,5" ? "weekdays" : schedule ? "weekly" : scheduleType;
}

export function withFrequency(draft: AutomationDraft, value: string): AutomationDraft {
  if (!value || value === "once") return draft;
  if (value === "interval") return { ...draft, schedule: null, scheduleType: "interval" };
  const next = localSchedule(value === "daily" ? "daily" : "weekly", value === "weekdays" ? [1, 2, 3, 4, 5] : value === "weekly" ? [1] : []);
  const schedule = { ...next, time: draft.schedule?.time ?? next.time, tz: draft.schedule?.tz ?? next.tz };
  return { ...draft, schedule, scheduleType: schedule.kind };
}

export function localSchedule(kind: CalendarSchedule["kind"], weekdays: number[] = []): CalendarSchedule {
  return { kind, time: "08:00", weekdays, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export function intervalChoice(draft: AutomationDraft): string {
  return draft.customInterval ? "custom" : String(draft.intervalSeconds);
}

export function withInterval(draft: AutomationDraft, value: string): AutomationDraft {
  return value === "custom"
    ? { ...draft, customInterval: true, customMinutes: "15", intervalSeconds: 900 }
    : { ...draft, customInterval: false, intervalSeconds: Number(value) };
}

export function withCustomMinutes(draft: AutomationDraft, text: string): AutomationDraft {
  return { ...draft, customMinutes: text, intervalSeconds: Number(text) * 60 };
}

export function savePayload(draft: AutomationDraft) {
  return {
    browser_signin: draft.browserSignin,
    browser_payment: draft.browserPayment,
    title: draft.title,
    prompt_body: draft.promptBody,
    target_session_id: draft.targetSessionId,
    interval_seconds: draft.intervalSeconds,
    access_mode: draft.accessMode,
    schedule: draft.schedule,
    schedule_type: draft.scheduleType,
    run_at: draft.runAt,
    start_at: draft.startAt,
    ...(draft.model !== draft.initialModel ? { model: draft.model } : {}),
  };
}

export type AutomationFormField = "title" | "prompt" | "interval" | "accessMode" | "model" | "form";
export interface AutomationSaveError { field: AutomationFormField; message: string }

const fieldsByCode: Partial<Record<string, AutomationFormField>> = {
  automation_title_required: "title",
  automation_prompt_required: "prompt",
  automation_interval_invalid: "interval",
  invalid_json: "accessMode",
};

export function saveError(error: unknown): AutomationFormField | null {
  if (!(error instanceof GatewayError)) return null;
  if (error.status === 409 && error.code === "session_model_unavailable") return "model";
  if (error.status === 400) return fieldsByCode[error.code] ?? "form";
  return null;
}

export function withoutFieldError(error: AutomationSaveError | null, field: AutomationFormField): AutomationSaveError | null {
  return error?.field === field || error?.field === "form" ? null : error;
}
