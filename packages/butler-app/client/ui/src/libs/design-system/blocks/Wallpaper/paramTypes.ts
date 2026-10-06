// Manifest parameter specs (`params[]` of wallpaper.json).
import type { WallpaperLabel } from "./types";

interface WallpaperParamBase<Value> {
  key: string;
  label: WallpaperLabel;
  default: Value;
  defaultDark?: Value;
  /**
   * Internal: set only by code that knows the module (e.g. a DS preset); param
   * controls and pickers never list it. Omitted: listed.
   */
  hidden?: boolean;
}

/** `shuffle`: the UI offers a shuffle button (a random value on the step grid) instead of a slider, e.g. a composition seed. */
export type WallpaperNumberControl = "shuffle";

export interface WallpaperNumberParam extends WallpaperParamBase<number> {
  type: "number";
  min: number;
  max: number;
  step: number;
  /** Omitted: a slider. */
  control?: WallpaperNumberControl;
}

export interface WallpaperBooleanParam extends WallpaperParamBase<boolean> {
  type: "boolean";
}

export interface WallpaperEnumParam extends WallpaperParamBase<string> {
  type: "enum";
  /** Option values in order; `p_<key>` is the index. */
  options: string[];
  /** Display labels by option value (from `{ value, label }` entries in wallpaper.json); unlabeled options show their value. */
  optionLabels?: Record<string, WallpaperLabel>;
}

export interface WallpaperColorParam extends WallpaperParamBase<string> {
  type: "color";
}

export interface WallpaperPalettePreset {
  light: string[];
  dark: string[];
}

export interface WallpaperPaletteParam extends WallpaperParamBase<string[]> {
  type: "palette";
  size: number;
  presets?: Record<string, WallpaperPalettePreset>;
}

export type WallpaperParamSpec =
  | WallpaperNumberParam
  | WallpaperBooleanParam
  | WallpaperEnumParam
  | WallpaperColorParam
  | WallpaperPaletteParam;

export type WallpaperParamType = WallpaperParamSpec["type"];
