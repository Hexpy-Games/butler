import { useEffect, useState } from "react";
import type { ViewerMotion, ViewerTheme } from "./viewerState";

export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(DARK_QUERY);
    const handleChange = () => setPrefersDark(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);
  return prefersDark;
}

/**
 * Chrome theme plus the themes each example is rendered in. Side-by-side keeps
 * the chrome on the system theme and renders every example light and dark.
 * Portaled overlays read the theme and the motion scope from <body>.
 */
export function useViewerTheme(theme: ViewerTheme, motion: ViewerMotion = "full"): { chrome: ResolvedTheme; frames: ResolvedTheme[] } {
  const prefersDark = useSystemPrefersDark();
  const system: ResolvedTheme = prefersDark ? "dark" : "light";
  const chrome: ResolvedTheme = theme === "light" || theme === "dark" ? theme : system;
  const frames: ResolvedTheme[] = theme === "side-by-side" ? ["light", "dark"] : [chrome];

  useEffect(() => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${chrome}`, "sidebar-translucent");
    return () => document.body.classList.remove(`theme-${chrome}`, "sidebar-translucent");
  }, [chrome]);

  useEffect(() => {
    document.body.dataset.motion = motion;
    return () => { delete document.body.dataset.motion; };
  }, [motion]);

  return { chrome, frames };
}
