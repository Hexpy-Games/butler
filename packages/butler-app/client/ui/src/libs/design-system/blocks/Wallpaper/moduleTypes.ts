// Types of the optional module features (contract v1 amendments): pixel ratio, image dim, scene tone, default image.

/** `default`: the motion policy's pixel ratio and budget. `device`: the device pixel ratio capped at 2, no pixel budget. */
export type WallpaperPixelRatioMode = "default" | "device";

/**
 * Engine dimming of image scenes. `auto`: the source's `dim`, one step more in
 * the dark theme. `noDarkStep`: the source's `dim` only. `none`: never dimmed
 * (the module owns its tones).
 */
export type WallpaperImageDim = "auto" | "noDarkStep" | "none";

/**
 * The scene's own light/dark: while boolean param `param` is on, `u_dayPhase`
 * inside one of the `[a, b)` ranges of `darkPhases` reads dark, anything else light (the app
 * appearance follows it).
 */
export interface WallpaperSceneToneSpec {
  param: string;
  darkPhases: Array<[number, number]>;
}

/** A module's `defaultImage` file, supplied by whoever loads the module (a bundled URL, the gateway's bytes). */
export interface WallpaperDefaultImage {
  /** Identifies the image's content (a content-hashed URL, the module files' revision): a new key loads it again. */
  key: string;
  /** The encoded image bytes. */
  load: () => Promise<Blob>;
  /** Average relative luminance 0..1 (like an upload's); sets the image's default dim. Unknown: the default for unknown images. */
  luminance?: number;
}
