/// <reference types="bun" />
import { expect, test } from "bun:test";
import { BLOOM_WALLPAPER, GRAIN_WALLPAPER, SILK_WALLPAPER, WALLPAPER_IMAGE_MODULE } from "./modules";
import {
  BUILTIN_WALLPAPERS,
  DEFAULT_WALLPAPER_MODULE_ID,
  createWallpaperRegistry,
  fallbackWallpaperScene,
  resolveWallpaperFilter,
  resolveWallpaperScene,
  wallpaperModuleRevision,
  wallpaperSourceKey,
  wallpaperTransitionKey,
} from "./registry";
import { defineWallpaperModule } from "./manifest";

const MONOCHROME = ["#32424d", "#555d7c", "#485c70", "#6a7d9a", "#53708d", "#434d70"];

test("the built-in registry holds bloom, silk, the analog collection and the grain filter; bloom is the default", () => {
  expect(BUILTIN_WALLPAPERS.list().map((module) => module.manifest.id)).toEqual([
    "butler.bloom", "butler.silk", "butler.riso-flow", "butler.lamina", "butler.diatom", "butler.dusk", "butler.shoreline",
    "butler.photo-clouds", "butler.photo-daisies", "butler.stipple", "butler.grain",
  ]);
  expect(DEFAULT_WALLPAPER_MODULE_ID).toBe("butler.bloom");
  expect(BUILTIN_WALLPAPERS.get("butler.silk")).toBe(SILK_WALLPAPER);
  expect(BUILTIN_WALLPAPERS.get("butler.nope")).toBeUndefined();
});

test("bloom keeps the legacy palettes as light/dark presets of a 6-color palette", () => {
  const colors = BLOOM_WALLPAPER.manifest.params.find((param) => param.key === "colors");
  expect(BLOOM_WALLPAPER.manifest.motion).toBe("animated");
  expect(colors?.type).toBe("palette");
  if (colors?.type !== "palette") return;
  expect(colors.size).toBe(6);
  expect(colors.default).toEqual(MONOCHROME);
  expect(Object.keys(colors.presets ?? {})).toEqual(["monochrome", "aurora", "bloom", "lavender", "morning"]);
  expect(colors.presets?.monochrome).toEqual({ light: MONOCHROME, dark: MONOCHROME });
  expect(colors.presets?.aurora?.light).toEqual(["#8b5cf6", "#6366f1", "#38bdf8", "#2dd4bf", "#f472b6", "#fbbf24"]);
  expect(colors.presets?.bloom?.light).toEqual(["#d946ef", "#f472b6", "#fb923c", "#facc15", "#34d399", "#818cf8"]);
  expect(colors.presets?.lavender?.light).toEqual(["#8b5cf6", "#6366f1", "#a78bfa", "#818cf8", "#c4b5fd", "#93c5fd"]);
  expect(colors.presets?.morning?.light).toEqual(["#7dd3fc", "#60a5fa", "#a5b4fc", "#fbcfe8", "#fed7aa", "#bbf7d0"]);
  for (const preset of Object.values(colors.presets ?? {})) expect(preset.dark).toEqual(preset.light);
});

test("silk's base color matches the system background in each tone", () => {
  expect(SILK_WALLPAPER.manifest.params).toEqual([
    expect.objectContaining({ key: "base", type: "color", default: "#ffffff", defaultDark: "#1a1b1e" }),
  ]);
  expect(SILK_WALLPAPER.manifest.motion).toBe("animated");
});

test("scenes resolve per source kind", () => {
  expect(resolveWallpaperScene({ kind: "none" }, BUILTIN_WALLPAPERS, "light")).toBeNull();
  const silk = resolveWallpaperScene({ kind: "live", module: "butler.silk" }, BUILTIN_WALLPAPERS, "dark");
  expect(silk).toEqual({
    key: wallpaperTransitionKey({ kind: "live", module: "butler.silk" }), module: SILK_WALLPAPER, values: { base: "#1a1b1e" }, dark: true, image: null, error: null,
  });
  const aurora = resolveWallpaperScene({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } }, BUILTIN_WALLPAPERS, "light");
  expect(aurora?.values.colors).toEqual(["#8b5cf6", "#6366f1", "#38bdf8", "#2dd4bf", "#f472b6", "#fbbf24"]);
});

test("an unknown module falls back to the default module and reports it", () => {
  const scene = resolveWallpaperScene({ kind: "live", module: "me.gone", params: { colors: "aurora" } }, BUILTIN_WALLPAPERS, "light");
  expect(scene?.module).toBe(BLOOM_WALLPAPER);
  expect(scene?.values.colors).toEqual(MONOCHROME);
  expect(scene?.error).toEqual({ reason: "unknown-module", module: "me.gone", message: "Unknown wallpaper module me.gone" });
});

