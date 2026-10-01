import { wallpaperHexToRgb } from "./color";
import type { ResolvedWallpaperValues, WallpaperManifest, WallpaperModule, WallpaperParamSpec } from "./types";

export type WallpaperPrecision = "highp" | "mediump";

export type WallpaperUniformValue =
  | { name: string; type: "float"; value: number }
  | { name: string; type: "int"; value: number }
  | { name: string; type: "vec3"; value: [number, number, number] }
  | { name: string; type: "vec3[]"; value: number[] };

/** The engine uniforms of contract v1, in prelude order. */
export const WALLPAPER_ENGINE_UNIFORMS = [
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
] as const;

/** Full-screen triangle; no vertex buffers. */
export const WALLPAPER_VERTEX_SHADER = [
  "#version 300 es",
  "void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}",
].join("\n");

function uniformName(spec: WallpaperParamSpec): string {
  return `p_${spec.key}`;
}

function declaration(spec: WallpaperParamSpec): string {
  switch (spec.type) {
    case "number":
    case "boolean":
      return `uniform float ${uniformName(spec)};`;
    case "enum":
      return `uniform int ${uniformName(spec)};`;
    case "color":
      return `uniform vec3 ${uniformName(spec)};`;
    case "palette":
      return `uniform vec3 ${uniformName(spec)}[${spec.size}];`;
  }
}

/** number/boolean → float, enum → int (option index), color → vec3, palette → vec3[size]. */
export function wallpaperParamDeclarations(manifest: WallpaperManifest): string {
  return manifest.params.map(declaration).join("\n");
}

function uniformValue(spec: WallpaperParamSpec, values: ResolvedWallpaperValues): WallpaperUniformValue {
  const name = uniformName(spec);
  const value = values[spec.key] ?? spec.default;
  switch (spec.type) {
    case "number":
      return { name, type: "float", value: value as number };
    case "boolean":
      return { name, type: "float", value: value ? 1 : 0 };
    case "enum":
      return { name, type: "int", value: Math.max(0, spec.options.indexOf(value as string)) };
    case "color":
      return { name, type: "vec3", value: wallpaperHexToRgb(value as string) };
    case "palette":
      return { name, type: "vec3[]", value: (value as readonly string[]).flatMap(wallpaperHexToRgb) };
  }
}

/** Uniform uploads for resolved parameter values (colors as sRGB 0..1). */
export function wallpaperParamUniforms(manifest: WallpaperManifest, values: ResolvedWallpaperValues): WallpaperUniformValue[] {
  return manifest.params.map((spec) => uniformValue(spec, values));
}

/** What a two-pass module's `overlay.frag` reads besides the prelude: `shader.frag`'s cached output. */
export const WALLPAPER_BASE_UNIFORM = "uniform sampler2D u_base;";

function fragmentSource(module: WallpaperModule, precision: WallpaperPrecision, extra: readonly string[], body: string): string {
  const params = wallpaperParamDeclarations(module.manifest);
  return [
    "#version 300 es",
    `precision ${precision} float;`,
    "out vec4 fragColor;",
    ...WALLPAPER_ENGINE_UNIFORMS,
    ...extra,
    ...(params ? [params] : []),
    "#line 1",
    body,
  ].join("\n");
}

/** Engine prelude + param uniforms + the module body; `#line 1` maps errors to shader.frag lines. */
export function buildWallpaperFragmentSource(module: WallpaperModule, precision: WallpaperPrecision): string {
  return fragmentSource(module, precision, [], module.fragment);
}

/** A two-pass module's per-frame pass: the prelude, `u_base`, param uniforms and `overlay.frag`; null for single-pass modules. */
export function buildWallpaperOverlaySource(module: WallpaperModule, precision: WallpaperPrecision): string | null {
  return module.manifest.overlay && module.overlay !== undefined ? fragmentSource(module, precision, [WALLPAPER_BASE_UNIFORM], module.overlay) : null;
}
