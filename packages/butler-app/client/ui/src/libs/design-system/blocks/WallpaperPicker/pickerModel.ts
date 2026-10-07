// What the wallpaper picker offers and what each tile selects: pure, no rendering.
import {
  wallpaperImageDefaultDim,
  type WallpaperLabel,
  type WallpaperModule,
  type WallpaperParamInput,
  type WallpaperRegistry,
  type WallpaperSource,
  type WallpaperUserModule,
} from "../Wallpaper";
import type { WallpaperPickerImage, WallpaperPickerInherit, WallpaperPickerValue } from "./types";

export type WallpaperImageSource = Extract<WallpaperSource, { kind: "image" }>;
export type WallpaperLiveSource = Extract<WallpaperSource, { kind: "live" }>;

export type WallpaperPickerOption =
  | { key: "inherit"; kind: "inherit"; inherit: WallpaperPickerInherit }
  | { key: "none"; kind: "none" }
  /** `mine`: a user-authored module. */
  | { key: string; kind: "live"; module: WallpaperModule; mine: boolean }
  /** A user module that cannot be used; `reason` is its error. */
  | { key: string; kind: "unavailable"; id: string; name?: WallpaperLabel; reason: string; mine: true }
  | { key: string; kind: "image"; image: WallpaperPickerImage; index: number };

/** The tile a value selects: `inherit`, `none`, `live:<module>` or `image:<asset>`. */
export function wallpaperPickerKey(value: WallpaperPickerValue): string {
  if (value === "inherit") return "inherit";
  if (value.kind === "none") return "none";
  return value.kind === "live" ? `live:${value.module}` : `image:${value.asset}`;
}

/** A living photo: a module that needs an image and brings its own (`image: required` + `defaultImage`), made for that photo. */
const livingPhoto = (module: WallpaperModule) => module.manifest.image === "required" && module.defaultImage !== undefined;

/** Decorations (`decoration: true`) belong to a component surface, never the app wallpaper: pickers leave them out. */
const pickable = (module: WallpaperModule) => module.manifest.decoration !== true;

/**
 * Registered modules that take an image (`image: optional | required`): the
 * image filters. Living photos are left out; they only draw their own photo.
 */
export function wallpaperImageFilters(registry: WallpaperRegistry): WallpaperModule[] {
  return registry.list().filter((module) => pickable(module) && module.manifest.image !== "none" && !livingPhoto(module));
}

interface OptionsInput {
  registry: WallpaperRegistry;
  images: readonly WallpaperPickerImage[];
  inherit?: WallpaperPickerInherit;
  value: WallpaperPickerValue;
  userModules?: readonly WallpaperUserModule[];
}

/** Modules that can be a live source: they need no image, or bring a default one. */
const drawsAlone = (module: WallpaperModule) => pickable(module) && (module.manifest.image !== "required" || module.defaultImage !== undefined);
const liveOption = (module: WallpaperModule, mine: boolean): WallpaperPickerOption => ({ key: `live:${module.manifest.id}`, kind: "live", module, mine });

/** Registered modules first, then the user's in their order: usable ones live, failing ones unavailable. */
function moduleOptions(registry: WallpaperRegistry, userModules: readonly WallpaperUserModule[]): WallpaperPickerOption[] {
  const user = new Set(userModules.map((entry) => entry.id));
  const others = registry.list().filter((module) => drawsAlone(module) && !user.has(module.manifest.id)).map((module) => liveOption(module, false));
  const mine = userModules.flatMap((entry): WallpaperPickerOption[] => {
    if (entry.error !== undefined) {
      return [{ key: `live:${entry.id}`, kind: "unavailable", id: entry.id, ...(entry.name ? { name: entry.name } : {}), reason: entry.error, mine: true }];
    }
    const module = registry.get(entry.id);
    return module && drawsAlone(module) ? [liveOption(module, true)] : [];
  });
  return [...others, ...mine];
}

/**
 * Tiles in order: inherit (when offered), none, every module that can draw
 * on its own (not `image: required`, unless it has a `defaultImage`) with the user's modules last, then the
 * images, including the selected one while the caller's list catches up (a
 * fresh upload).
 */
export function wallpaperPickerOptions({ registry, images, inherit, value, userModules = [] }: OptionsInput): WallpaperPickerOption[] {
  const listed = [...images];
  if (value !== "inherit" && value.kind === "image" && !listed.some((image) => image.id === value.asset)) listed.push({ id: value.asset });
  return [
    ...(inherit ? [{ key: "inherit" as const, kind: "inherit" as const, inherit }] : []),
    { key: "none", kind: "none" },
    ...moduleOptions(registry, userModules),
    ...listed.map((image, index) => ({ key: `image:${image.id}`, kind: "image" as const, image, index: index + 1 })),
  ];
}

/** Longest tooltip line for a module that cannot be used. */
const MAX_REASON_CHARS = 120;

/** The first non-empty line of an unavailable module's error, cut to tooltip length. */
export function wallpaperPickerReason(reason: string): string {
  const line = reason.split(/\r?\n/u).map((text) => text.trim()).find(Boolean) ?? "";
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line;
}

/** What a tile selects the first time: a module with its defaults; an image filling the screen, dimmed for its luminance. */
export function wallpaperPickerDefault(option: WallpaperPickerOption): WallpaperPickerValue {
  switch (option.kind) {
    case "inherit":
      return "inherit";
    case "none":
      return { kind: "none" };
    case "live":
      return { kind: "live", module: option.module.manifest.id };
    case "unavailable":
      return { kind: "live", module: option.id };
    case "image":
      return { kind: "image", asset: option.image.id, fit: "cover", dim: wallpaperImageDefaultDim(option.image.luminance ?? Number.NaN), blur: 0 };
  }
}

/** Only the buckets that hold values (a stored source never carries empty keys). */
export function wallpaperParamBuckets({ params, paramsDark }: WallpaperParamInput): WallpaperParamInput {
  return { ...(params ? { params } : {}), ...(paramsDark ? { paramsDark } : {}) };
}

/** Sets or drops an image's filter; re-choosing the current filter keeps its params. */
export function withWallpaperImageFilter(source: WallpaperImageSource, module: string | null): WallpaperImageSource {
  if (source.filter?.module === module) return source;
  const { filter: _previous, ...image } = source;
  return module ? { ...image, filter: { module } } : image;
}
