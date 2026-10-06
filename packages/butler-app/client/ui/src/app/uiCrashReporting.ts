import { appendCrash, CRASH_LOG_BYTES, CRASH_LOG_KEY, normalizeCrash, type UiCrashEntry } from "../../../electron/ui-crash-log.mjs";
import { useButlerStore } from "./store.ts";

function browserEntries(): UiCrashEntry[] {
  const raw = localStorage.getItem(CRASH_LOG_KEY);
  if (!raw || new TextEncoder().encode(raw).length >= CRASH_LOG_BYTES) return [];
  const entries: unknown = JSON.parse(raw);
  return Array.isArray(entries) ? entries.slice(-50) as UiCrashEntry[] : [];
}

export async function readUiCrashLog(): Promise<UiCrashEntry[]> {
  if (window.butlerApp?.readUiCrashLog) return window.butlerApp.readUiCrashLog();
  try { return browserEntries(); } catch { return []; }
}

/** Diagnostics must never throw back into the crashed renderer. */
export function reportUiCrash(error: unknown, scope: string, componentStack = ""): void {
  try {
    const exception = error instanceof Error ? error : null;
    const entry = normalizeCrash({
      message: exception ? `${exception.name}: ${exception.message}` : "Error: [redacted]",
      stack: exception?.stack ?? "",
      componentStack,
      page: useButlerStore.getState().view.kind,
      scope,
      appVersion: import.meta.env.BUTLER_APP_VERSION,
    });
    if (window.butlerApp?.recordUiCrash) {
      void window.butlerApp.recordUiCrash(entry).catch(() => {});
    } else {
      localStorage.setItem(CRASH_LOG_KEY, JSON.stringify(appendCrash(browserEntries(), entry)));
    }
  } catch { /* Storage unavailable: containment and retry still work. */ }
}

export function installUiCrashReporting(): void {
  window.addEventListener("error", (event) => {
    const error = event.error ?? Object.assign(new Error(event.message), {
      stack: `    at <frame> (${event.filename}:${event.lineno}:${event.colno})`,
    });
    reportUiCrash(error, "window-error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportUiCrash(event.reason, "unhandled-rejection");
  });
}
