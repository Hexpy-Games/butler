import { api } from "./api";
import { reconcileDataGeneration } from "./dataGeneration";
import type { SettingsView } from "./types";

let pending: Promise<SettingsView> | undefined;

/** Share the authoritative startup snapshot with the onboarding gate. */
export function loadStartupSettings(): Promise<SettingsView> {
  pending ??= api<SettingsView>("/settings").then(dropStaleStorage).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

/** Storage from data the agent no longer has (a reset) is removed, then the page starts over. */
function dropStaleStorage(settings: SettingsView): Promise<SettingsView> | SettingsView {
  try {
    if (reconcileDataGeneration(window.localStorage, settings.data_generation, [window.sessionStorage]) !== "wiped") return settings;
  } catch {
    return settings;
  }
  window.location.reload();
  return new Promise<SettingsView>(() => undefined);
}
