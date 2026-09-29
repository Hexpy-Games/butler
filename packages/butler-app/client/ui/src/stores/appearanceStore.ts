import { create } from "zustand";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";

type SceneTone = "light" | "dark";

interface AppearanceOverrideStore {
  /** The light/dark a real-time wallpaper sets while it is active (its scene tone); null leaves the setting in charge. */
  sceneTone: SceneTone | null;
  setSceneTone: (sceneTone: SceneTone | null) => void;
}

export const useAppearanceOverrideStore = create<AppearanceOverrideStore>((set) => ({
  sceneTone: null,
  setSceneTone: (sceneTone) => set({ sceneTone }),
}));

/** The appearance theme in effect: an active wallpaper's scene tone, else the user's setting. */
export function effectiveAppearanceTheme(
  setting: SettingsView["appearance_theme"],
  sceneTone: SceneTone | null,
): SettingsView["appearance_theme"] {
  return sceneTone ?? setting;
}

export function useAppearanceTheme(): SettingsView["appearance_theme"] {
  const setting = useButlerStore((state) => state.settings.appearance_theme);
  const sceneTone = useAppearanceOverrideStore((state) => state.sceneTone);
  return effectiveAppearanceTheme(setting, sceneTone);
}
