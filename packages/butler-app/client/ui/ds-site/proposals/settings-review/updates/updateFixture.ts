import type { ComponentUpdateStatus } from "@/app/types";
import { emptyComponentStatus } from "@/components/settings/UpdateComponentRow";
import type { ProposalLocale } from "../state";

/** Mock download: 44 MB of 105 MB (42%). */
export const UPDATE_BYTES = { done: 44_102_000, total: 104_857_600 } as const;

export const APP_STATUS: ComponentUpdateStatus = {
  ...emptyComponentStatus("app"),
  current_version: "0.1.0", available_version: "0.1.1", update_available: true, check_state: "ok",
};

export const AGENT_STATUS: ComponentUpdateStatus = {
  ...emptyComponentStatus("service"),
  current_version: "0.1.0", available_version: "0.1.0", update_available: false, check_state: "ok",
};

/** Locale-aware decimal megabytes (`44.1 MB`); the proposal's replacement for the codex formatBytes. */
export function formatUpdateBytes(bytes: number, locale: ProposalLocale): string {
  const megabytes = bytes / 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: "unit", unit: "megabyte", unitDisplay: "short",
    maximumFractionDigits: megabytes < 10 ? 1 : 0,
  }).format(megabytes);
}
