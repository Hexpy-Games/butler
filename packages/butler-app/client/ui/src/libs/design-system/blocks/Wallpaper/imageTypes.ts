// The image loading contract between the app and the wallpaper engine.

/** `thumbnail`: the small preview (long edge 480px); `full`: the stored image (long edge ≤ 3840px). */
export type WallpaperImageVariant = "full" | "thumbnail";

/**
 * Loads an image asset's encoded bytes (JPEG/PNG, orientation already
 * applied). The app injects it (e.g. an authenticated fetch); the engine
 * decodes, caches and uploads the result.
 */
export type WallpaperImageLoader = (assetId: string, variant: WallpaperImageVariant) => Promise<Blob>;
