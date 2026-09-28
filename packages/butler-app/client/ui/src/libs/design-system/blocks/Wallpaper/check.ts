// Compile checks of wallpaper modules (e.g. user modules as they change), on the shared still context.
import { compileWallpaperStillProgram } from "./stillGpu";
import type { WallpaperModule } from "./types";

/** Longest log a check returns (status messages and tooltips stay short). */
const MAX_LOG_CHARS = 2000;

export type WallpaperModuleCheck = { ok: true } | { ok: false; stage: "compile" | "link"; log: string };

/** A GLSL info log without NULs, blank lines or trailing spaces, cut to a status-sized length. */
export function trimWallpaperShaderLog(log: string): string {
  const text = log.replace(/\0/gu, "").split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim()).join("\n").trim();
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS - 1)}…` : text;
}

/**
 * Compiles and links a module's passes once (per source) on the shared
 * offscreen context that also draws stills, so its thumbnails reuse them.
 * Returns the failing stage with the trimmed log; null when WebGL2 is
 * unavailable (nothing can be said about the module).
 */
export function checkWallpaperModule(module: WallpaperModule): WallpaperModuleCheck | null {
  const result = compileWallpaperStillProgram(module);
  if (!result) return null;
  return result.ok ? { ok: true } : { ok: false, stage: result.stage, log: trimWallpaperShaderLog(result.log) };
}
