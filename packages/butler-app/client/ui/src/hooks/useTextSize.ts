import { useButlerStore } from "@/app/store";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { textSizeFactor } from "@/app/textSize";
import { useEffect } from "react";
import type { SettingsView } from "@/app/types";

export function useTextSize(value: SettingsView["text_size"]): void {
  useEffect(() => {
    if (!window.butlerApp?.setTextSize) return;
    document.documentElement.style.setProperty("--ui-scale", String(textSizeFactor(value)));
    void window.butlerApp.setTextSize(value).catch(() => undefined);
  }, [value]);
  useEffect(() => {
    let pending = Promise.resolve();
    return window.butlerApp?.onTextSizeShortcut?.(command => {
      pending = pending.then(async () => {
        const { settings, setSettings } = useButlerStore.getState();
        const sizes = ["default", "large", "larger"] as const;
        const index = sizes.indexOf(settings.text_size);
        const next = command === "reset" ? 0 : Math.max(0, Math.min(2, index + (command === "increase" ? 1 : -1)));
        const text_size = sizes[next];
        if (text_size === settings.text_size) return;
        if (!useSettingsUIStore.getState().draft) useSettingsUIStore.setState({ draft: settings, baseline: settings });
        await useSettingsUIStore.getState().update({ text_size }, setSettings, { optimistic: { text_size }, silent: true });
      });
    });
  }, []);
}
