import type { WallpaperSource } from "@/butler-ds";
import type { ComposerVariant } from "./ProposalComposer";
import type { ProposalLocale } from "./fixture";

export type StageMode = "idle" | "typing" | "streaming";
export type StageWidth = "desktop" | "768" | "375";
export type StageWallpaper = "clouds" | "daisies" | "bloom" | "none";

export interface StageState {
  variant: ComposerVariant;
  mode: StageMode;
  plan: boolean;
  question: boolean;
  attachment: boolean;
  theme: "light" | "dark";
  wallpaper: StageWallpaper;
  locale: ProposalLocale;
}

export const DEFAULT_STATE: StageState = {
  variant: "split", mode: "idle", plan: true, question: false, attachment: false,
  theme: "light", wallpaper: "clouds", locale: "ko-KR",
};

export const STAGE_MESSAGE = "butler-composer-proposal";

export const WALLPAPERS: Record<StageWallpaper, WallpaperSource> = {
  clouds: { kind: "live", module: "butler.photo-clouds" },
  daisies: { kind: "live", module: "butler.photo-daisies" },
  bloom: { kind: "live", module: "butler.bloom" },
  none: { kind: "none" },
};

export const STAGE_SIZE: Record<StageWidth, { width: number; height: number }> = {
  desktop: { width: 1280, height: 760 },
  "768": { width: 768, height: 900 },
  "375": { width: 375, height: 760 },
};

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function stateFromQuery(params: URLSearchParams): StageState {
  const flag = (key: string, fallback: boolean) => (params.has(key) ? params.get(key) === "1" : fallback);
  return {
    variant: pick(params.get("variant"), ["split", "cluster"], DEFAULT_STATE.variant),
    mode: pick(params.get("mode"), ["idle", "typing", "streaming"], DEFAULT_STATE.mode),
    plan: flag("plan", DEFAULT_STATE.plan),
    question: flag("question", DEFAULT_STATE.question),
    attachment: flag("attachment", DEFAULT_STATE.attachment),
    theme: pick(params.get("theme"), ["light", "dark"], DEFAULT_STATE.theme),
    wallpaper: pick(params.get("wallpaper"), ["clouds", "daisies", "bloom", "none"], DEFAULT_STATE.wallpaper),
    locale: pick(params.get("locale"), ["en-US", "ko-KR"], DEFAULT_STATE.locale),
  };
}

export function stateToQuery(state: StageState): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : value);
  }
  return params;
}
