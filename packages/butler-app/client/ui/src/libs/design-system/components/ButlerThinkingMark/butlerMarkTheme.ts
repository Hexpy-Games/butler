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

const INK_TOKENS = { blue: "--butler-ink-blue", pink: "--butler-ink-pink", purple: "--butler-ink-purple" } as const;

/**
 * The riso inks as the `--butler-ink-*` tokens compute on `element` (the same
 * values as RISO_INKS, so the mark renders unchanged), keeping each ink's alpha.
 * Falls back to RISO_INKS when the tokens are absent or the theme is forced
 * against the element's scope.
 */
export function risoInksFor(element: Element | null, theme: ButlerMarkTheme, scopeTheme: ButlerMarkTheme): RisoInks {
  const fallback = RISO_INKS[theme];
  if (!element || theme !== scopeTheme || typeof getComputedStyle !== "function") return fallback;
  const computed = getComputedStyle(element);
  const read = (key: keyof RisoInks): RisoInk => {
    const color = computed.getPropertyValue(INK_TOKENS[key]).trim();
    return color ? { color, alpha: fallback[key].alpha } : fallback[key];
  };
  return { blue: read("blue"), pink: read("pink"), purple: read("purple") };
}
