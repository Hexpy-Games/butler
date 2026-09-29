import { validateManifestOptions } from "./manifestOptions";
import { isRecord, validLabel, validateParam } from "./manifestParams";
import { WALLPAPER_TIME_PERIOD_SECONDS } from "./time";
import type { WallpaperDefaultImage, WallpaperManifest, WallpaperModule, WallpaperParamSpec } from "./types";

const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/u;
const MAX_ID_LENGTH = 64;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MAX_PARAMS = 8;
/** Uniforms the engine prelude declares; a module body must not redeclare them. */
const ENGINE_UNIFORM = /\buniform\s+\w+\s+(u_\w+)/u;

export type WallpaperManifestResult =
  | { ok: true; manifest: WallpaperManifest }
  | { ok: false; errors: string[] };

function validateParams(raw: unknown, errors: string[]): WallpaperParamSpec[] {
  if (!Array.isArray(raw)) {
    errors.push("params: must be an array");
    return [];
  }
  if (raw.length > MAX_PARAMS) errors.push(`params: at most ${MAX_PARAMS}`);
  const seen = new Set<unknown>();
  return raw.flatMap((entry, index) => {
    const spec = validateParam(entry, index, errors);
    if (isRecord(entry) && seen.has(entry.key)) errors.push(`params[${index}].key: duplicate ${String(entry.key)}`);
    if (isRecord(entry)) seen.add(entry.key);
    return spec ? [spec] : [];
  });
}

/** Checks a parsed `wallpaper.json` against contract v1 (engine: 1). */
export function validateWallpaperManifest(raw: unknown): WallpaperManifestResult {
  if (!isRecord(raw)) return { ok: false, errors: ["manifest: must be an object"] };
  const errors: string[] = [];
  const { id, name, version, engine, motion, image } = raw;
  if (typeof id !== "string" || !ID.test(id) || id.length > MAX_ID_LENGTH) {
    errors.push(`id: must match ${ID.source} and be at most ${MAX_ID_LENGTH} chars`);
  }
  if (!validLabel(name)) errors.push("name: needs non-empty en and ko");
  if (typeof version !== "string" || !SEMVER.test(version)) errors.push("version: must be semver");
  if (engine !== 1) errors.push("engine: must be 1");
  if (motion !== "static" && motion !== "animated") errors.push("motion: must be static or animated");
  if (image !== "none" && image !== "optional" && image !== "required") errors.push("image: must be none, optional or required");
  const { timePeriod } = raw;
  if (timePeriod !== undefined && !validTimePeriod(timePeriod)) errors.push("timePeriod: must be seconds in (0, 5000*PI]");
  const params = validateParams(raw.params, errors);
  const options = validateManifestOptions(raw, params, errors);
  if (errors.length > 0) return { ok: false, errors };
  const period = timePeriod === undefined ? {} : { timePeriod };
  return { ok: true, manifest: { id, name, version, engine, motion, image, ...period, ...options, params } as WallpaperManifest };
}

/** Positive, and no longer than the engine period so `u_time` stays inside the mediump range. */
function validTimePeriod(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= WALLPAPER_TIME_PERIOD_SECONDS;
}

function fragmentErrors(fragment: string, file = "shader.frag"): string[] {
  const errors: string[] = [];
  if (/^\s*#\s*version\b/mu.test(fragment)) errors.push(`${file}: drop #version (the engine prelude sets it)`);
  if (/^\s*precision\s/mu.test(fragment)) errors.push(`${file}: drop precision (the engine prelude sets it)`);
  const engineUniform = ENGINE_UNIFORM.exec(fragment)?.[1];
  if (engineUniform) errors.push(`${file}: ${engineUniform} is an engine uniform`);
  if (!/\bvoid\s+main\s*\(/u.test(fragment)) errors.push(`${file}: must define void main()`);
  else if (!/\bfragColor\b/u.test(fragment)) errors.push(`${file}: main() must write fragColor`);
  return errors;
}

/** A two-pass manifest needs its `overlay.frag`; a single-pass one takes none. */
function overlayErrors(manifest: unknown, overlay: string | undefined): string[] {
  const twoPass = isRecord(manifest) && manifest.overlay === true;
  if (twoPass) return overlay === undefined ? ["overlay.frag: required by overlay: true"] : fragmentErrors(overlay, "overlay.frag");
  return overlay === undefined ? [] : ["overlay.frag: set overlay: true in wallpaper.json"];
}

export interface WallpaperModuleSource {
  /** Parsed `wallpaper.json`. */
  manifest: unknown;
  /** `shader.frag` body. */
  fragment: string;
  /** `overlay.frag` body of a two-pass module. */
  overlay?: string;
  /** The loaded `defaultImage` file; ignored when the manifest names none. */
  defaultImage?: WallpaperDefaultImage;
  /** Clock (seconds) of the module's still frames. */
  stillTime?: number;
}

/**
 * A wallpaper module from a parsed `wallpaper.json` and its `shader.frag`
 * body (plus `overlay.frag` for two-pass modules and the loaded default
 * image). Built-ins and user modules go through the same checks; invalid
 * input throws with every contract error.
 */
export function defineWallpaperModule({ manifest, fragment, overlay, defaultImage, stillTime }: WallpaperModuleSource): WallpaperModule {
  const result = validateWallpaperManifest(manifest);
  const errors = [...(result.ok ? [] : result.errors), ...fragmentErrors(fragment), ...overlayErrors(manifest, overlay)];
  if (!result.ok || errors.length > 0) {
    const id = isRecord(manifest) && typeof manifest.id === "string" ? manifest.id : "wallpaper";
    throw new Error(`${id}: ${errors.join("; ")}`);
  }
  return {
    manifest: result.manifest,
    fragment,
    ...(overlay === undefined ? {} : { overlay }),
    ...(defaultImage && result.manifest.defaultImage ? { defaultImage } : {}),
    ...(stillTime === undefined ? {} : { stillTime }),
  };
}
