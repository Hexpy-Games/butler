import { useEffect, useRef } from "react";
import { appThemeClasses } from "@/app/utils.ts";
import type { SettingsView } from "@/app/types.ts";

const PORTAL_THEME_CLASSES = [
  "theme-dark",
  "theme-light",
  "main-screen-theme-bloom",
  "main-screen-theme-silk",
  "main-screen-theme-none",
  "sidebar-solid",
  "sidebar-translucent",
];

let nextPortalThemeId = 1;
const activePortalThemes = new Map<number, string[]>();

export function usePortalThemeClasses(
  settings: SettingsView,
  prefersDark?: boolean,
) {
  const themeIdRef = useRef<number | null>(null);
  if (themeIdRef.current === null) {
    themeIdRef.current = nextPortalThemeId;
    nextPortalThemeId += 1;
  }

  useEffect(() => {
    const nextClasses = appThemeClasses(settings, prefersDark)
      .split(/\s+/u)
      .filter(Boolean);
    const themeId = themeIdRef.current;
    if (themeId === null) return undefined;
    activePortalThemes.delete(themeId);
    activePortalThemes.set(themeId, nextClasses);
    syncPortalThemeClasses();
    return () => {
      activePortalThemes.delete(themeId);
      syncPortalThemeClasses();
    };
  }, [
    prefersDark,
    settings.appearance_theme,
    settings.main_screen_theme,
    settings.translucent_sidebar,
  ]);
}

function syncPortalThemeClasses() {
  const body = document.body;
  body.classList.remove(...PORTAL_THEME_CLASSES);
  const latestClasses = Array.from(activePortalThemes.values()).at(-1);
  if (!latestClasses) {
    delete body.dataset.butlerPortalTheme;
    return;
  }
  body.classList.add(...latestClasses);
  body.dataset.butlerPortalTheme = "true";
}
