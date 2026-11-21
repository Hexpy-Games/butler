import { useCallback, useEffect, useSyncExternalStore, useState } from "react";
import { GatewayError, type GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { refreshModelCatalog } from "./useModelCatalog";
import type { SettingsView } from "./types";
import { mergeSettings } from "./merge";

type SettingsPatch = { [K in keyof SettingsView]?: NonNullable<SettingsView[K]> extends object ? Partial<NonNullable<SettingsView[K]>> : SettingsView[K] };
const cache = new WeakMap<GatewayClient, SettingsView>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const listen = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useSettings() {
  const { client, reconcile, subscribe } = useConversation();
  const S = getAppCopy(useAppLocale()).settings;
  const [error, setError] = useState(false);
  const settings = useSyncExternalStore(listen, () => client ? cache.get(client) ?? null : null);
  const reload = useCallback(() => {
    if (!client) return;
    setError(false);
    void client.request<SettingsView>("/settings").then(value => {
      cache.set(client, value); notify();
    }).catch(() => setError(true));
  }, [client]);
  useEffect(reload, [reload, reconcile]);
  useEffect(() => subscribe(event => { if (event.type === "settings.updated") reload(); }), [subscribe, reload]);
  const update = async (patch: SettingsPatch, opts?: { silent?: boolean }): Promise<boolean> => {
    if (!client) return false;
    const current = cache.get(client);
    if (!current) return false;
    const optimistic = mergeSettings(current, patch as Partial<SettingsView>);
    cache.set(client, optimistic); notify();
    try {
      const result = await client.request<SettingsView>("/settings", { method: "PATCH", body: patch });
      cache.set(client, { ...optimistic, ...result }); notify();
      if (!opts?.silent) showToast({ message: S.saved, tone: "success" });
      return true;
    } catch (error) {
      cache.set(client, current); notify();
      showToast({ message: S.errors.saveFailed, tone: "error" });
      if (error instanceof GatewayError && error.code === "settings_model_unavailable") {
        void refreshModelCatalog(client).catch(() => {});
      }
      return false;
    }
  };
  return { settings, error, reload, update };
}
