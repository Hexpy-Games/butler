/** The app theme a surface applies (the global `theme-*`, `sidebar-*` and `main-screen-theme-*` token classes): AdaptiveShell, and portalled Popover / DropdownMenu content. */
export interface AdaptiveShellTheme {
  appearance: "light" | "dark";
  sidebar?: "translucent" | "solid";
  mainScreen?: "none" | "bloom" | "silk";
}

/** Theme token classes for a surface outside the shell (portals, first run). */
export function adaptiveShellThemeClasses(theme: AdaptiveShellTheme): string {
  return [
    `theme-${theme.appearance}`,
    `sidebar-${theme.sidebar ?? "translucent"}`,
    `main-screen-theme-${theme.mainScreen ?? "bloom"}`,
  ].join(" ");
}
