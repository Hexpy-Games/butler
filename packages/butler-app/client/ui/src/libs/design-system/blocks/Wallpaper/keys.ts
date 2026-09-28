// Content keys of sources and modules: equal content, equal key.
import type { WallpaperModule, WallpaperSource } from "./types";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
}

const revisions = new WeakMap<WallpaperModule, string>();

/** FNV-1a (32-bit) of a string, as 8 hex digits. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return (value >>> 0).toString(16).padStart(8, "0");
}

/**
 * Content revision of a module (manifest, shaders and default image): equal
 * modules share it, an edited `wallpaper.json`, `shader.frag` or `overlay.frag` changes it. Stills and
 * change detection (hot reload) key by it.
 */
export function wallpaperModuleRevision(module: WallpaperModule): string {
  let revision = revisions.get(module);
  if (revision === undefined) {
    const passes = module.overlay === undefined ? module.fragment : `${module.fragment}\n${module.overlay}`;
    revision = `${hash(JSON.stringify(stable(module.manifest)))}${hash(passes)}${module.defaultImage ? hash(module.defaultImage.key) : ""}`;
    revisions.set(module, revision);
  }
  return revision;
}

/** Content key of a source: equal sources share a key whatever their identity or key order. */
export function wallpaperSourceKey(source: WallpaperSource): string {
  return JSON.stringify(stable(source));
}

/**
 * Transition key of a source: its kind, module, image asset and filter module.
 * Changing one of them crossfades; params, fit/dim/blur (and the tone) redraw in place.
 */
export function wallpaperTransitionKey(source: WallpaperSource): string {
  if (source.kind === "none") return "none";
  if (source.kind === "live") return JSON.stringify(["live", source.module]);
  return JSON.stringify(["image", source.asset, source.filter?.module ?? null]);
}
