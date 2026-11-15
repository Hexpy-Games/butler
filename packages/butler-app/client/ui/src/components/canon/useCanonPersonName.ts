import { useEffect } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
let loading: Promise<void> | undefined;
export function useCanonPersonName(): string {
  useAppLocale();
  const profile = useSettingsUIStore(state => state.personalization?.profile);
  useEffect(() => {
    if (useSettingsUIStore.getState().personalization) return;
    loading ??= useSettingsUIStore.getState().loadPersonalization()
      .catch(() => {}).finally(() => { loading = undefined; });
  }, []);
  return profile?.principal_name.trim() || appCopy.canon.me;
}
