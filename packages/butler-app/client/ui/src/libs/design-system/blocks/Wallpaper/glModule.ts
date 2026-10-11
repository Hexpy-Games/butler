import type { CompiledWallpaperProgram, WallpaperProgramCache } from "./glProgram";
import { buildWallpaperDensitySource, buildWallpaperFragmentSource, buildWallpaperOverlaySource, type WallpaperPrecision } from "./glsl";
import type { WallpaperModule } from "./types";

/**
 * A module's programs: `base` (shader.frag, or a print module's print.frag), for two-pass modules the
 * per-frame `overlay` (overlay.frag), and for print modules the quarter-resolution `density` pass (density.frag).
 */
export type WallpaperModuleProgramsResult =
  | { ok: true; base: CompiledWallpaperProgram; overlay: CompiledWallpaperProgram | null; density?: CompiledWallpaperProgram | null }
  | { ok: false; stage: "compile" | "link"; log: string };

type LinkResult = { result: WallpaperModuleProgramsResult; fresh: boolean };

function linkDensity(programs: WallpaperProgramCache, module: WallpaperModule, precision: WallpaperPrecision, base: CompiledWallpaperProgram, fresh: boolean): LinkResult {
  const source = buildWallpaperDensitySource(module, precision)!;
  const density = programs.get(`${module.manifest.id}#density`, source);
  const either = fresh || density.fresh;
  if (!density.result.ok) return { result: { ...density.result, log: `density.frag: ${density.result.log}` }, fresh: either };
  return { result: { ok: true, base, overlay: null, density: density.result.compiled }, fresh: either };
}

/**
 * Links a module's passes (cached per module id and source). A two-pass
 * module whose `shader.frag` reads `u_time` fails at link: its base is drawn
 * once per input change, so it could never move. `fresh` is true when this
 * call compiled something.
 */
export function linkWallpaperModule(programs: WallpaperProgramCache, module: WallpaperModule, precision: WallpaperPrecision): LinkResult {
  const base = programs.get(module.manifest.id, buildWallpaperFragmentSource(module, precision));
  if (!base.result.ok) return { result: base.result, fresh: base.fresh };
  if (module.manifest.density) return linkDensity(programs, module, precision, base.result.compiled, base.fresh);
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
