import { defineWallpaperModule, type WallpaperSource } from "@/butler-ds";
import sakuraManifest from "./sakura/wallpaper.json";
import sakuraFragment from "./sakura/shader.frag?raw";

/**
 * Composer background scenes.
 * - Shoreline: the shipped `butler.shoreline` module on the DS Wallpaper engine, unchanged.
 * - Cherry blossom: new art in the shared module format (validated by defineWallpaperModule),
 *   drawn with a transparent background. The Wallpaper engine is opaque today, so the proposal
 *   runs it in CherryCanvas under the same budget and pause policy (see the DS gap in README).
 */
export const CHERRY_BLOSSOM_MODULE = defineWallpaperModule({ manifest: sakuraManifest, fragment: sakuraFragment, stillTime: 37 });

export type DecorationTheme = "none" | "shoreline" | "cherry-blossom";
export const DECORATION_THEMES: readonly DecorationTheme[] = ["none", "shoreline", "cherry-blossom"];

/**
 * The shoreline's mean waterline sits at `base` of the canvas height, with
 * base = 0.48 + (shorePosition - 0.5) * 0.36 (shader.frag:182, no content rect). 0.5556 puts
 * it at 0.5: the canvas is centred on the card, so the waterline tracks the card's middle.
 */
export const SHORELINE_SOURCE: WallpaperSource = {
  kind: "live", module: "butler.shoreline", params: { shorePosition: 0.5556, foamAmount: 0.75, water: "tropical" },
};

/** Page wallpapers to judge the card against (the new chat screen's background). */
export const PAGE_WALLPAPERS = ["none", "butler.bloom", "butler.shoreline", "butler.photo-daisies", "butler.dusk"] as const;
export type PageWallpaper = (typeof PAGE_WALLPAPERS)[number];

export function pageWallpaperSource(id: PageWallpaper): WallpaperSource {
  return id === "none" ? { kind: "none" } : { kind: "live", module: id };
}
