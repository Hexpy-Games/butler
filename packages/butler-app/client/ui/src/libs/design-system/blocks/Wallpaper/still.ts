// Still frames of wallpapers (picker thumbnails): one shared offscreen context, cached by content.
import {
  BUILTIN_WALLPAPERS,
  liveWallpaperScene,
  resolveWallpaperScene,
  wallpaperModuleRevision,
  wallpaperSourceKey,
  type WallpaperRegistry,
  type WallpaperScene,
} from "./registry";
import { drawWallpaperStill } from "./stillGpu";
import type { WallpaperModule, WallpaperSource, WallpaperTone, WallpaperImageLoader, WallpaperContentRect } from "./types";

/** Drawing-buffer px of a still. */
export interface WallpaperStillSize {
  width: number;
  height: number;
  /** Lifecycle stills compose at their own window size instead of picker screen size. */
  compositionWidth?: number;
  pixelRatio?: number;
  contentRect?: WallpaperContentRect;
  dayPhase?: number;
  imageLoader?: WallpaperImageLoader;
}

type LiveSource = Exclude<WallpaperSource, { kind: "none" }>;
/** A module (drawn with its defaults) or a live source (its params). */
export type WallpaperStillTarget = WallpaperModule | LiveSource;

export interface WallpaperStillRenderer {
  /** The still as an encoded PNG; equal requests (by content, tone and size) share one render. */
  render(target: WallpaperStillTarget, size: WallpaperStillSize, tone: WallpaperTone, registry?: WallpaperRegistry): Promise<Blob>;
}

const DEFAULT_LIMIT = 48;

function sourceOf(target: WallpaperStillTarget): LiveSource {
  return "manifest" in target ? { kind: "live", module: target.manifest.id } : target;
}

/**
 * Cache key of a still: the source's content key (a module keys like its bare
 * source), the module's content revision (an edited shader renders again),
 * tone and size. Live sources resolve their module in `registry`.
 */
export function wallpaperStillKey(
  target: WallpaperStillTarget,
  size: WallpaperStillSize,
  tone: WallpaperTone,
  registry: WallpaperRegistry = BUILTIN_WALLPAPERS,
): string {
  const source = sourceOf(target);
  const module = "manifest" in target ? target : registry.get(source.kind === "live" ? source.module : source.filter?.module ?? "butler.image");
  const revision = module ? wallpaperModuleRevision(module) : "-";
  return `${wallpaperSourceKey(source)}|${revision}|${tone}|${size.width}x${size.height}|${size.compositionWidth ?? ""}|${JSON.stringify(size.contentRect)}|${size.dayPhase ?? ""}|${size.pixelRatio ?? ""}`;
}

function sceneOf(target: WallpaperStillTarget, tone: WallpaperTone, registry: WallpaperRegistry): WallpaperScene {
  if (!("manifest" in target)) return resolveWallpaperScene(target, registry, tone)!;
  return liveWallpaperScene(target, { kind: "live", module: target.manifest.id }, tone);
}

/**
 * Stills through `draw`, cached (least recently used first out) by
 * `wallpaperStillKey`; a failed render is dropped so the next request retries.
 */
export function createWallpaperStillRenderer(
  draw: (scene: WallpaperScene, size: WallpaperStillSize) => Promise<Blob>,
  { limit = DEFAULT_LIMIT }: { limit?: number } = {},
): WallpaperStillRenderer {
  const cache = new Map<string, Promise<Blob>>();
  return {
    render(target, size, tone, registry = BUILTIN_WALLPAPERS) {
      const key = wallpaperStillKey(target, size, tone, registry);
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const still = draw(sceneOf(target, tone, registry), size);
      cache.set(key, still);
      still.catch(() => {
        if (cache.get(key) === still) cache.delete(key);
      });
      for (const oldest of cache.keys()) {
        if (cache.size <= limit) break;
        cache.delete(oldest);
      }
      return still;
    },
  };
}

const shared = createWallpaperStillRenderer(drawWallpaperStill);

/**
 * A still frame of a live module (e.g. a picker thumbnail) at `size` for the
 * tone, encoded as PNG: at the module's `stillTime`, on its default image when
 * it has one. Every call shares one offscreen WebGL2 context, and stills are
 * cached by source and module content, tone and size.
 */
export function renderWallpaperStill(
  target: WallpaperStillTarget,
  size: WallpaperStillSize,
  tone: WallpaperTone,
  registry: WallpaperRegistry = BUILTIN_WALLPAPERS,
): Promise<Blob> {
  return shared.render(target, size, tone, registry);
}
