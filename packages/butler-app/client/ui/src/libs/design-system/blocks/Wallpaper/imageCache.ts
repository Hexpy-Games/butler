import type { WallpaperDefaultImage, WallpaperImageLoader, WallpaperImageVariant } from "./types";

export interface WallpaperImageCache {
  /** The asset's bytes; repeated and concurrent requests share one loader call. Failures are not kept. */
  blob(asset: string, variant: WallpaperImageVariant): Promise<Blob>;
  /** Forgets every asset not listed (no scene uses it now). */
  retain(assets: ReadonlySet<string>): void;
}

const DEFAULT_IMAGE = "default-image:";
/** Loaders of the module default images scenes use, by asset id. */
const defaultImages = new Map<string, () => Promise<Blob>>();

/** The asset id of a module's default image; its bytes come from the module (`load`), not from the app's loader. */
export function wallpaperDefaultImageAsset(moduleId: string, image: WallpaperDefaultImage): string {
  const asset = `${DEFAULT_IMAGE}${moduleId}\n${image.key}`;
  defaultImages.set(asset, image.load);
  return asset;
}

/** A default image bundled with the app (a same-origin URL, content-hashed by the build). */
export function bundledWallpaperImage(url: string, luminance?: number): WallpaperDefaultImage {
  const load = async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Wallpaper image: HTTP ${response.status}`);
    return response.blob();
  };
  return { key: url, load, ...(luminance === undefined ? {} : { luminance }) };
}

/** Module default images load through their module; anything else goes to the loader now, a synchronous throw becoming a rejection. */
export function loadWallpaperImageBytes(loader: WallpaperImageLoader, asset: string, variant: WallpaperImageVariant): Promise<Blob> {
  const load = asset.startsWith(DEFAULT_IMAGE) ? defaultImages.get(asset) : () => loader(asset, variant);
  try {
    return load ? Promise.resolve(load()) : Promise.reject(new Error("Unknown wallpaper image"));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Encoded image bytes by asset and variant. Bytes (not decoded bitmaps) are
 * kept for the assets in use, so a restored WebGL context re-uploads without
 * another fetch while the decoded pixels live only on the GPU.
 */
export function createWallpaperImageCache(loader: WallpaperImageLoader): WallpaperImageCache {
  const entries = new Map<string, { asset: string; blob: Promise<Blob> }>();
  return {
    blob(asset, variant) {
      const key = `${variant}\n${asset}`;
      const cached = entries.get(key);
      if (cached) return cached.blob;
      const blob = loadWallpaperImageBytes(loader, asset, variant);
      entries.set(key, { asset, blob });
      blob.catch(() => {
        if (entries.get(key)?.blob === blob) entries.delete(key);
      });
      return blob;
    },
    retain(assets) {
      for (const [key, entry] of entries) if (!assets.has(entry.asset)) entries.delete(key);
    },
  };
}

/**
 * Decodes image bytes for upload: rows flipped so row 0 is the bottom, like
 * `gl_FragCoord` (WebGL ignores its unpack flags for bitmaps), and alpha
 * premultiplied so transparent pixels show the field behind.
 */
export function decodeWallpaperImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "premultiply" });
}