const label = { en: "x", ko: "x" };
const DUOTONE = defineWallpaperModule({
  manifest: {
    id: "me.duotone", name: { en: "Duotone", ko: "듀오톤" }, version: "0.1.0", engine: 1, motion: "static", image: "required",
    params: [{ key: "ink", label, type: "color", default: "#223344", defaultDark: "#aabbcc" }],
  },
  fragment: "void main(){fragColor=vec4(p_ink*texture(u_image,gl_FragCoord.xy/u_resolution).r,1.);}",
});
const RAIN = defineWallpaperModule({
  manifest: { id: "me.rain", name: { en: "Rain", ko: "비" }, version: "0.1.0", engine: 1, motion: "animated", image: "none", params: [] },
  fragment: "void main(){fragColor=vec4(u_time);}",
});
const FILTERS = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), DUOTONE, RAIN]);

test("image sources draw the built-in image module with clamped options", () => {
  expect(WALLPAPER_IMAGE_MODULE.manifest).toMatchObject({ id: "butler.image", motion: "static", image: "required" });
  expect(BUILTIN_WALLPAPERS.get("butler.image")).toBeUndefined();
  const source = { kind: "image", asset: "a1", fit: "contain", dim: 0.2, blur: 7 } as const;
  const scene = resolveWallpaperScene(source, BUILTIN_WALLPAPERS, "dark");
  expect(scene).toEqual({
    key: wallpaperTransitionKey(source), module: WALLPAPER_IMAGE_MODULE, values: {}, dark: true, image: { asset: "a1", fit: "contain", dim: 0.2, blur: 1 }, error: null,
  });
});

test("filters: only registered modules that take an image are eligible", () => {
  expect(resolveWallpaperFilter("me.duotone", FILTERS)).toEqual({ ok: true, module: DUOTONE });
  expect(resolveWallpaperFilter("me.rain", FILTERS)).toEqual({
    ok: false, error: { reason: "filter-unsupported", module: "me.rain", message: "me.rain does not take an image" },
  });
  expect(resolveWallpaperFilter("me.gone", FILTERS)).toEqual({
    ok: false, error: { reason: "unknown-module", module: "me.gone", message: "Unknown wallpaper module me.gone" },
  });
  expect(resolveWallpaperFilter("me.duotone", BUILTIN_WALLPAPERS).ok).toBe(false);
});

test("an eligible filter draws with its own values and the image options", () => {
  const source = { kind: "image", asset: "a1", fit: "cover", dim: 0.3, blur: 0.1, filter: { module: "me.duotone" } } as const;
  const scene = resolveWallpaperScene(source, FILTERS, "dark");
  expect(scene).toEqual({
    key: wallpaperTransitionKey(source), module: DUOTONE, values: { ink: "#aabbcc" }, dark: true, image: { asset: "a1", fit: "cover", dim: 0.3, blur: 0.1 }, error: null,
  });
});

test("an ineligible or unknown filter falls back to the plain image and reports it", () => {
  const rain = resolveWallpaperScene({ kind: "image", asset: "a1", fit: "cover", dim: 0, blur: 0, filter: { module: "me.rain" } }, FILTERS, "light");
  expect(rain?.module).toBe(WALLPAPER_IMAGE_MODULE);
  expect(rain?.image?.asset).toBe("a1");
  expect(rain?.error?.reason).toBe("filter-unsupported");
  const gone = resolveWallpaperScene({ kind: "image", asset: "a1", fit: "cover", dim: 0, blur: 0, filter: { module: "me.gone" } }, FILTERS, "light");
  expect(gone?.module).toBe(WALLPAPER_IMAGE_MODULE);
  expect(gone?.error?.reason).toBe("unknown-module");
});

test("the fallback scene is the default module in the tone's defaults", () => {
  expect(fallbackWallpaperScene(true)).toEqual({
    key: wallpaperTransitionKey({ kind: "live", module: "butler.bloom" }), module: BLOOM_WALLPAPER, values: { colors: MONOCHROME }, dark: true, image: null, error: null,
  });
});

test("a registry takes every validated module; built-ins cannot be shadowed", () => {
  const rain = RAIN;
  const fake = { ...rain, manifest: { ...rain.manifest, id: "butler.bloom" } };
  const registry = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), rain, fake]);
  expect(registry.get("me.rain")).toBe(rain);
  expect(registry.get("butler.bloom")).toBe(BLOOM_WALLPAPER);
  expect(resolveWallpaperScene({ kind: "live", module: "me.rain" }, registry, "light")?.module).toBe(rain);
});

