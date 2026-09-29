/// <reference types="bun" />
import { expect, test } from "bun:test";
import { defineWallpaperModule, validateWallpaperManifest } from "./manifest";
import { WALLPAPER_TIME_PERIOD_SECONDS } from "./time";

const label = { en: "Speed", ko: "속도" };

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "butler.test",
    name: { en: "Test", ko: "테스트" },
    version: "1.0.0",
    engine: 1,
    motion: "animated",
    image: "none",
    params: [],
    ...overrides,
  };
}

function errorsOf(value: unknown): string[] {
  const result = validateWallpaperManifest(value);
  return result.ok ? [] : result.errors;
}

test("a minimal manifest validates and keeps only contract fields", () => {
  const result = validateWallpaperManifest({ ...manifest(), extra: true });
  expect(result.ok).toBe(true);
  if (result.ok) expect(Object.keys(result.manifest).sort()).toEqual(["engine", "id", "image", "motion", "name", "params", "version"]);
});

test("top-level fields follow the contract", () => {
  expect(errorsOf(manifest({ id: "Butler" }))).toEqual(["id: must match ^[a-z0-9]+(\\.[a-z0-9-]+)+$ and be at most 64 chars"]);
  expect(errorsOf(manifest({ id: "butler" }))).toHaveLength(1);
  expect(errorsOf(manifest({ id: `butler.${"a".repeat(60)}` }))).toHaveLength(1);
  expect(errorsOf(manifest({ id: "me.rainy-window" }))).toEqual([]);
  expect(errorsOf(manifest({ name: { en: "Only English" } }))).toEqual(["name: needs non-empty en and ko"]);
  expect(errorsOf(manifest({ version: "1.0" }))).toEqual(["version: must be semver"]);
  expect(errorsOf(manifest({ version: "1.2.3-beta.1" }))).toEqual([]);
  expect(errorsOf(manifest({ engine: 2 }))).toEqual(["engine: must be 1"]);
  expect(errorsOf(manifest({ motion: "looping" }))).toEqual(["motion: must be static or animated"]);
  expect(errorsOf(manifest({ image: "maybe" }))).toEqual(["image: must be none, optional or required"]);
  expect(errorsOf("nope")).toEqual(["manifest: must be an object"]);
});

test("params: at most 8, unique keys matching the key pattern", () => {
  const number = (key: string) => ({ key, label, type: "number", min: 0, max: 1, step: 0.1, default: 0.5 });
  expect(errorsOf(manifest({ params: Array.from({ length: 9 }, (_, index) => number(`p${index}`)) }))).toContain("params: at most 8");
  expect(errorsOf(manifest({ params: [number("speed"), number("speed")] }))).toEqual(["params[1].key: duplicate speed"]);
  expect(errorsOf(manifest({ params: [number("Speed")] }))).toEqual(["params[0].key: must match ^[a-z][A-Za-z0-9]{0,23}$"]);
  expect(errorsOf(manifest({ params: [number("a".repeat(25))] }))).toHaveLength(1);
  expect(errorsOf(manifest({ params: [{ ...number("speed"), label: { en: "Speed" } }] }))).toEqual(["params[0].label: needs non-empty en and ko"]);
  expect(errorsOf(manifest({ params: [{ ...number("speed"), type: "vector" }] }))).toEqual(["params[0].type: unknown vector"]);
});

test("number params need a range, a positive step and in-range defaults", () => {
  const spec = { key: "speed", label, type: "number", min: 0, max: 1, step: 0.1, default: 0.5 };
  expect(errorsOf(manifest({ params: [spec] }))).toEqual([]);
  expect(errorsOf(manifest({ params: [{ ...spec, min: 1, max: 0 }] }))).toContain("params[0]: min must be below max");
  expect(errorsOf(manifest({ params: [{ ...spec, step: 0 }] }))).toContain("params[0].step: must be positive");
  expect(errorsOf(manifest({ params: [{ ...spec, default: 2 }] }))).toEqual(["params[0].default: must be a number in [0, 1]"]);
  expect(errorsOf(manifest({ params: [{ ...spec, defaultDark: -1 }] }))).toEqual(["params[0].defaultDark: must be a number in [0, 1]"]);
});

