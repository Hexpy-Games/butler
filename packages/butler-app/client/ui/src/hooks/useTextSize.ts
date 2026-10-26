import { useEffect } from "react";
import type { SettingsView } from "@/app/types";

export function useTextSize(value: SettingsView["text_size"]): void {
  useEffect(() => {
    if (!window.butlerApp?.setTextSize) return;
    document.documentElement.style.setProperty("--ui-scale", String(value === "larger" ? 1.3 : value === "large" ? 1.15 : 1));
    void window.butlerApp.setTextSize(value).catch(() => undefined);
  }, [value]);
}
