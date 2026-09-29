/// <reference types="bun" />
import { expect, test } from "bun:test";
import { buildWallpaperFragmentSource, wallpaperParamDeclarations, wallpaperParamUniforms } from "./glsl";
import type { WallpaperManifest } from "./types";

const label = { en: "x", ko: "x" };
const MANIFEST: WallpaperManifest = {
  id: "butler.test",
  name: { en: "Test", ko: "테스트" },
  version: "1.0.0",
  engine: 1,
  motion: "animated",
  image: "none",
  params: [
    { key: "speed", label, type: "number", min: 0, max: 1, step: 0.05, default: 0.2 },
    { key: "grain", label, type: "boolean", default: true },
    { key: "mode", label, type: "enum", options: ["soft", "sharp", "torn"], optionLabels: { torn: { en: "Torn", ko: "찢김" } }, default: "soft" },
    { key: "base", label, type: "color", default: "#ffffff" },
    { key: "colors", label, type: "palette", size: 2, default: ["#000000", "#ff8000"] },
  ],
};

test("params map to p_<key> uniforms by type", () => {
  expect(wallpaperParamDeclarations(MANIFEST)).toBe([
    "uniform float p_speed;",
    "uniform float p_grain;",
    "uniform int p_mode;",
    "uniform vec3 p_base;",
    "uniform vec3 p_colors[2];",
  ].join("\n"));
});

test("resolved values become uniform values (sRGB 0..1, enum index, boolean 0/1)", () => {
  const uniforms = wallpaperParamUniforms(MANIFEST, {
    speed: 0.35, grain: false, mode: "torn", base: "#ff8000", colors: ["#000000", "#ffffff"],
  });
  expect(uniforms).toEqual([
    { name: "p_speed", type: "float", value: 0.35 },
    { name: "p_grain", type: "float", value: 0 },
    { name: "p_mode", type: "int", value: 2 },
    { name: "p_base", type: "vec3", value: [1, 128 / 255, 0] },
    { name: "p_colors", type: "vec3[]", value: [0, 0, 0, 1, 1, 1] },
  ]);
  expect(wallpaperParamUniforms(MANIFEST, { speed: 0, grain: true, mode: "soft", base: "#000000", colors: ["#000000", "#000000"] })[1])
    .toEqual({ name: "p_grain", type: "float", value: 1 });
});

test("the engine prelude declares the contract uniforms before the module body", () => {
  const source = buildWallpaperFragmentSource({ manifest: MANIFEST, fragment: "void main(){fragColor=vec4(p_base,1.);}" }, "highp");
  const lines = source.split("\n");
  expect(lines[0]).toBe("#version 300 es");
  expect(lines[1]).toBe("precision highp float;");
  for (const declaration of [
    "out vec4 fragColor;",
    "uniform vec2 u_resolution;",
    "uniform float u_pixelRatio;",
    "uniform float u_time;",
    "uniform float u_dark;",
    "uniform float u_dayPhase;",
    "uniform float u_seed;",
    "uniform sampler2D u_noiseTexture;",
    "uniform sampler2D u_image;",
    "uniform float u_hasImage;",
    "uniform float u_imageAspectRatio;",
    "uniform vec4 u_contentRect;",
    "uniform vec3 p_colors[2];",
  ]) expect(lines).toContain(declaration);
  // Compile errors point at shader.frag lines.
  expect(source).toContain("#line 1\nvoid main(){fragColor=vec4(p_base,1.);}");
  expect(source.indexOf("uniform vec3 p_base;")).toBeLessThan(source.indexOf("#line 1"));
});

test("mediump is used when the fragment stage has no highp", () => {
  const source = buildWallpaperFragmentSource({ manifest: { ...MANIFEST, params: [] }, fragment: "void main(){fragColor=vec4(1.);}" }, "mediump");
  expect(source.split("\n")[1]).toBe("precision mediump float;");
  expect(source).not.toContain("uniform float p_");
});
