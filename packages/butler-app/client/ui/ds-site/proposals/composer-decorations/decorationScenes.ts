import {
  BUILTIN_WALLPAPERS,
  createWallpaperRegistry,
  defineWallpaperModule,
  type WallpaperSource,
} from "@/butler-ds";
import sakuraManifest from "./sakura/wallpaper.json";
import sakuraFragment from "./sakura/shader.frag?raw";

/**
 * Composer background scenes. Shoreline is the shipped `butler.shoreline` module, imported as is.
 * Cherry blossom is new art in the shared module format (no cherry asset exists in the repo yet),
 * so it runs under the same Wallpaper engine budget: 20fps, DPR 1, paused hidden/offscreen.
 */
export const CHERRY_BLOSSOM_WALLPAPER = defineWallpaperModule({ manifest: sakuraManifest, fragment: sakuraFragment, stillTime: 37 });

export const DECORATION_REGISTRY = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), CHERRY_BLOSSOM_WALLPAPER]);

export type DecorationTheme = "none" | "shoreline" | "cherry-blossom";
export const DECORATION_THEMES: readonly DecorationTheme[] = ["none", "shoreline", "cherry-blossom"];

export const DECORATION_SOURCES: Record<Exclude<DecorationTheme, "none">, WallpaperSource> = {
  // Shore pulled toward the top so open water and surf lace fill the card instead of sand.
  shoreline: { kind: "live", module: "butler.shoreline", params: { shorePosition: 1, foamAmount: 0.75 } },
  "cherry-blossom": { kind: "live", module: CHERRY_BLOSSOM_WALLPAPER.manifest.id },
};

/** Page wallpapers to judge the card against (the new chat screen's background). */
export const PAGE_WALLPAPERS = ["none", "butler.bloom", "butler.shoreline", "butler.photo-daisies", "butler.dusk"] as const;
export type PageWallpaper = (typeof PAGE_WALLPAPERS)[number];

export function pageWallpaperSource(id: PageWallpaper): WallpaperSource {
  return id === "none" ? { kind: "none" } : { kind: "live", module: id };
}
