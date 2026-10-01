/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { WallpaperManifest, WallpaperNumberParam } from "./types";
import { resolveWallpaperValues, shuffledWallpaperNumber } from "./values";

const label = { en: "x", ko: "x" };
const MANIFEST: WallpaperManifest = {
  id: "butler.test",
  name: { en: "Test", ko: "테스트" },
  version: "1.0.0",
  engine: 1,
  motion: "animated",
  image: "none",
  params: [
    { key: "speed", label, type: "number", min: 0, max: 1, step: 0.05, default: 0.2, defaultDark: 0.1 },
    { key: "grain", label, type: "boolean", default: true },
    { key: "mode", label, type: "enum", options: ["soft", "sharp"], default: "soft" },
    { key: "base", label, type: "color", default: "#ffffff", defaultDark: "#1a1b1e" },
    {
      key: "colors",
      label,
      type: "palette",
      size: 2,
      default: ["#000000", "#111111"],
      presets: { dusk: { light: ["#aa0000", "#bb0000"], dark: ["#220000", "#330000"] } },
    },
  ],
};

test("defaults resolve per tone (defaultDark only in dark)", () => {
  expect(resolveWallpaperValues(MANIFEST, {}, "light")).toEqual({
    speed: 0.2, grain: true, mode: "soft", base: "#ffffff", colors: ["#000000", "#111111"],
  });
  expect(resolveWallpaperValues(MANIFEST, {}, "dark")).toEqual({
    speed: 0.1, grain: true, mode: "soft", base: "#1a1b1e", colors: ["#000000", "#111111"],
  });
});

test("light = params ?? default", () => {
  const values = resolveWallpaperValues(MANIFEST, { params: { speed: 0.6, grain: false, mode: "sharp", base: "#ABCDEF" } }, "light");
  expect(values).toMatchObject({ speed: 0.6, grain: false, mode: "sharp", base: "#abcdef" });
});

test("dark = paramsDark ?? defaultDark ?? params ?? default", () => {
  const params = { speed: 0.6, grain: false, base: "#abcdef" };
  // defaultDark beats the light value…
  expect(resolveWallpaperValues(MANIFEST, { params }, "dark")).toMatchObject({ speed: 0.1, base: "#1a1b1e" });
  // …the light value applies in dark when there is no defaultDark…
  expect(resolveWallpaperValues(MANIFEST, { params }, "dark")).toMatchObject({ grain: false });
  // …and paramsDark beats everything.
  expect(resolveWallpaperValues(MANIFEST, { params, paramsDark: { speed: 0.9, base: "#000000" } }, "dark"))
    .toMatchObject({ speed: 0.9, base: "#000000" });
  // paramsDark never leaks into light.
  expect(resolveWallpaperValues(MANIFEST, { paramsDark: { speed: 0.9 } }, "light")).toMatchObject({ speed: 0.2 });
});

test("a palette value is a preset name (per tone) or a hex list", () => {
  expect(resolveWallpaperValues(MANIFEST, { params: { colors: "dusk" } }, "light").colors).toEqual(["#aa0000", "#bb0000"]);
  expect(resolveWallpaperValues(MANIFEST, { params: { colors: "dusk" } }, "dark").colors).toEqual(["#220000", "#330000"]);
  expect(resolveWallpaperValues(MANIFEST, { params: { colors: ["#FF0000", "#00ff00"] } }, "dark").colors).toEqual(["#ff0000", "#00ff00"]);
});

test("invalid candidates fall through to the next one in the chain", () => {
  const values = resolveWallpaperValues(MANIFEST, {
    params: { speed: "fast", grain: 1, mode: "loud", base: "red", colors: "noon" },
  }, "light");
  expect(values).toEqual({ speed: 0.2, grain: true, mode: "soft", base: "#ffffff", colors: ["#000000", "#111111"] });
  expect(resolveWallpaperValues(MANIFEST, { params: { colors: ["#ff0000"] } }, "light").colors).toEqual(["#000000", "#111111"]);
  expect(resolveWallpaperValues(MANIFEST, { paramsDark: { base: "nope" }, params: { base: "#123456" } }, "dark").base).toBe("#1a1b1e");
  expect(resolveWallpaperValues(MANIFEST, { params: { speed: Number.NaN } }, "light").speed).toBe(0.2);
});

test("numbers clamp to the declared range", () => {
  expect(resolveWallpaperValues(MANIFEST, { params: { speed: 4 } }, "light").speed).toBe(1);
  expect(resolveWallpaperValues(MANIFEST, { params: { speed: -4 } }, "light").speed).toBe(0);
});

test("unknown keys are ignored", () => {
  expect(Object.keys(resolveWallpaperValues(MANIFEST, { params: { other: 1 } }, "light"))).toEqual(["speed", "grain", "mode", "base", "colors"]);
});

test("a shuffled number lands on the step grid inside the range", () => {
  const seed: WallpaperNumberParam = { key: "seed", label, type: "number", min: 0, max: 1, step: 0.0001, default: 0.23, control: "shuffle" };
  expect(shuffledWallpaperNumber(seed, () => 0)).toBe(0);
  expect(shuffledWallpaperNumber(seed, () => 0.123456)).toBe(0.1235);
  expect(shuffledWallpaperNumber(seed, () => 0.99999999)).toBe(1);
  const angle: WallpaperNumberParam = { key: "angle", label, type: "number", min: 10, max: 20, step: 3, default: 10 };
  // Grid 10, 13, 16, 19: never past max.
  expect(shuffledWallpaperNumber(angle, () => 0.99999999)).toBe(19);
  expect(shuffledWallpaperNumber(angle, () => 0.5)).toBe(16);
  for (let index = 0; index < 50; index += 1) {
    const value = shuffledWallpaperNumber(seed);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
    expect(Number((value / seed.step).toFixed(6)) % 1).toBe(0);
  }
});
