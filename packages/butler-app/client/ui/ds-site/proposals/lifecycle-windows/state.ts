import type { WallpaperSource } from "@/butler-ds";

export type ProposalLocale = "ko-KR" | "en-US";
export type LifecycleKind = "startup" | "quit";
export type LifecycleVariant = "card" | "strip";

export const STARTUP_STATES = ["prepare", "engine", "screen", "upgrade", "data", "slow", "error"] as const;
export const QUIT_STATES = ["saving", "search", "storage", "connections", "services", "finishing", "timeout", "failed"] as const;
export type StartupState = (typeof STARTUP_STATES)[number];
export type QuitState = (typeof QUIT_STATES)[number];

export const WALLPAPER_IDS = [
  "butler.bloom", "butler.silk", "butler.riso-flow", "butler.lamina", "butler.diatom", "butler.stipple",
  "butler.dusk", "butler.shoreline", "butler.photo-clouds", "butler.photo-daisies", "none",
] as const;
export type WallpaperId = (typeof WALLPAPER_IDS)[number];

/** `still`: the engine still at window size (recommended). `poster`: today's 320×200 picker poster, upscaled. */
export type Backdrop = "still" | "poster";
export type PageWidth = "desktop" | "768" | "375";

export interface LifecycleState {
  variant: LifecycleVariant;
  startup: StartupState;
  quit: QuitState;
  theme: "light" | "dark";
  wallpaper: WallpaperId;
  backdrop: Backdrop;
  locale: ProposalLocale;
  motion: "auto" | "reduced";
}

export const DEFAULT_STATE: LifecycleState = {
  variant: "card", startup: "engine", quit: "saving", theme: "light",
  wallpaper: "butler.photo-clouds", backdrop: "still", locale: "ko-KR", motion: "auto",
};

/** Real window content sizes in CSS px (= macOS points, Windows DIPs at 100%). */
export const WINDOW_SIZE: Record<LifecycleVariant, { width: number; height: number }> = {
  card: { width: 360, height: 240 },
  strip: { width: 400, height: 176 },
};

export const STAGE_MESSAGE = "butler-lifecycle-proposal";

/** Scene and photo art keep one look in both themes (today's poster rule, startup-appearance.mjs). */
export const SCENE_WALLPAPERS: readonly WallpaperId[] = ["butler.dusk", "butler.shoreline", "butler.photo-clouds", "butler.photo-daisies"];

export function wallpaperSource(id: WallpaperId): WallpaperSource {
  return id === "none" ? { kind: "none" } : { kind: "live", module: id };
}

/** Mark motion per state: working while Butler is busy, the still logo once it needs the user. */
export function markWorking(kind: LifecycleKind, state: StartupState | QuitState): boolean {
  return kind === "startup" ? state !== "error" : state !== "failed";
}

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function stateFromQuery(params: URLSearchParams): LifecycleState {
  return {
    variant: pick(params.get("variant"), ["card", "strip"], DEFAULT_STATE.variant),
    startup: pick(params.get("startup"), STARTUP_STATES, DEFAULT_STATE.startup),
    quit: pick(params.get("quit"), QUIT_STATES, DEFAULT_STATE.quit),
    theme: pick(params.get("theme"), ["light", "dark"], DEFAULT_STATE.theme),
    wallpaper: pick(params.get("wallpaper"), WALLPAPER_IDS, DEFAULT_STATE.wallpaper),
    backdrop: pick(params.get("backdrop"), ["still", "poster"], DEFAULT_STATE.backdrop),
    locale: pick(params.get("locale"), ["ko-KR", "en-US"], DEFAULT_STATE.locale),
    motion: pick(params.get("motion"), ["auto", "reduced"], DEFAULT_STATE.motion),
  };
}

export function stateToQuery(state: LifecycleState): Record<string, string> {
  return { ...state };
}