test("source keys ignore object identity and key order", () => {
  const a = wallpaperSourceKey({ kind: "live", module: "butler.bloom", params: { colors: ["#000000", "#ffffff"], speed: 1 } });
  const b = wallpaperSourceKey({ params: { speed: 1, colors: ["#000000", "#ffffff"] }, module: "butler.bloom", kind: "live" });
  expect(a).toBe(b);
  expect(wallpaperSourceKey({ kind: "live", module: "butler.silk" })).not.toBe(a);
});

test("a scene is keyed by what it draws (kind, module, image, filter), not its params, image options or tone", () => {
  const aurora = { kind: "live", module: "butler.bloom", params: { colors: "aurora" } } as const;
  const light = resolveWallpaperScene(aurora, BUILTIN_WALLPAPERS, "light");
  const dark = resolveWallpaperScene(aurora, BUILTIN_WALLPAPERS, "dark");
  expect(light?.key).toBe(wallpaperTransitionKey(aurora));
  expect(dark?.key).toBe(light?.key);
  expect(resolveWallpaperScene({ ...aurora, params: { colors: "morning" }, paramsDark: { colors: "bloom" } }, BUILTIN_WALLPAPERS, "light")?.key).toBe(light?.key);
  expect(resolveWallpaperScene({ kind: "live", module: "butler.silk" }, BUILTIN_WALLPAPERS, "light")?.key).not.toBe(light?.key);
  const image = { kind: "image", asset: "a1", fit: "cover", dim: 0, blur: 0 } as const;
  const imageKey = resolveWallpaperScene(image, FILTERS, "light")?.key;
  expect(resolveWallpaperScene({ ...image, fit: "contain", dim: 0.5, blur: 0.4 }, FILTERS, "light")?.key).toBe(imageKey);
  expect(resolveWallpaperScene({ ...image, asset: "a2" }, FILTERS, "light")?.key).not.toBe(imageKey);
  const filtered = resolveWallpaperScene({ ...image, filter: { module: "me.duotone", params: { ink: "#000000" } } }, FILTERS, "light")?.key;
  expect(filtered).not.toBe(imageKey);
  expect(resolveWallpaperScene({ ...image, filter: { module: "me.duotone", params: { ink: "#ffffff" } } }, FILTERS, "light")?.key).toBe(filtered);
  // A live module and the same module as an image filter are different kinds.
  expect(wallpaperTransitionKey({ kind: "live", module: "me.duotone" })).not.toBe(filtered);
  const unknown = resolveWallpaperScene({ kind: "live", module: "me.gone" }, BUILTIN_WALLPAPERS, "light");
  expect(unknown?.key).toBe(fallbackWallpaperScene(false).key);
  expect(unknown?.key).toBe(resolveWallpaperScene({ kind: "live", module: "butler.bloom" }, BUILTIN_WALLPAPERS, "dark")?.key);
});

test("grain is a static image filter; the built-ins now offer an eligible filter", () => {
  expect(GRAIN_WALLPAPER.manifest).toMatchObject({ id: "butler.grain", motion: "static", image: "required" });
  expect(GRAIN_WALLPAPER.manifest.params.map((param) => [param.key, param.type])).toEqual([["amount", "number"], ["mono", "boolean"]]);
  expect(resolveWallpaperFilter("butler.grain", BUILTIN_WALLPAPERS)).toEqual({ ok: true, module: GRAIN_WALLPAPER });
  const scene = resolveWallpaperScene(
    { kind: "image", asset: "a1", fit: "cover", dim: 0, blur: 0, filter: { module: "butler.grain", params: { mono: true } } },
    BUILTIN_WALLPAPERS,
    "light",
  );
  expect(scene?.module).toBe(GRAIN_WALLPAPER);
  expect(scene?.values).toEqual({ amount: 0.5, mono: true });
});

test("a module's revision follows its content: manifest and shader", () => {
  const manifest = { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] };
  const flow = defineWallpaperModule({ manifest, fragment: "void main(){fragColor=vec4(1.);}" });
  const again = defineWallpaperModule({ manifest: { ...manifest }, fragment: "void main(){fragColor=vec4(1.);}" });
  const edited = defineWallpaperModule({ manifest, fragment: "void main(){fragColor=vec4(.5);}" });
  const renamed = defineWallpaperModule({ manifest: { ...manifest, version: "0.2.0" }, fragment: "void main(){fragColor=vec4(1.);}" });
  expect(wallpaperModuleRevision(again)).toBe(wallpaperModuleRevision(flow));
  expect(wallpaperModuleRevision(edited)).not.toBe(wallpaperModuleRevision(flow));
  expect(wallpaperModuleRevision(renamed)).not.toBe(wallpaperModuleRevision(flow));
});
