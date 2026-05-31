import { useEffect } from "react";
import { setNativeAppearanceTheme } from "@/app/api.ts";
import type { SettingsView } from "@/app/types.ts";

export function useNativeAppearanceTheme(
  theme: SettingsView["appearance_theme"],
): void {
  useEffect(() => {
    void setNativeAppearanceTheme(theme).catch(() => undefined);
  }, [theme]);
}
