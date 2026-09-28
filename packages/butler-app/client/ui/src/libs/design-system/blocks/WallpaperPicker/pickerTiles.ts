// What each picker tile shows (caption, thumbnail) and where arrow keys go: pure, no rendering.
import {
  renderWallpaperStill,
  wallpaperLabelText,
  wallpaperStillKey,
  type WallpaperImageLoader,
  type WallpaperLocale,
  type WallpaperRegistry,
  type WallpaperSource,
  type WallpaperTone,
} from "../Wallpaper";
import type { WallpaperPickerOption } from "./pickerModel";
import type { WallpaperPickerLabels, WallpaperPickerValue } from "./types";
import type { WallpaperThumbnailRequest } from "./useWallpaperThumbnail";

/** Drawing-buffer size of module stills (16:10, sharp on a 2x display at tile size). */
const THUMBNAIL_SIZE = { width: 320, height: 200 };

export interface WallpaperPreviewContext {
  tone: WallpaperTone;
  registry: WallpaperRegistry;
  loader: WallpaperImageLoader | undefined;
}

function sourcePreview(source: WallpaperSource, { tone, registry, loader }: WallpaperPreviewContext): WallpaperThumbnailRequest | null {
  if (source.kind === "none") return null;
  if (source.kind === "image") return loader ? { key: `image:${source.asset}`, load: () => loader(source.asset, "thumbnail") } : null;
  // Keyed by the module's content too: an edited user module's still renders again.
  return { key: wallpaperStillKey(source, THUMBNAIL_SIZE, tone, registry), load: () => renderWallpaperStill(source, THUMBNAIL_SIZE, tone, registry) };
}

/**
 * Modules show a still with the params they have (selected, or picked earlier
 * in the session), else their defaults; images their stored thumbnail;
 * modules that cannot be used none.
 */
export function wallpaperOptionPreview(
  option: WallpaperPickerOption,
  current: WallpaperPickerValue | undefined,
  context: WallpaperPreviewContext,
): WallpaperThumbnailRequest | null {
  if (option.kind === "none" || option.kind === "unavailable") return null;
  if (option.kind === "inherit") return option.inherit.source ? sourcePreview(option.inherit.source, context) : null;
  if (option.kind === "image") return sourcePreview({ kind: "image", asset: option.image.id, fit: "cover", dim: 0, blur: 0 }, context);
  const id = option.module.manifest.id;
  const live = current !== undefined && current !== "inherit" && current.kind === "live" && current.module === id ? current : { kind: "live" as const, module: id };
  return sourcePreview(live, context);
}

export function wallpaperOptionCaption(option: WallpaperPickerOption, labels: WallpaperPickerLabels, locale: WallpaperLocale): string {
  if (option.kind === "inherit") return option.inherit.label;
  if (option.kind === "none") return labels.none;
  if (option.kind === "image") return labels.image(option.index);
  if (option.kind === "unavailable") return option.name ? wallpaperLabelText(option.name, locale) : option.id;
  return wallpaperLabelText(option.module.manifest.name, locale);
}

/**
 * What a delete button on this tile would remove: an uploaded image, or a
 * user's own module (usable or not). Null for built-ins and other tiles,
 * which have nothing to delete.
 */
export function wallpaperOptionDeleteId(option: WallpaperPickerOption): string | null {
  if (option.kind === "image") return option.image.id;
  if (option.kind === "live" && option.mine) return option.module.manifest.id;
  if (option.kind === "unavailable") return option.id;
  return null;
}

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Where a key moves the selection: arrows wrap, Home and End jump; tiles that cannot be chosen are skipped. Null: not a move. */
export function wallpaperOptionTarget(options: readonly WallpaperPickerOption[], index: number, key: string): number | null {
  const count = options.length;
  const usable = (at: number) => options[at]?.kind !== "unavailable";
  const walk = (from: number, step: number) => {
    for (let at = from, seen = 0; seen < count; at = (at + step + count) % count, seen += 1) if (usable(at)) return at;
    return null;
  };
  if (key === "Home") return walk(0, 1);
  if (key === "End") return walk(count - 1, -1);
  const step = STEPS[key];
  return step ? walk((index + step + count) % count, step) : null;
}
