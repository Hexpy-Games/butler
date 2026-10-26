import { textSizeFactor } from "@/app/textSize";
import { useEffect } from "react";
import type { SettingsView } from "@/app/types";

export function useTextSize(value: SettingsView["text_size"]): void {
  useEffect(() => {
    if (!window.butlerApp?.setTextSize) return;
    document.documentElement.style.setProperty("--ui-scale", String(textSizeFactor(value)));
    void window.butlerApp.setTextSize(value).catch(() => undefined);
  }, [value]);
}
