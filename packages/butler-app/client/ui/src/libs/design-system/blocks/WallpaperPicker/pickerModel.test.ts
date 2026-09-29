/// <reference types="bun" />
import { expect, test } from "bun:test";
import { BUILTIN_WALLPAPERS, GRAIN_WALLPAPER, STIPPLE_WALLPAPER, createWallpaperRegistry, defineWallpaperModule } from "../Wallpaper";
import {
  wallpaperImageFilters,
  wallpaperPickerDefault,
  wallpaperPickerKey,
  wallpaperPickerOptions,
  withWallpaperImageFilter,
} from "./pickerModel";

const LENS = defineWallpaperModule({
  manifest: { id: "me.lens", name: { en: "Lens", ko: "렌즈" }, version: "0.1.0", engine: 1, motion: "static", image: "optional", params: [] },
  fragment: "void main(){fragColor=vec4(u_hasImage);}",
});
const REGISTRY = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), LENS]);
/** Built-in live tiles: modules that draw alone, living photos (on their own photo) and stipple (on its sample) included. */
const BUILTIN_LIVE = [
  "live:butler.bloom", "live:butler.silk", "live:butler.riso-flow", "live:butler.lamina", "live:butler.diatom", "live:butler.dusk",
  "live:butler.shoreline", "live:butler.photo-clouds", "live:butler.photo-daisies", "live:butler.stipple",
];

test("keys name the tile a value selects", () => {
  expect(wallpaperPickerKey("inherit")).toBe("inherit");
  expect(wallpaperPickerKey({ kind: "none" })).toBe("none");
  expect(wallpaperPickerKey({ kind: "live", module: "butler.silk", params: { base: "#000000" } })).toBe("live:butler.silk");
  expect(wallpaperPickerKey({ kind: "image", asset: "wp_1", fit: "cover", dim: 0.2, blur: 0 })).toBe("image:wp_1");
});

test("tiles: inherit (when offered), none, live modules without filters, then images", () => {
  const options = wallpaperPickerOptions({
    registry: REGISTRY, images: [{ id: "wp_1" }, { id: "wp_2" }], inherit: { label: "Same as Home" }, value: { kind: "none" },
  });
  expect(options.map((option) => option.key)).toEqual([
    "inherit", "none", ...BUILTIN_LIVE, "live:me.lens", "image:wp_1", "image:wp_2",
  ]);
  expect(options.filter((option) => option.kind === "image").map((option) => option.kind === "image" && option.index)).toEqual([1, 2]);
  expect(wallpaperPickerOptions({ registry: BUILTIN_WALLPAPERS, images: [], value: "inherit" }).map((option) => option.key))
    .toEqual(["none", ...BUILTIN_LIVE]);
});

test("the selected image keeps its tile while the image list catches up", () => {
  const value = { kind: "image", asset: "wp_new", fit: "cover", dim: 0.1, blur: 0 } as const;
  const keys = wallpaperPickerOptions({ registry: BUILTIN_WALLPAPERS, images: [{ id: "wp_1" }], value }).map((option) => option.key);
  expect(keys).toEqual(["none", ...BUILTIN_LIVE, "image:wp_1", "image:wp_new"]);
});

test("a tile's default: images fill the screen with a dim from their luminance", () => {
  const [inherit, none, bloom] = wallpaperPickerOptions({ registry: BUILTIN_WALLPAPERS, images: [], inherit: { label: "x" }, value: "inherit" });
  expect(wallpaperPickerDefault(inherit!)).toBe("inherit");
  expect(wallpaperPickerDefault(none!)).toEqual({ kind: "none" });
  expect(wallpaperPickerDefault(bloom!)).toEqual({ kind: "live", module: "butler.bloom" });
  const images = wallpaperPickerOptions({ registry: BUILTIN_WALLPAPERS, images: [{ id: "bright", luminance: 0.9 }, { id: "unknown" }], value: "inherit" })
    .filter((option) => option.kind === "image");
  expect(images.map(wallpaperPickerDefault)).toEqual([
    { kind: "image", asset: "bright", fit: "cover", dim: 0.4, blur: 0 },
    { kind: "image", asset: "unknown", fit: "cover", dim: 0.2, blur: 0 },
  ]);
});

test("filters are the registered modules that take an image, except living photos", () => {
  expect(wallpaperImageFilters(BUILTIN_WALLPAPERS)).toEqual([STIPPLE_WALLPAPER, GRAIN_WALLPAPER]);
  expect(wallpaperImageFilters(REGISTRY).map((module) => module.manifest.id)).toEqual(["butler.stipple", "butler.grain", "me.lens"]);
});

test("choosing a filter keeps that filter's params; none drops it", () => {
  const image = { kind: "image", asset: "wp_1", fit: "contain", dim: 0.3, blur: 0.1 } as const;
  const grain = withWallpaperImageFilter(image, "butler.grain");
  expect(grain).toEqual({ ...image, filter: { module: "butler.grain" } });
  const tuned = { ...image, filter: { module: "butler.grain", params: { amount: 0.8 } } };
  expect(withWallpaperImageFilter(tuned, "butler.grain")).toBe(tuned);
  expect(withWallpaperImageFilter(tuned, "me.lens")).toEqual({ ...image, filter: { module: "me.lens" } });
  expect(withWallpaperImageFilter(tuned, null)).toEqual(image);
});

test("user modules come after the others in their own order; failing ones are unavailable tiles; user filters stay out", () => {
  const flow = defineWallpaperModule({
    manifest: { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
    fragment: "void main(){fragColor=vec4(1.);}",
  });
  const tint = defineWallpaperModule({
    manifest: { id: "me.tint", name: { en: "Tint", ko: "틴트" }, version: "0.1.0", engine: 1, motion: "static", image: "required", params: [] },
    fragment: "void main(){fragColor=vec4(u_hasImage);}",
  });
  const registry = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), flow, tint, LENS]);
  const userModules = [
    { id: "me.broken", name: { en: "Broken", ko: "깨짐" }, error: "ERROR: 0:1: x" },
    { id: "me.tint", name: tint.manifest.name },
    { id: "me.flow", name: flow.manifest.name },
    // Neither usable nor failing (the registry has not caught up): no tile.
    { id: "me.pending", name: { en: "Pending", ko: "대기" } },
  ];
  const options = wallpaperPickerOptions({ registry, images: [{ id: "wp_1" }], value: { kind: "none" }, userModules });
  expect(options.map((option) => [option.key, option.kind, "mine" in option ? option.mine : undefined])).toEqual([
    ["none", "none", undefined],
    ...BUILTIN_LIVE.map((key) => [key, "live", false]),
    ["live:me.lens", "live", false],
    ["live:me.broken", "unavailable", true],
    ["live:me.flow", "live", true],
    ["image:wp_1", "image", undefined],
  ]);
  const broken = options.find((option) => option.kind === "unavailable");
  expect(broken).toMatchObject({ id: "me.broken", name: { en: "Broken", ko: "깨짐" }, reason: "ERROR: 0:1: x" });
});