test("boolean, enum and color params validate their defaults", () => {
  expect(errorsOf(manifest({ params: [{ key: "grain", label, type: "boolean", default: "yes" }] }))).toEqual(["params[0].default: must be a boolean"]);
  const enumSpec = { key: "mode", label, type: "enum", options: ["soft", "sharp"], default: "soft" };
  expect(errorsOf(manifest({ params: [enumSpec] }))).toEqual([]);
  expect(errorsOf(manifest({ params: [{ ...enumSpec, default: "loud" }] }))).toEqual(["params[0].default: must be one of the options"]);
  expect(errorsOf(manifest({ params: [{ ...enumSpec, options: Array.from({ length: 9 }, (_, index) => `o${index}`), default: "o0" }] })))
    .toEqual(["params[0].options: 1 to 8 unique values"]);
  expect(errorsOf(manifest({ params: [{ ...enumSpec, options: ["soft", "soft"] }] }))).toEqual(["params[0].options: 1 to 8 unique values"]);
  expect(errorsOf(manifest({ params: [{ key: "base", label, type: "color", default: "#fff" }] }))).toEqual(["params[0].default: must be #RRGGBB"]);
  expect(errorsOf(manifest({ params: [{ key: "base", label, type: "color", default: "#FFFFFF", defaultDark: "#1a1b1e" }] }))).toEqual([]);
});

test("palette params: size 2..6, sized defaults and light/dark presets", () => {
  const palette = { key: "colors", label, type: "palette", size: 2, default: ["#000000", "#ffffff"] };
  expect(errorsOf(manifest({ params: [palette] }))).toEqual([]);
  expect(errorsOf(manifest({ params: [{ ...palette, size: 7 }] }))).toContain("params[0].size: must be an integer in [2, 6]");
  expect(errorsOf(manifest({ params: [{ ...palette, default: ["#000000"] }] }))).toEqual(["params[0].default: must be 2 #RRGGBB colors"]);
  expect(errorsOf(manifest({ params: [{ ...palette, defaultDark: ["#000000", "white"] }] }))).toEqual(["params[0].defaultDark: must be 2 #RRGGBB colors"]);
  const presets = { dusk: { light: ["#111111", "#222222"], dark: ["#333333", "#444444"] } };
  expect(errorsOf(manifest({ params: [{ ...palette, presets }] }))).toEqual([]);
  expect(errorsOf(manifest({ params: [{ ...palette, presets: { dusk: { light: ["#111111", "#222222"] } } }] })))
    .toEqual(["params[0].presets.dusk.dark: must be 2 #RRGGBB colors"]);
});

test("defineWallpaperModule validates the manifest and the shader body", () => {
  const fragment = "void main(){fragColor=vec4(1.);}";
  const module = defineWallpaperModule({ manifest: manifest(), fragment });
  expect(module.manifest.id).toBe("butler.test");
  expect(module.fragment).toBe(fragment);
  expect(() => defineWallpaperModule({ manifest: manifest({ engine: 2 }), fragment })).toThrow("butler.test: engine: must be 1");
  expect(() => defineWallpaperModule({ manifest: manifest(), fragment: "void main(){}" })).toThrow("fragColor");
  expect(() => defineWallpaperModule({ manifest: manifest(), fragment: `#version 300 es\n${fragment}` })).toThrow("#version");
  expect(() => defineWallpaperModule({ manifest: manifest(), fragment: `precision highp float;\n${fragment}` })).toThrow("precision");
  expect(() => defineWallpaperModule({ manifest: manifest(), fragment: `uniform float u_time;\n${fragment}` })).toThrow("u_time");
  expect(() => defineWallpaperModule({ manifest: manifest(), fragment: "float f(){return 1.;}" })).toThrow("void main");
});

test("timePeriod is optional seconds in (0, 5000*PI]", () => {
  const plain = validateWallpaperManifest(manifest());
  expect(plain.ok && "timePeriod" in plain.manifest).toBe(false);
  const hourly = validateWallpaperManifest(manifest({ timePeriod: 3600 }));
  expect(hourly.ok && hourly.manifest.timePeriod).toBe(3600);
  expect(errorsOf(manifest({ timePeriod: WALLPAPER_TIME_PERIOD_SECONDS }))).toEqual([]);
  const message = "timePeriod: must be seconds in (0, 5000*PI]";
  for (const bad of [0, -60, WALLPAPER_TIME_PERIOD_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY, "3600", null]) {
    expect(errorsOf(manifest({ timePeriod: bad }))).toEqual([message]);
  }
});

