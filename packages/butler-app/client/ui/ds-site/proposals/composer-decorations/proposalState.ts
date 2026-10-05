import { DECORATION_THEMES, PAGE_WALLPAPERS, type DecorationTheme, type PageWallpaper } from "./decorationScenes";
import type { ProposalLocale } from "./copy";

export interface ProposalState {
  decor: DecorationTheme;
  character: boolean;
  theme: "light" | "dark" | "both";
  width: "desktop" | "375";
  motion: "full" | "reduced";
  locale: ProposalLocale;
  wallpaper: PageWallpaper;
}

export const DEFAULT_PROPOSAL_STATE: ProposalState = {
  decor: "shoreline", character: true, theme: "both", width: "desktop", motion: "full", locale: "ko", wallpaper: "butler.bloom",
};

function pick<T extends string>(options: readonly T[], value: string | null, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** Every knob is a deep-linkable query param next to `page`. */
export function readProposalState(search: string): ProposalState {
  const params = new URLSearchParams(search);
  const d = DEFAULT_PROPOSAL_STATE;
  return {
    decor: pick(DECORATION_THEMES, params.get("decor"), d.decor),
    character: params.has("character") ? params.get("character") !== "off" : d.character,
    theme: pick(["light", "dark", "both"] as const, params.get("theme"), d.theme),
    width: pick(["desktop", "375"] as const, params.get("width"), d.width),
    motion: pick(["full", "reduced"] as const, params.get("motion"), d.motion),
    locale: pick(["en", "ko"] as const, params.get("locale"), d.locale),
    wallpaper: pick(PAGE_WALLPAPERS, params.get("wallpaper"), d.wallpaper),
  };
}

export function writeProposalState(state: ProposalState) {
  const params = new URLSearchParams(window.location.search);
  const entries: Array<[string, string]> = [
    ["decor", state.decor], ["character", state.character ? "on" : "off"], ["theme", state.theme], ["width", state.width],
    ["motion", state.motion], ["locale", state.locale], ["wallpaper", state.wallpaper],
  ];
  for (const [key, value] of entries) params.set(key, value);
  window.history.replaceState(null, "", `?${params.toString()}${window.location.hash}`);
}
