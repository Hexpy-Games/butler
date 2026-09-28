import { wallpaperDefaultImageAsset } from "./imageCache";
import { WALLPAPER_DIM_SKIP, wallpaperImageDefaultDim, wallpaperImageUnit } from "./imageMath";
import { BLOOM_WALLPAPER, BUILTIN_WALLPAPER_MODULES, WALLPAPER_IMAGE_MODULE } from "./modules";
import { wallpaperTransitionKey } from "./keys";
import { resolveWallpaperValues } from "./values";

export { wallpaperModuleRevision, wallpaperSourceKey, wallpaperTransitionKey } from "./keys";
import type {
  ResolvedWallpaperValues,
  WallpaperError,
  WallpaperImageFit,
  WallpaperModule,
  WallpaperSource,
  WallpaperTone,
} from "./types";

export interface WallpaperRegistry {
  get(id: string): WallpaperModule | undefined;
  list(): readonly WallpaperModule[];
}

/** A lookup of validated modules. The first module with an id wins, so later (user) modules cannot shadow built-ins. */
export function createWallpaperRegistry(modules: readonly WallpaperModule[]): WallpaperRegistry {
  const byId = new Map<string, WallpaperModule>();
  for (const module of modules) if (!byId.has(module.manifest.id)) byId.set(module.manifest.id, module);
  const list = [...byId.values()];
  return { get: (id) => byId.get(id), list: () => list };
}

export const BUILTIN_WALLPAPERS = createWallpaperRegistry(BUILTIN_WALLPAPER_MODULES);
/** Shown for unknown modules and when a module fails to compile. */
export const DEFAULT_WALLPAPER_MODULE_ID = BLOOM_WALLPAPER.manifest.id;

/** Image options with dim and blur clamped to 0..1. */
export interface WallpaperImageScene {
  asset: string;
  fit: WallpaperImageFit;
  dim: number;
  blur: number;
}

/** What the renderer draws: a module, its values for the tone, and the image inputs. */
export interface WallpaperScene {
  /**
   * What it draws (`wallpaperTransitionKey`: kind, module, image asset, filter
   * module): a new key crossfades; params, fit/dim/blur and tone redraw in place.
   */
  key: string;
  /** For image sources: the image module, or the filter module drawn over the pre-fitted image. */
  module: WallpaperModule;
  values: ResolvedWallpaperValues;
  dark: boolean;
  image: WallpaperImageScene | null;
  /** Set when the requested module was replaced by the default. */
  error: WallpaperError | null;
}

export function defaultWallpaperModule(registry: WallpaperRegistry): WallpaperModule {
  return registry.get(DEFAULT_WALLPAPER_MODULE_ID) ?? BLOOM_WALLPAPER;
}

function unknownModule(id: string): WallpaperError {
  return { reason: "unknown-module", module: id, message: `Unknown wallpaper module ${id}` };
}

/** The default module in the tone's defaults: shown for unknown modules and failed images. */
export function fallbackWallpaperScene(dark: boolean, error: WallpaperError | null = null): WallpaperScene {
  const module = defaultWallpaperModule(BUILTIN_WALLPAPERS);
  // Keyed like the default module's own source: identical fallbacks never crossfade.
  const key = wallpaperTransitionKey({ kind: "live", module: module.manifest.id });
  return { key, module, values: resolveWallpaperValues(module.manifest, {}, dark ? "dark" : "light"), dark, image: null, error };
}

export type WallpaperFilterResult = { ok: true; module: WallpaperModule } | { ok: false; error: WallpaperError };

/** An image filter must be a registered module whose manifest takes an image (`optional` or `required`). */
export function resolveWallpaperFilter(id: string, registry: WallpaperRegistry): WallpaperFilterResult {
  const module = registry.get(id);
  if (!module) return { ok: false, error: unknownModule(id) };
  if (module.manifest.image === "none") {
    return { ok: false, error: { reason: "filter-unsupported", module: id, message: `${id} does not take an image` } };
  }
  return { ok: true, module };
}

function resolveImageScene(source: Extract<WallpaperSource, { kind: "image" }>, registry: WallpaperRegistry, tone: WallpaperTone): WallpaperScene {
  const { asset, fit, dim, blur, filter } = source;
  const image: WallpaperImageScene = { asset, fit, dim: wallpaperImageUnit(dim), blur: wallpaperImageUnit(blur) };
  const plain: WallpaperScene = { key: wallpaperTransitionKey(source), module: WALLPAPER_IMAGE_MODULE, values: {}, dark: tone === "dark", image, error: null };
  if (!filter) return plain;
  const result = resolveWallpaperFilter(filter.module, registry);
  if (!result.ok) return { ...plain, error: result.error };
  return { ...plain, module: result.module, values: resolveWallpaperValues(result.module.manifest, filter, tone) };
}

/**
 * The image a live module draws on its own: its bundled `defaultImage`
 * (modules that take an image), filling the canvas, dimmed for its luminance
 * like a fresh upload, except that a dim the renderer would skip is 0 (the
 * living photos, composed with their own veil, get none). Null for modules
 * without one.
 */
export function wallpaperDefaultImageScene(module: WallpaperModule): WallpaperImageScene | null {
  const image = module.defaultImage;
  if (!image || module.manifest.image === "none") return null;
  const dim = wallpaperImageDefaultDim(image.luminance ?? Number.NaN);
  return { asset: wallpaperDefaultImageAsset(module.manifest.id, image), fit: "cover", dim: dim <= WALLPAPER_DIM_SKIP ? 0 : dim, blur: 0 };
}

/** A live source of a registered module: its values for the tone, drawn on its default image when it has one. */
export function liveWallpaperScene(module: WallpaperModule, source: Extract<WallpaperSource, { kind: "live" }>, tone: WallpaperTone): WallpaperScene {
  const values = resolveWallpaperValues(module.manifest, source, tone);
  return { key: wallpaperTransitionKey(source), module, values, dark: tone === "dark", image: wallpaperDefaultImageScene(module), error: null };
}

export function resolveWallpaperScene(
  source: WallpaperSource,
  registry: WallpaperRegistry,
  tone: WallpaperTone,
): WallpaperScene | null {
  const dark = tone === "dark";
  if (source.kind === "none") return null;
  if (source.kind === "image") return resolveImageScene(source, registry, tone);
  const module = registry.get(source.module);
  if (!module) return fallbackWallpaperScene(dark, unknownModule(source.module));
  return liveWallpaperScene(module, source, tone);
}
