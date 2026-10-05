import type { WallpaperSource } from "@/butler-ds";
import type { ProposalLocale, Scenario, Variant } from "./copy";

export type StageWidth = "desktop" | "768" | "375";
export type StageWallpaper = "clouds" | "daisies" | "bloom" | "none";

export interface StageState {
  variant: Variant;
  scenario: Scenario;
  theme: "light" | "dark";
  wallpaper: StageWallpaper;
  locale: ProposalLocale;
  motion: "full" | "reduced";
}

export const DEFAULT_STATE: StageState = {
  variant: "stacked", scenario: "many", theme: "light", wallpaper: "clouds", locale: "ko-KR", motion: "full",
};

export const STAGE_MESSAGE = "butler-task-graph-proposal";
export const SCENARIOS: Scenario[] = ["empty", "one", "chain", "fanout", "failed", "cancelled", "long", "two", "many"];

export const WALLPAPERS: Record<StageWallpaper, WallpaperSource> = {
  clouds: { kind: "live", module: "butler.photo-clouds" },
  daisies: { kind: "live", module: "butler.photo-daisies" },
  bloom: { kind: "live", module: "butler.bloom" },
  none: { kind: "none" },
};

export const STAGE_SIZE: Record<StageWidth, { width: number; height: number }> = {
  desktop: { width: 1280, height: 820 },
  "768": { width: 768, height: 900 },
  "375": { width: 375, height: 812 },
};

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function stateFromQuery(params: URLSearchParams): StageState {
  return {
    variant: pick(params.get("variant"), ["stacked", "picker", "combined"], DEFAULT_STATE.variant),
    scenario: pick(params.get("scenario"), SCENARIOS, DEFAULT_STATE.scenario),
    theme: pick(params.get("theme"), ["light", "dark"], DEFAULT_STATE.theme),
    wallpaper: pick(params.get("wallpaper"), ["clouds", "daisies", "bloom", "none"], DEFAULT_STATE.wallpaper),
    locale: pick(params.get("locale"), ["en-US", "ko-KR"], DEFAULT_STATE.locale),
    motion: pick(params.get("motion"), ["full", "reduced"], DEFAULT_STATE.motion),
  };
}

export function stateToQuery(state: StageState): URLSearchParams {
  return new URLSearchParams(Object.entries(state));
}
