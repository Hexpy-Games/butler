import { getAppCopy } from "./copy.ts";
import { api } from "./api.ts";

export type FirstRunLanguage = "en" | "ko";

/** Result of the desktop app's local agent preparation (`POST /setup/start`). */
export interface FirstRunSetupStatusView {
  phase: "idle" | "checking" | "ready" | "failed" | "cancelled";
  diagnostics_available: boolean;
  error_code?: string;
}

/** Bug-report info from the desktop app; labels are added by the renderer. */
export interface FirstRunSetupDiagnosticsView {
  generated_at: string;
  phase: FirstRunSetupStatusView["phase"];
  checks: Array<{
    id: string;
    label?: string;
    status: "pending" | "passed" | "failed" | "cancelled";
  }>;
  errors: Array<{
    code: string;
    message?: string;
    details?: unknown;
  }>;
}

export const firstRunCopy = { ko: getAppCopy("ko-KR").firstRun, en: getAppCopy("en-US").firstRun };

export function detectFirstRunLanguage(
  languages: readonly string[] = [],
): FirstRunLanguage {
  return languages.some((language) =>
    language.toLocaleLowerCase("en-US").startsWith("ko"),
  )
    ? "ko"
    : "en";
}

export async function startFirstRunSetup(
  mode: "check" | "repair" = "check",
): Promise<FirstRunSetupStatusView> {
  return await api<FirstRunSetupStatusView>("/setup/start", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function exportFirstRunSetupDiagnostics(): Promise<FirstRunSetupDiagnosticsView> {
  return await api<FirstRunSetupDiagnosticsView>("/setup/diagnostics");
}

/** Bug-report info with step names and messages in the reader's language. */
export function localizeSetupDiagnostics(
  diagnostics: FirstRunSetupDiagnosticsView,
  copy: Pick<(typeof firstRunCopy)["en"], "prepSteps" | "prepReasons">,
): FirstRunSetupDiagnosticsView {
  return {
    ...diagnostics,
    checks: diagnostics.checks.map((check) => ({ ...check, label: copy.prepSteps[check.id] ?? check.id })),
    errors: diagnostics.errors.map((error) => ({
      ...error,
      message: copy.prepReasons[error.code] ?? copy.prepReasons.default,
    })),
  };
}
