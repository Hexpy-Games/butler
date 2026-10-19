import { apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type { AccessMode, SettingsView } from "@/app/types.ts";
import { isAccessMode } from "@/components/conversation/accessModeUtils";

/** A new schedule's access mode when the settings do not name one: Auto (D7). */
export const DEFAULT_SCHEDULE_ACCESS_MODE: AccessMode = "auto";

/** A new schedule's access mode: the schedule default the gateway resolves into the settings. */
export function scheduleDefaultAccessMode(settings: Pick<SettingsView, "schedule_access_mode"> | undefined): AccessMode {
  const mode = settings?.schedule_access_mode;
  return isAccessMode(mode) ? mode : DEFAULT_SCHEDULE_ACCESS_MODE;
}

export type AutomationFormField = "title" | "prompt" | "interval" | "accessMode" | "model" | "form";

export interface AutomationSaveError {
  field: AutomationFormField;
  message: string;
}

// The form sends well-formed JSON, so invalid_json means the gateway refused
// the one enumerated value it carries: access_mode.
const FIELD_BY_CODE: Record<string, Exclude<AutomationFormField, "form">> = {
  automation_title_required: "title",
  automation_prompt_required: "prompt",
  automation_interval_invalid: "interval",
  invalid_json: "accessMode",
  session_model_unavailable: "model",
};

/** The inline error for a save the gateway refused on a field (400, or 409 for a model); null for other failures (toast). */
export function automationSaveError(error: unknown): AutomationSaveError | null {
  const code = apiErrorCode(error);
  const field = code ? FIELD_BY_CODE[code] : undefined;
  const errors = appCopy.automations.errors;
  if (field) return { field, message: errors[field] };
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return status === 400 ? { field: "form", message: errors.invalid } : null;
}

export function withoutFieldError(
  error: AutomationSaveError | null,
  field: AutomationFormField,
): AutomationSaveError | null {
  return error?.field === field || error?.field === "form" ? null : error;
}
