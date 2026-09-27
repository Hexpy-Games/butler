/**
 * Theme preference: "system" follows prefers-color-scheme (no data-theme);
 * "light" / "dark" set :root[data-theme]. Stored per reader; storage may be
 * unavailable (private mode), so every access is guarded. The inline head
 * script in DocsLayout applies a stored choice before first paint.
 */
export type ThemePreference = "system" | "light" | "dark";
export const THEME_STORAGE_KEY = "butler-docs-theme";

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage blocked: the choice lasts for this page view.
  }
}

function syncToggles(preference: ThemePreference) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === preference));
  }
}

export function enhanceThemeToggles() {
  syncToggles(readThemePreference());
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]:not([data-ready])")) {
    button.dataset.ready = "true";
    button.addEventListener("click", () => {
      const choice = button.dataset.themeChoice as ThemePreference;
      applyTheme(choice);
      syncToggles(choice);
    });
  }
}
