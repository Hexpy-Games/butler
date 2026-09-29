import type { CompiledWallpaperProgram, WallpaperProgramCache } from "./glProgram";
import { buildWallpaperFragmentSource, buildWallpaperOverlaySource, type WallpaperPrecision } from "./glsl";
import type { WallpaperModule } from "./types";

/** A module's programs: `base` (shader.frag) and, for two-pass modules, the per-frame `overlay` (overlay.frag). */
export type WallpaperModuleProgramsResult =
  | { ok: true; base: CompiledWallpaperProgram; overlay: CompiledWallpaperProgram | null }
  | { ok: false; stage: "compile" | "link"; log: string };

/**
 * Links a module's passes (cached per module id and source). A two-pass
 * module whose `shader.frag` reads `u_time` fails at link: its base is drawn
 * once per input change, so it could never move. `fresh` is true when this
 * call compiled something.
 */
export function linkWallpaperModule(
  programs: WallpaperProgramCache,
  module: WallpaperModule,
  precision: WallpaperPrecision,
): { result: WallpaperModuleProgramsResult; fresh: boolean } {
  const base = programs.get(module.manifest.id, buildWallpaperFragmentSource(module, precision));
  if (!base.result.ok) return { result: base.result, fresh: base.fresh };
  const overlaySource = buildWallpaperOverlaySource(module, precision);
  if (overlaySource === null) return { result: { ok: true, base: base.result.compiled, overlay: null }, fresh: base.fresh };
  if (base.result.compiled.usesTime) {
    return { result: { ok: false, stage: "link", log: "shader.frag: the base of a two-pass module must not read u_time" }, fresh: base.fresh };
  }
  const overlay = programs.get(`${module.manifest.id}#overlay`, overlaySource);
  const fresh = base.fresh || overlay.fresh;
  if (!overlay.result.ok) return { result: { ...overlay.result, log: `overlay.frag: ${overlay.result.log}` }, fresh };
  return { result: { ok: true, base: base.result.compiled, overlay: overlay.result.compiled }, fresh };
}
