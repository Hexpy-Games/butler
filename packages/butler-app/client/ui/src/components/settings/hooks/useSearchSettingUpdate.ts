import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

type WebSearchSettings = SettingsView["web_search"];
export type WebSearchWritableKey =
  | "provider"
  | "reader_backend"
  | "planning_enabled"
  | "planning_default_depth";

/** Writes one web search setting through the settings draft. */
export function useSearchSettingUpdate() {
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  return <K extends WebSearchWritableKey>(key: K, value: WebSearchSettings[K]) =>
    update({ web_search: { [key]: value } }, setSettings);
}
