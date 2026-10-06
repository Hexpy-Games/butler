import { DECORATION_THEMES, PAGE_WALLPAPERS, SHORE_OPTIONS, type DecorationTheme, type PageWallpaper, type ShoreOption } from "./decorationScenes";
import type { ProposalLocale } from "./copy";
import { readShoreParams, SHORE_PRESETS, shoreSearch, type ShoreParams } from "./shoreTuning";

export interface ProposalState {
  decor: DecorationTheme;
  character: boolean;
  theme: "light" | "dark" | "both";
  width: "desktop" | "375";
  motion: "full" | "reduced";
  locale: ProposalLocale;
  wallpaper: PageWallpaper;
  /** Composer at rest (the one-row pill) or open (focused: editor + toolbar). */
  composer: "rest" | "open";
  /** Shoreline readability option under review: a accept, b waterline low, c no shoreline, d exposure grade. */
  shore: ShoreOption;
  /** Cherry blossom corner: lush (a thick mass that may reach the end of a long first line) or frame (padding only). */
  cherry: "lush" | "frame";
  /** Cherry blossom drawing style. */
  cherryStyle: "illustrated" | "pixel";
  /** Live tuning of option (d), from the d_* URL params. */
  tune: ShoreParams;
}

export const DEFAULT_PROPOSAL_STATE: ProposalState = {
  decor: "cherry-blossom", character: true, theme: "both", width: "desktop", motion: "full", locale: "ko",
  wallpaper: "butler.bloom", composer: "rest", shore: "d", cherry: "lush", cherryStyle: "illustrated", tune: SHORE_PRESETS.d,
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
    composer: pick(["rest", "open"] as const, params.get("composer"), d.composer),
    shore: pick(SHORE_OPTIONS, params.get("shore"), d.shore),
    cherry: pick(["lush", "frame"] as const, params.get("cherry"), d.cherry),
    cherryStyle: pick(["illustrated", "pixel"] as const, params.get("cherryStyle"), d.cherryStyle),
    tune: readShoreParams("d", search),
  };
}

/** The shoreline look for the selected option: (d) is the live-tuned one. */
export function currentShore(state: ProposalState): ShoreParams {
  return state.shore === "d" ? state.tune : SHORE_PRESETS[state.shore === "c" ? "b" : state.shore];
}

/** Option (c) removes the shoreline: the theme list and the preview fall back to none. */
export function effectiveDecor(state: ProposalState): DecorationTheme {
  return state.decor === "shoreline" && state.shore === "c" ? "none" : state.decor;
}

export function proposalSearch(state: ProposalState): string {
  const params = new URLSearchParams({ page: "proposals/composer-decorations" });
  const entries: Array<[string, string]> = [
    ["decor", state.decor], ["character", state.character ? "on" : "off"], ["theme", state.theme], ["width", state.width],
    ["motion", state.motion], ["locale", state.locale], ["wallpaper", state.wallpaper], ["composer", state.composer],
    ["shore", state.shore], ["cherry", state.cherry], ["cherryStyle", state.cherryStyle], ...shoreSearch(state.tune),
  ];
  for (const [key, value] of entries) params.set(key, value);
  return params.toString();
}

export function writeProposalState(state: ProposalState) {
  window.history.replaceState(null, "", `?${proposalSearch(state)}${window.location.hash}`);
}
