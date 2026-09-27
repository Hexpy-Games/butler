import { useButlerStore } from "@/app/store.ts";
import { useDeveloperLogsAvailability } from "@/components/settings/useDeveloperLogsAvailability.ts";

/**
 * Developer mode (Settings > About), the same gate the Logs page uses. Agent
 * internals such as context, workers and Git details show only while it is on.
 */
export function useDeveloperMode(): boolean {
  const diagnosticsEnabled = useButlerStore(
    (state) => state.settings.diagnostics_enabled === true,
  );
  return useDeveloperLogsAvailability(diagnosticsEnabled);
}
