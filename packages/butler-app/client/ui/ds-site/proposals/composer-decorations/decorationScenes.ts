import { BUILTIN_WALLPAPERS, createWallpaperRegistry, defineWallpaperModule, type WallpaperSource } from "@/butler-ds";
import shorelineManifest from "@/butler-ds/blocks/Wallpaper/modules/butler.shoreline/wallpaper.json";
import shorelineFragment from "@/butler-ds/blocks/Wallpaper/modules/butler.shoreline/shader.frag?raw";
import sakuraManifest from "./sakura/wallpaper.json";
import sakuraFragment from "./sakura/shader.frag?raw";

/**
 * Composer background scenes.
 * - Shoreline: the shipped `butler.shoreline` module on the DS Wallpaper engine, imported, with
 *   the proposed day-cloud param mocked below.
 * - Cherry blossom: new art in the shared module format (validated by defineWallpaperModule),
 *   drawn with a transparent background. The Wallpaper engine is opaque today, so the proposal
 *   runs it in CherryCanvas under the same budget and pause policy (see the DS gap in README).
 */
export const CHERRY_BLOSSOM_MODULE = defineWallpaperModule({ manifest: sakuraManifest, fragment: sakuraFragment, stillTime: 37 });

export type DecorationTheme = "none" | "shoreline" | "cherry-blossom";
export const DECORATION_THEMES: readonly DecorationTheme[] = ["none", "shoreline", "cherry-blossom"];

/**
 * Mock of the one DS change the shoreline needs: no cloud shadows in the day grade. The shipped
 * module is imported unchanged and patched here exactly as proposed for
 * blocks/Wallpaper/modules/butler.shoreline:
 * - wallpaper.json: add param `dayClouds` (number 0..1, step 0.05, default 1, label
 *   "Cloud shadows by day" / "낮 구름 그림자");
 * - shader.frag cloudAt() (line 93): `return mix(p_dayClouds, 1.0, Lnight) * smoothstep(...)`
 *   so the day grade scales its cloud shadows by the param and the night grade keeps them.
 * Defaults keep today's look; the composer passes dayClouds: 0.
 */
const DAY_CLOUDS_PARAM = {
  key: "dayClouds", type: "number", label: { en: "Cloud shadows by day", ko: "낮 구름 그림자" },
  default: 1, min: 0, max: 1, step: 0.05,
} as const;
const CLOUD_RETURN = "return smoothstep(0.5, 0.92, vn(cq + vec2(0.0, u_seed * 50.0) + 40.0));";
if (!shorelineFragment.includes(CLOUD_RETURN)) throw new Error("butler.shoreline cloudAt() changed: update the proposal patch");
export const SHORELINE_DAY_MODULE = defineWallpaperModule({
  manifest: { ...shorelineManifest, id: "proposal.shoreline", params: [...shorelineManifest.params, DAY_CLOUDS_PARAM] },
  fragment: shorelineFragment.replace(CLOUD_RETURN, "return mix(p_dayClouds, 1.0, Lnight) * smoothstep(0.5, 0.92, vn(cq + vec2(0.0, u_seed * 50.0) + 40.0));"),
  stillTime: 8,
});
export const SHORELINE_REGISTRY = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), SHORELINE_DAY_MODULE]);

/**
 * The shoreline's mean waterline sits at `base` of the canvas height, with
 * base = 0.48 + (shorePosition - 0.5) * 0.36 (shader.frag:182, no content rect). 0.5556 puts
 * it at the canvas middle, which ShoreParams place on the card.
 */
export const SHORELINE_SOURCE: WallpaperSource = {
  kind: "live", module: SHORELINE_DAY_MODULE.manifest.id,
  params: { shorePosition: 0.5556, foamAmount: 0.75, water: "tropical", dayClouds: 0 },
};

/**
 * Shoreline readability options under review (proposal page switch):
 * a: accept the contrast as it falls; b: waterline moved off the text row, 6px above the
 * bottom edge; c: no shoreline (the theme list loses it); d: a whole-scene exposure grade
 * (no layer, nothing local: the scene itself is lifted in light and lowered in dark).
 */
export const SHORE_OPTIONS = ["a", "b", "c", "d"] as const;
export type ShoreOption = (typeof SHORE_OPTIONS)[number];

/** Page wallpapers to judge the card against (the new chat screen's background). */
export const PAGE_WALLPAPERS = ["none", "butler.bloom", "butler.shoreline", "butler.photo-daisies", "butler.dusk"] as const;
export type PageWallpaper = (typeof PAGE_WALLPAPERS)[number];

export function pageWallpaperSource(id: PageWallpaper): WallpaperSource {
  return id === "none" ? { kind: "none" } : { kind: "live", module: id };
}
