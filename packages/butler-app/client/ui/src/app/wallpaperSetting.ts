// Relative (not `@/butler-ds`): the root typecheck reaches this file without the UI path aliases.
import type {
  WallpaperParams,
  WallpaperSetting,
  WallpaperSource,
} from "../libs/design-system/blocks/Wallpaper/types.ts";
import type { SettingsView } from "./types.ts";

export type LegacyMainScreenTheme = Pick<
  SettingsView,
  "main_screen_theme" | "main_screen_theme_preset" | "main_screen_theme_custom_colors"
>;

type UnknownRecord = Record<string, unknown>;

const BLOOM_PRESETS = new Set(["monochrome", "aurora", "bloom", "lavender", "morning"]);
const HEX = /^#[0-9a-f]{6}$/iu;
const BLOOM_COLOR_COUNT = 6;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function customColors(colors: readonly unknown[] | null | undefined): string[] | null {
  const valid = colors?.length === BLOOM_COLOR_COUNT && colors.every((color) => typeof color === "string" && HEX.test(color.trim()));
  return valid ? colors.map((color) => (color as string).trim().toLowerCase()) : null;
}

/** The source the legacy `main_screen_theme*` keys describe (plan migration rule, as the gateway derives it). */
export function legacyWallpaperSource(settings: LegacyMainScreenTheme): WallpaperSource {
  if (settings.main_screen_theme === "none") return { kind: "none" };
  if (settings.main_screen_theme === "silk") return { kind: "live", module: "butler.silk" };
  const preset = settings.main_screen_theme_preset;
  if (BLOOM_PRESETS.has(preset)) return { kind: "live", module: "butler.bloom", params: { colors: preset } };
  const colors = preset === "custom" ? customColors(settings.main_screen_theme_custom_colors) : null;
  return colors ? { kind: "live", module: "butler.bloom", params: { colors } } : { kind: "live", module: "butler.bloom" };
}

/** The legacy keys as a wallpaper setting, with the default motion preferences. */
export function legacyWallpaperSetting(settings: LegacyMainScreenTheme): WallpaperSetting {
  return { source: legacyWallpaperSource(settings), motion: "auto", pauseOnBattery: false };
}

function optionalParams(value: unknown): WallpaperParams | undefined | null {
  if (value === undefined) return undefined;
  return isRecord(value) ? (value as WallpaperParams) : null;
}

type WithParams<T> = T & { params?: WallpaperParams; paramsDark?: WallpaperParams };

function withParams<T extends object>(base: T, params: unknown, paramsDark: unknown): WithParams<T> | null {
  const light = optionalParams(params);
  const dark = optionalParams(paramsDark);
  if (light === null || dark === null) return null;
  return { ...base, ...(light ? { params: light } : {}), ...(dark ? { paramsDark: dark } : {}) };
}

/** A stored wallpaper source, or null when it is malformed. */
export function parseWallpaperSource(value: unknown): WallpaperSource | null {
  if (!isRecord(value)) return null;
  if (value.kind === "none") return { kind: "none" };
  if (value.kind === "live") {
    if (typeof value.module !== "string" || !value.module) return null;
    return withParams({ kind: "live" as const, module: value.module }, value.params, value.paramsDark);
  }
  if (value.kind !== "image") return null;
  const { asset, dim, blur, filter } = value;
  const fit = value.fit === "cover" || value.fit === "contain" ? (value.fit as "cover" | "contain") : null;
  if (typeof asset !== "string" || !fit) return null;
  if (typeof dim !== "number" || typeof blur !== "number") return null;
  const image = { kind: "image" as const, asset, fit, dim, blur };
  if (filter === undefined) return image;
  if (!isRecord(filter) || typeof filter.module !== "string") return null;
  const parsedFilter = withParams({ module: filter.module }, filter.params, filter.paramsDark);
  return parsedFilter ? { ...image, filter: parsedFilter } : null;
}

/**
 * A stored `wallpaper` setting, or null when it is missing or its source is
 * malformed (callers then fall back to the legacy keys). Missing motion
 * preferences take their defaults.
 */
export function parseWallpaperSetting(value: unknown): WallpaperSetting | null {
  if (!isRecord(value)) return null;
  const source = parseWallpaperSource(value.source);
  if (!source) return null;
  return {
    source,
    motion: value.motion === "paused" ? "paused" : "auto",
    pauseOnBattery: value.pauseOnBattery === true,
  };
}
