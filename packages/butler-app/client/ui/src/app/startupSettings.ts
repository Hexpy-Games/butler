import { api } from "./api";
import type { SettingsView } from "./types";

let pending: Promise<SettingsView> | undefined;

/** Share the authoritative startup snapshot with the onboarding gate. */
export function loadStartupSettings(): Promise<SettingsView> {
  pending ??= api<SettingsView>("/settings").catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
