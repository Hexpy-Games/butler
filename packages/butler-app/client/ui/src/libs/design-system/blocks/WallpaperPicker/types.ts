import type { WallpaperSource } from "../Wallpaper";

/** The picker's value: a wallpaper source, or `inherit` (follow another scope, e.g. a project following the global wallpaper). */
export type WallpaperPickerValue = WallpaperSource | "inherit";

/** An uploaded image the picker offers; its thumbnail loads through the image loader (`thumbnail` variant). */
export interface WallpaperPickerImage {
  id: string;
  /** Average relative luminance 0..1 measured at upload; picking the image sets its default dim from it. */
  luminance?: number;
}

/** The optional first tile: follow another scope's wallpaper. */
export interface WallpaperPickerInherit {
  /** Tile caption, e.g. "Same as Home". */
  label: string;
  /** What inheriting shows right now; the tile previews it. */
  source?: WallpaperSource;
}

/** Visible and accessible copy, localized by the caller (module and param names come from the manifests). */
export interface WallpaperPickerLabels {
  /** Accessible name of the option group. */
  options: string;
  none: string;
  /** Caption of the n-th image tile (1-based), e.g. `Image 2`. */
  image: (index: number) => string;
  addImage: string;
  deleteImage: string;
  fit: string;
  /** `cover`: fill the screen, cropping the overflow. */
  fill: string;
  /** `contain`: the whole image on a neutral field. */
  fitWhole: string;
  dim: string;
  blur: string;
  filter: string;
  noFilter: string;
  /** Marks the user's own modules, e.g. `Mine`. */
  mine: string;
  /** The import-module tile's caption and accessible name, e.g. `Import module`. */
  importModule: string;
  /** Accessible name of a user module's delete button, e.g. `Delete module`. */
  deleteModule: string;
}
