import { create } from "zustand";
import { useEffect } from "react";
import { getImageSettings, type ImageSettings } from "./imageApi";

export const useImageSettingsState = create<{ settings?: ImageSettings }>(() => ({}));
let reading: Promise<void> | undefined;
export function refreshImageSettings(): Promise<void> {
  reading ??= getImageSettings().then(settings => { useImageSettingsState.setState({ settings }); }).finally(() => { reading = undefined; });
  return reading;
}
export function useImageModelReady() {
  const settings = useImageSettingsState(s => s.settings);
  useEffect(() => { if (!settings) void refreshImageSettings().catch(() => {}); }, [settings]);
  return Boolean(settings?.selected?.credential_id);
}
