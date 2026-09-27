export type ButlerMarkTheme = "dark" | "light";

export type ButlerMarkThemeColors = Partial<Record<ButlerMarkTheme, string>>;

const DEFAULT_THEME_COLORS: Record<ButlerMarkTheme, string> = {
  dark: "#fff",
  light: "#0a0a0b",
};

export function inkForButlerMarkTheme(theme: ButlerMarkTheme, themeColors?: ButlerMarkThemeColors) {
  return themeColors?.[theme] ?? DEFAULT_THEME_COLORS[theme];
}

export interface RisoInk {
  color: string;
  alpha: number;
}

export interface RisoInks {
  blue: RisoInk;
  pink: RisoInk;
  purple: RisoInk;
}

// Risograph inks printed over the mark while Butler is working (blue + fluorescent pink overprint to purple).
export const RISO_INKS: Record<ButlerMarkTheme, RisoInks> = {
  dark: {
    blue: { color: "#608cff", alpha: 0.85 },
    pink: { color: "#ff70be", alpha: 0.8 },
    purple: { color: "#9660ec", alpha: 1 },
  },
  light: {
    blue: { color: "#0078bf", alpha: 0.8 },
    pink: { color: "#ff48b0", alpha: 0.75 },
    purple: { color: "#60389c", alpha: 1 },
  },
};
