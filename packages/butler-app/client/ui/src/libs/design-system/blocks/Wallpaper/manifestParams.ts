import { isWallpaperHex, isWallpaperHexList } from "./color";
import type { WallpaperLabel, WallpaperParamSpec, WallpaperPalettePreset } from "./types";

const KEY = /^[a-z][A-Za-z0-9]{0,23}$/u;
const MAX_ENUM_OPTIONS = 8;
const MIN_PALETTE = 2;
const MAX_PALETTE = 6;
const NUMBER_CONTROLS = new Set<unknown>(["shuffle"]);

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validLabel(value: unknown): value is WallpaperLabel {
  return isRecord(value) &&
    typeof value.en === "string" && value.en.trim().length > 0 &&
    typeof value.ko === "string" && value.ko.trim().length > 0;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function defaults(raw: Json, check: (value: unknown) => boolean, message: string, errors: string[], at: string) {
  if (!check(raw.default)) errors.push(`${at}.default: ${message}`);
  if ("defaultDark" in raw && !check(raw.defaultDark)) errors.push(`${at}.defaultDark: ${message}`);
}

function withDark<T>(raw: Json, spec: T): T {
  return "defaultDark" in raw ? { ...spec, defaultDark: raw.defaultDark } : spec;
}

function numberParam(raw: Json, base: Json, errors: string[], at: string): WallpaperParamSpec | null {
  const { min, max, step, control } = raw;
  const finite = [min, max, step].every((value) => typeof value === "number" && Number.isFinite(value));
  if (!finite) return errors.push(`${at}: min, max and step must be numbers`), null;
  if ((min as number) >= (max as number)) errors.push(`${at}: min must be below max`);
  if ((step as number) <= 0) errors.push(`${at}.step: must be positive`);
  if (control !== undefined && !NUMBER_CONTROLS.has(control)) errors.push(`${at}.control: must be shuffle`);
  defaults(raw, (value) => inRange(value, min as number, max as number), `must be a number in [${min}, ${max}]`, errors, at);
  const spec = { ...base, type: "number", min, max, step, default: raw.default, ...(control === undefined ? {} : { control }) };
  return withDark(raw, spec as WallpaperParamSpec);
}

/** An option entry: a value string, or `{ value, label: { en, ko } }`. */
function optionValue(option: unknown): unknown {
  return isRecord(option) ? option.value : option;
}

function enumParam(raw: Json, base: Json, errors: string[], at: string): WallpaperParamSpec | null {
  const entries = raw.options;
  const values = Array.isArray(entries) ? entries.map(optionValue) : [];
  const valid = Array.isArray(entries) && entries.length > 0 && entries.length <= MAX_ENUM_OPTIONS &&
    values.every((value) => typeof value === "string" && value.length > 0) && new Set(values).size === values.length;
  if (!valid) return errors.push(`${at}.options: 1 to ${MAX_ENUM_OPTIONS} unique values`), null;
  const options = values as string[];
  const optionLabels: Record<string, WallpaperLabel> = {};
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    if (validLabel(entry.label)) optionLabels[options[index]!] = { en: entry.label.en, ko: entry.label.ko };
    else errors.push(`${at}.options[${index}].label: needs non-empty en and ko`);
  });
  defaults(raw, (value) => options.includes(value as string), "must be one of the options", errors, at);
  const labels = Object.keys(optionLabels).length > 0 ? { optionLabels } : {};
  return withDark(raw, { ...base, type: "enum", options, ...labels, default: raw.default } as WallpaperParamSpec);
}

function presetsOf(raw: unknown, size: number, errors: string[], at: string): Record<string, WallpaperPalettePreset> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return errors.push(`${at}.presets: must be an object`), undefined;
  const presets: Record<string, WallpaperPalettePreset> = {};
  for (const [name, preset] of Object.entries(raw)) {
    for (const tone of ["light", "dark"] as const) {
      const colors = isRecord(preset) ? preset[tone] : undefined;
      if (!isWallpaperHexList(colors, size)) errors.push(`${at}.presets.${name}.${tone}: must be ${size} #RRGGBB colors`);
    }
    if (isRecord(preset)) presets[name] = { light: preset.light as string[], dark: preset.dark as string[] };
  }
  return presets;
}

function paletteParam(raw: Json, base: Json, errors: string[], at: string): WallpaperParamSpec | null {
  const size = raw.size;
  if (!Number.isInteger(size) || (size as number) < MIN_PALETTE || (size as number) > MAX_PALETTE) {
    return errors.push(`${at}.size: must be an integer in [${MIN_PALETTE}, ${MAX_PALETTE}]`), null;
  }
  defaults(raw, (value) => isWallpaperHexList(value, size as number), `must be ${size} #RRGGBB colors`, errors, at);
  const presets = presetsOf(raw.presets, size as number, errors, at);
  const spec = { ...base, type: "palette", size, default: raw.default, ...(presets ? { presets } : {}) };
  return withDark(raw, spec as WallpaperParamSpec);
}

/** Validates one `params[]` entry; pushes contract errors and returns the cleaned spec. */
export function validateParam(raw: unknown, index: number, errors: string[]): WallpaperParamSpec | null {
  const at = `params[${index}]`;
  if (!isRecord(raw)) return errors.push(`${at}: must be an object`), null;
  if (typeof raw.key !== "string" || !KEY.test(raw.key)) errors.push(`${at}.key: must match ${KEY.source}`);
  if (!validLabel(raw.label)) errors.push(`${at}.label: needs non-empty en and ko`);
  if (raw.control !== undefined && raw.type !== "number") errors.push(`${at}.control: only number params take a control`);
  const base = { key: raw.key, label: raw.label };
  switch (raw.type) {
    case "number": return numberParam(raw, base, errors, at);
    case "enum": return enumParam(raw, base, errors, at);
    case "palette": return paletteParam(raw, base, errors, at);
    case "boolean":
      defaults(raw, (value) => typeof value === "boolean", "must be a boolean", errors, at);
      return withDark(raw, { ...base, type: "boolean", default: raw.default } as WallpaperParamSpec);
    case "color":
      defaults(raw, isWallpaperHex, "must be #RRGGBB", errors, at);
      return withDark(raw, { ...base, type: "color", default: raw.default } as WallpaperParamSpec);
    default:
      errors.push(`${at}.type: unknown ${String(raw.type)}`);
      return null;
  }
}
