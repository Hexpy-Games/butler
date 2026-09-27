import { useEffect, useState } from "react";

export type SiteTheme = "light" | "dark";

/** The resolved page theme: :root[data-theme] when set, else the OS color scheme. */
export function resolveSiteTheme(): SiteTheme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Tracks the resolved theme across the theme toggle and OS changes; undefined before hydration. */
export function useSiteTheme(): SiteTheme | undefined {
  const [theme, setTheme] = useState<SiteTheme | undefined>(undefined);
  useEffect(() => {
    const update = () => setTheme(resolveSiteTheme());
    update();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return theme;
}
