// What the engine reports about modules, and what the app knows about user modules.
import type { WallpaperLabel } from "./types";

/**
 * `image-load`: loading or decoding failed (default module shown); `filter-unsupported`: the filter takes no image (plain image shown);
 * `degraded`: the frame-time watchdog held a still frame; `context-lost`: the WebGL context was lost while the module drew.
 */
export type WallpaperErrorReason =
  | "unknown-module"
  | "compile"
  | "link"
  | "unsupported"
  | "image-load"
  | "filter-unsupported"
  | "degraded"
  | "context-lost";

export interface WallpaperError {
  reason: WallpaperErrorReason;
  /** The module that failed (the requested id for `unknown-module`). */
  module: string;
  /** The image asset, for `image-load`. */
  asset?: string;
  message: string;
}

/**
 * A user-authored module as pickers list it: usable ones are also in the
 * registry; `error` (e.g. a compile log or manifest errors) marks one that
 * cannot be used.
 */
export interface WallpaperUserModule {
  id: string;
  /** Absent when the manifest has no valid name (the id shows instead). */
  name?: WallpaperLabel;
  error?: string;
}
