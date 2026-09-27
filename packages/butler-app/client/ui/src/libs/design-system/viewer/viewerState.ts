import type { ShowcaseWidth } from "../showcase/types";

export const VIEWER_THEMES = ["light", "dark", "side-by-side"] as const;
export const VIEWER_LOCALES = ["en", "ko"] as const;
export const VIEWER_WIDTHS = ["320", "375", "430", "app", "wide"] as const satisfies readonly ShowcaseWidth[];
/** "reduced" scopes the reduced-motion token overrides to the viewer (`data-motion`). */
export const VIEWER_MOTIONS = ["full", "reduced"] as const;

/** "system" follows prefers-color-scheme and is never written to the URL. */
export type ViewerTheme = (typeof VIEWER_THEMES)[number] | "system";
export type ViewerLocale = (typeof VIEWER_LOCALES)[number];
export type ViewerMotion = (typeof VIEWER_MOTIONS)[number];

export interface ViewerState {
  page: string;
  theme: ViewerTheme;
  locale: ViewerLocale;
  width: ShowcaseWidth;
  motion: ViewerMotion;
}

export const DEFAULT_VIEWER_STATE: ViewerState = {
  page: "overview",
  theme: "system",
  locale: "en",
  width: "app",
  motion: "full",
};

const KEYS = ["page", "theme", "locale", "width", "motion"] as const satisfies ReadonlyArray<keyof ViewerState>;

function oneOf<T extends string>(options: readonly T[], value: string | null, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

export function parseViewerState(search: string): ViewerState {
  const params = new URLSearchParams(search);
  return {
    page: params.get("page")?.trim() || DEFAULT_VIEWER_STATE.page,
    theme: oneOf(VIEWER_THEMES, params.get("theme"), DEFAULT_VIEWER_STATE.theme),
    locale: oneOf(VIEWER_LOCALES, params.get("locale"), DEFAULT_VIEWER_STATE.locale),
    width: oneOf(VIEWER_WIDTHS, params.get("width"), DEFAULT_VIEWER_STATE.width),
    motion: oneOf(VIEWER_MOTIONS, params.get("motion"), DEFAULT_VIEWER_STATE.motion),
  };
}

/** Deep-link query for `state`, keeping unrelated params such as `visual`. */
export function viewerSearchString(currentSearch: string, state: ViewerState): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of KEYS) {
    if (state[key] === DEFAULT_VIEWER_STATE[key]) params.delete(key);
    else params.set(key, state[key]);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