test("enum options may be strings or { value, label } entries", () => {
  const soft = { value: "soft", label: { en: "Soft", ko: "부드럽게" } };
  const result = validateWallpaperManifest(manifest({
    params: [{ key: "mode", label, type: "enum", options: [soft, "sharp"], default: "soft", defaultDark: "sharp" }],
  }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // Options stay a list of values (p_<key> is the index); labels are kept by value.
  expect(result.manifest.params[0]).toEqual({
    key: "mode", label, type: "enum", options: ["soft", "sharp"], optionLabels: { soft: soft.label }, default: "soft", defaultDark: "sharp",
  });
  const plain = validateWallpaperManifest(manifest({ params: [{ key: "mode", label, type: "enum", options: ["soft"], default: "soft" }] }));
  expect(plain.ok && "optionLabels" in plain.manifest.params[0]!).toBe(false);
});

test("enum option entries need a value and an en/ko label; values stay unique", () => {
  const spec = (options: unknown[]) => manifest({ params: [{ key: "mode", label, type: "enum", options, default: "soft" }] });
  expect(errorsOf(spec([{ value: "soft", label: { en: "Soft" } }]))).toEqual(["params[0].options[0].label: needs non-empty en and ko"]);
  expect(errorsOf(spec([{ value: "", label }]))).toEqual(["params[0].options: 1 to 8 unique values"]);
  expect(errorsOf(spec([{ label }]))).toEqual(["params[0].options: 1 to 8 unique values"]);
  expect(errorsOf(spec(["soft", { value: "soft", label }]))).toEqual(["params[0].options: 1 to 8 unique values"]);
  expect(errorsOf(spec([{ value: "hard", label }]))).toEqual(["params[0].default: must be one of the options"]);
});

test("number params may ask for a shuffle control", () => {
  const seed = { key: "seed", label, type: "number", min: 0, max: 1, step: 0.0001, default: 0.23, control: "shuffle" } as const;
  const result = validateWallpaperManifest(manifest({ params: [seed] }));
  expect(result.ok && result.manifest.params[0]).toEqual(seed);
  const slider = validateWallpaperManifest(manifest({ params: [{ ...seed, control: undefined }] }));
  expect(slider.ok && "control" in slider.manifest.params[0]!).toBe(false);
  expect(errorsOf(manifest({ params: [{ ...seed, control: "dial" }] }))).toEqual(["params[0].control: must be shuffle"]);
  expect(errorsOf(manifest({ params: [{ key: "on", label, type: "boolean", default: true, control: "shuffle" }] })))
    .toEqual(["params[0].control: only number params take a control"]);
});

test("two-pass, pixel ratio, image dim, default image and scene tone fields are validated and kept", () => {
  const realtime = { key: "realtime", label, type: "boolean", default: false } as const;
  const options = {
    image: "optional", overlay: true, pixelRatio: "device", imageDim: "noDarkStep", defaultImage: "photo.jpg",
    sceneTone: { param: "realtime", darkPhases: [[0, 0.25], [0.75, 1]] }, params: [realtime],
  };
  const result = validateWallpaperManifest(manifest(options));
  expect(result.ok && result.manifest).toMatchObject(options);
  expect(errorsOf(manifest({ ...options, overlay: "yes", pixelRatio: 3, imageDim: "dark", defaultImage: "../photo.jpg" }))).toEqual([
    "overlay: must be a boolean", "pixelRatio: must be default or device", "imageDim: must be auto, noDarkStep or none",
    "defaultImage: must be a .jpg, .png or .webp file name beside shader.frag",
  ]);
  expect(errorsOf(manifest({ image: "none", defaultImage: "photo.jpg" }))).toEqual(["defaultImage: needs image optional or required"]);
  expect(errorsOf(manifest({ ...options, sceneTone: { param: "mode", darkPhases: [[0.5, 0.2]] } }))).toEqual([
    "sceneTone.param: must name a boolean param", "sceneTone.darkPhases: 1 to 4 [start, end) ranges with 0 <= start < end <= 1",
  ]);
  const five = Array.from({ length: 5 }, (_, index) => [index / 5, (index + 0.5) / 5]);
  expect(errorsOf(manifest({ ...options, sceneTone: { param: "realtime", darkPhases: five } }))).toHaveLength(1);
});

test("a two-pass module needs its overlay.frag, and a single-pass one takes none", () => {
  const fragment = "void main(){fragColor=vec4(1.);}";
  const overlay = "void main(){fragColor=texture(u_base,gl_FragCoord.xy/u_resolution);}";
  expect(defineWallpaperModule({ manifest: manifest({ overlay: true }), fragment, overlay }).overlay).toBe(overlay);
  expect(() => defineWallpaperModule({ manifest: manifest({ overlay: true }), fragment })).toThrow("overlay.frag: required by overlay: true");
  expect(() => defineWallpaperModule({ manifest: manifest(), fragment, overlay })).toThrow("overlay.frag: set overlay: true in wallpaper.json");
  expect(() => defineWallpaperModule({ manifest: manifest({ overlay: true }), fragment, overlay: `uniform sampler2D u_base;\n${overlay}` }))
    .toThrow("overlay.frag: u_base is an engine uniform");
});
