import { useEffect } from "react";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { PersonalizationView } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
let loading: Promise<void> | undefined;
export function useCanonPersonName(): string {
  useAppLocale();
  const profile = useSettingsUIStore(state => state.personalization?.profile);
  useEffect(() => {
    if (useSettingsUIStore.getState().personalization) return;
    loading ??= api<PersonalizationView>("/personalization").then(personalization => {
      useSettingsUIStore.setState({ personalization });
    }).catch(() => {}).finally(() => { loading = undefined; });
  }, []);
  return profile?.principal_name.trim() || appCopy.canon.me;
}
