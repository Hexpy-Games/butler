export type ButlerMarkTheme = "dark" | "light";

export type ButlerMarkThemeColors = Partial<Record<ButlerMarkTheme, string>>;

const DEFAULT_THEME_COLORS: Record<ButlerMarkTheme, string> = {
  dark: "#fff",
  light: "#0a0a0b",
};

export function inkForButlerMarkTheme(theme: ButlerMarkTheme, themeColors?: ButlerMarkThemeColors) {
  return themeColors?.[theme] ?? DEFAULT_THEME_COLORS[theme];
}
