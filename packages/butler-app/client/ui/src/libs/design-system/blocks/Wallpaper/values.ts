import { isWallpaperHex, isWallpaperHexList, normalizeWallpaperHex } from "./color";
import type {
  ResolvedWallpaperValue,
  ResolvedWallpaperValues,
  WallpaperManifest,
  WallpaperNumberParam,
  WallpaperParamSpec,
  WallpaperParams,
  WallpaperTone,
} from "./types";

export interface WallpaperParamInput {
  params?: WallpaperParams;
  paramsDark?: WallpaperParams;
}

/** The candidate's value for this param, or null when it does not fit the spec. */
function accept(spec: WallpaperParamSpec, value: unknown, tone: WallpaperTone): ResolvedWallpaperValue | null {
  switch (spec.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, value)) : null;
    case "boolean":
      return typeof value === "boolean" ? value : null;
    case "enum":
      return typeof value === "string" && spec.options.includes(value) ? value : null;
    case "color":
      return isWallpaperHex(value) ? normalizeWallpaperHex(value) : null;
    case "palette": {
      const preset = typeof value === "string" ? spec.presets?.[value]?.[tone] : undefined;
      const colors = preset ?? value;
      return isWallpaperHexList(colors, spec.size) ? colors.map(normalizeWallpaperHex) : null;
    }
  }
}

function candidates(spec: WallpaperParamSpec, input: WallpaperParamInput, tone: WallpaperTone): unknown[] {
  const light = input.params?.[spec.key];
  if (tone === "light") return [light, spec.default];
  return [input.paramsDark?.[spec.key], spec.defaultDark, light, spec.default];
}

/**
 * Parameter values for a tone. Light: params ?? default. Dark: paramsDark ??
 * defaultDark ?? params ?? default. A palette value is a preset name (read
 * for the tone) or a hex list. Invalid candidates fall through to the next.
 */
export function resolveWallpaperValues(
  manifest: WallpaperManifest,
  input: WallpaperParamInput,
  tone: WallpaperTone,
): ResolvedWallpaperValues {
  const values: ResolvedWallpaperValues = {};
  for (const spec of manifest.params) {
    for (const candidate of candidates(spec, input, tone)) {
      if (candidate === undefined) continue;
      const value = accept(spec, candidate, tone);
      if (value === null) continue;
      values[spec.key] = value;
      break;
    }
  }
  return values;
}

/** A random value on the param's step grid within [min, max] (the `shuffle` control). */
export function shuffledWallpaperNumber(spec: WallpaperNumberParam, random: () => number = Math.random): number {
  const steps = Math.floor((spec.max - spec.min) / spec.step + 1e-9);
  const value = spec.min + Math.round(random() * steps) * spec.step;
  // Trim float noise (0.1235000001) without assuming how many decimals the step has.
  return Math.min(spec.max, Number(value.toFixed(10)));
}
