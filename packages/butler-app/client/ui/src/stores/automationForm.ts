import { api, apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import type { AccessMode, SessionControlsView } from "@/app/types.ts";
import { isAccessMode } from "@/components/conversation/accessModeUtils";

/** A new schedule's access mode when the target conversation's mode is unknown. */
export const DEFAULT_SCHEDULE_ACCESS_MODE: AccessMode = "ask_except_reads";

export type AutomationFormField = "title" | "prompt" | "interval" | "accessMode" | "form";

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
};

/** The inline error for a save the gateway refused as invalid (400); null for other failures (toast). */
export function automationSaveError(error: unknown): AutomationSaveError | null {
  const code = apiErrorCode(error);
  const field = code ? FIELD_BY_CODE[code] : undefined;
  const errors = appCopy.automations.errors;
  if (field) return { field, message: errors[field] };
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return status === 400 ? { field: "form", message: errors.invalid } : null;
}

/** The target conversation's current access mode, or null when the UI cannot read it. */
export async function conversationAccessMode(sessionId: string): Promise<AccessMode | null> {
  if (!sessionId || !isServerBackedSessionId(sessionId)) return null;
  try {
    const view = await api<SessionControlsView>(`/sessions/${encodeURIComponent(sessionId)}/controls`);
    return isAccessMode(view?.controls?.access_mode) ? view.controls.access_mode : null;
  } catch {
    return null;
  }
}

export function withoutFieldError(
  error: AutomationSaveError | null,
  field: AutomationFormField,
): AutomationSaveError | null {
  return error?.field === field || error?.field === "form" ? null : error;
}
