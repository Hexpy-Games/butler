// Wallpaper module contract v1 (engine: 1). PLAN-LIVE-WALLPAPER-UPGRADE, Appendix A.
import type { WallpaperDefaultImage, WallpaperImageDim, WallpaperPixelRatioMode, WallpaperSceneToneSpec } from "./moduleTypes";
import type { WallpaperParamSpec } from "./paramTypes";

/** A stored parameter value: number, boolean, enum option / color / preset name, or a hex list. */
export type WallpaperParamValue = number | boolean | string | string[];
export type WallpaperParams = Record<string, WallpaperParamValue>;

export interface WallpaperImageFilter {
  module: string;
  params?: WallpaperParams;
  paramsDark?: WallpaperParams;
}

/** `cover` fills the canvas and crops; `contain` shows the whole image on a neutral field. */
export type WallpaperImageFit = "cover" | "contain";

export type WallpaperSource =
  | { kind: "none" }
  | { kind: "live"; module: string; params?: WallpaperParams; paramsDark?: WallpaperParams }
  | {
    kind: "image";
    asset: string;
    fit: WallpaperImageFit;
    /** 0..1 darkening (the dark theme adds one step). */
    dim: number;
    /** 0..1 blur, relative to the canvas size. */
    blur: number;
    filter?: WallpaperImageFilter;
  };

/** `paused` is the user's WCAG 2.2.2 pause; `auto` animates unless something else pauses it. */
export type WallpaperMotion = "auto" | "paused";

/** The stored `wallpaper` setting. */
export interface WallpaperSetting {
  source: WallpaperSource;
  motion: WallpaperMotion;
  pauseOnBattery: boolean;
}

export type WallpaperTone = "light" | "dark";
/** `viewport`: fixed full-screen layer. `container`: fills the nearest positioned parent. */
export type WallpaperScope = "viewport" | "container";

export interface WallpaperLabel {
  en: string;
  ko: string;
}

export type WallpaperModuleMotion = "static" | "animated";
export type WallpaperImageInput = "none" | "optional" | "required";


/** `wallpaper.json`. */
export interface WallpaperManifest {
  id: string;
  name: WallpaperLabel;
  version: string;
  engine: 1;
  motion: WallpaperModuleMotion;
  image: WallpaperImageInput;
  /**
   * Seconds after which `u_time` wraps, in (0, 5000*PI]; the module must be
   * seamless there. Omitted: the engine period (5000*PI s).
   */
  timePeriod?: number;
  /**
   * Two-pass module: `shader.frag` (must not read `u_time`) is rendered once
   * into a cached texture per input change; `overlay.frag` runs every frame
   * and reads it as `u_base`.
   */
  overlay?: boolean;
  /** Omitted: `default`. */
  pixelRatio?: WallpaperPixelRatioMode;
  /** Omitted: `auto`. */
  imageDim?: WallpaperImageDim;
  /** A file beside `shader.frag` (e.g. `photo.jpg`) drawn when the module is a live source without an image. */
  defaultImage?: string;
  sceneTone?: WallpaperSceneToneSpec;
  /** At most 8; the first 4 are the primary controls. */
  params: WallpaperParamSpec[];
}

/**
 * The main UI text/content area in CSS px, client (viewport) coordinates —
 * e.g. an element's `getBoundingClientRect()`. Modules read it as
 * `u_contentRect` to compose around the text.
 */
export interface WallpaperContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A validated module: manifest plus the `shader.frag` body (GLSL ES 3.00, no prelude). */
export interface WallpaperModule {
  manifest: WallpaperManifest;
  fragment: string;
  /** The `overlay.frag` body of a two-pass module (`manifest.overlay`). */
  overlay?: string;
  /** The `defaultImage` file; without it the module draws with no image. */
  defaultImage?: WallpaperDefaultImage;
  /** Clock (seconds) of its still frames (picker thumbnails); default 0. */
  stillTime?: number;
}

/** A parameter after light/dark resolution: enum option, `#rrggbb`, or a hex list for palettes. */
export type ResolvedWallpaperValue = number | boolean | string | readonly string[];
export type ResolvedWallpaperValues = Record<string, ResolvedWallpaperValue>;

export type { WallpaperDefaultImage, WallpaperImageDim, WallpaperPixelRatioMode, WallpaperSceneToneSpec } from "./moduleTypes";
export type {
  WallpaperBooleanParam,
  WallpaperColorParam,
  WallpaperEnumParam,
  WallpaperNumberControl,
  WallpaperNumberParam,
  WallpaperPaletteParam,
  WallpaperPalettePreset,
  WallpaperParamSpec,
  WallpaperParamType,
} from "./paramTypes";
export type { WallpaperError, WallpaperErrorReason, WallpaperUserModule } from "./statusTypes";
export type { WallpaperImageLoader, WallpaperImageVariant } from "./imageTypes";
