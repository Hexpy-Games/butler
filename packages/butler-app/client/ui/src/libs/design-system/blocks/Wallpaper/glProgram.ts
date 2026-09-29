import { WALLPAPER_VERTEX_SHADER } from "./glsl";

export interface CompiledWallpaperProgram {
  program: WebGLProgram;
  /** Cached uniform lookup; null for uniforms the shader does not use. */
  uniform(name: string): WebGLUniformLocation | null;
  /** The module reads `u_dayPhase` (still frames then refresh periodically). */
  usesDayPhase: boolean;
  /** The module reads `u_contentRect` (a content-area change redraws still frames). */
  usesContentRect: boolean;
  /** The module reads `u_time` (a two-pass module's base must not). */
  usesTime: boolean;
}

export type WallpaperProgramResult =
  | { ok: true; compiled: CompiledWallpaperProgram }
  | { ok: false; stage: "compile" | "link"; log: string };

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | string {
  const shader = gl.createShader(type);
  if (!shader) return "createShader failed";
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const log = gl.getShaderInfoLog(shader) || "compile failed";
  gl.deleteShader(shader);
  return log;
}

function linkProgram(gl: WebGL2RenderingContext, fragmentSource: string): WallpaperProgramResult {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, WALLPAPER_VERTEX_SHADER);
  if (typeof vertex === "string") return { ok: false, stage: "compile", log: vertex };
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (typeof fragment === "string") {
    gl.deleteShader(vertex);
    return { ok: false, stage: "compile", log: fragment };
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "link failed";
    gl.deleteProgram(program);
    return { ok: false, stage: "link", log };
  }
  const locations = new Map<string, WebGLUniformLocation | null>();
  const uniform = (name: string) => {
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
    return locations.get(name) ?? null;
  };
  const usesDayPhase = uniform("u_dayPhase") !== null;
  return {
    ok: true,
    compiled: { program, uniform, usesDayPhase, usesContentRect: uniform("u_contentRect") !== null, usesTime: uniform("u_time") !== null },
  };
}

export interface WallpaperProgramCache {
  /**
   * The program of module `id` for `fragmentSource`, linked on first use.
   * `fresh` is true only when this call compiled it. A new source for an id
   * (a module's edited shader) replaces and deletes the previous program.
   */
  get(id: string, fragmentSource: string): { result: WallpaperProgramResult; fresh: boolean };
  dispose(): void;
}

function deleteProgram(gl: WebGL2RenderingContext, result: WallpaperProgramResult) {
  if (result.ok) gl.deleteProgram(result.compiled.program);
}

/** One program per module id and source: a re-render or a param change never rebuilds one. */
export function createWallpaperProgramCache(gl: WebGL2RenderingContext): WallpaperProgramCache {
  const cache = new Map<string, { source: string; result: WallpaperProgramResult }>();
  return {
    get(id, fragmentSource) {
      const cached = cache.get(id);
      if (cached?.source === fragmentSource) return { result: cached.result, fresh: false };
      if (cached) deleteProgram(gl, cached.result);
      const result = linkProgram(gl, fragmentSource);
      cache.set(id, { source: fragmentSource, result });
      return { result, fresh: true };
    },
    dispose() {
      for (const { result } of cache.values()) deleteProgram(gl, result);
      cache.clear();
    },
  };
}
