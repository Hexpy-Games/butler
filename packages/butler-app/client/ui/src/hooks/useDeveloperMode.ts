import { useButlerStore } from "@/app/store.ts";

/**
 * Developer mode (Settings > About): the Logs page, DevTools and agent
 * internals such as context, workers and Git details show only while it is on.
 */
export function useDeveloperMode(): boolean {
  return useButlerStore((state) => state.settings.diagnostics_enabled === true);
}
