// Optional manifest fields of contract v1 amendments: two-pass modules, pixel ratio, image dim, default image, scene tone.
import { isRecord } from "./manifestParams";
import type { WallpaperManifest, WallpaperParamSpec } from "./types";

type Options = Pick<WallpaperManifest, "overlay" | "pixelRatio" | "imageDim" | "defaultImage" | "sceneTone">;

const PIXEL_RATIOS = new Set<unknown>(["default", "device"]);
const IMAGE_DIMS = new Set<unknown>(["auto", "noDarkStep", "none"]);
/** A file beside `shader.frag`: no directories. */
const IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(?:jpe?g|png|webp)$/u;
const MAX_DARK_PHASES = 4;

function validPhase(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [start, end] = value as unknown[];
  return typeof start === "number" && typeof end === "number" && start >= 0 && start < end && end <= 1;
}

function sceneTone(raw: unknown, params: readonly WallpaperParamSpec[], errors: string[]): Options["sceneTone"] {
  if (!isRecord(raw)) return errors.push("sceneTone: must be an object"), undefined;
  const { param, darkPhases } = raw;
  const spec = params.find((entry) => entry.key === param);
  if (spec?.type !== "boolean") errors.push("sceneTone.param: must name a boolean param");
  const phases = Array.isArray(darkPhases) && darkPhases.length > 0 && darkPhases.length <= MAX_DARK_PHASES && darkPhases.every(validPhase);
  if (!phases) errors.push(`sceneTone.darkPhases: 1 to ${MAX_DARK_PHASES} [start, end) ranges with 0 <= start < end <= 1`);
  return { param: param as string, darkPhases: (phases ? darkPhases : []) as Array<[number, number]> };
}

/** Validates the optional fields; pushes contract errors and returns the ones present. */
export function validateManifestOptions(raw: Record<string, unknown>, params: readonly WallpaperParamSpec[], errors: string[]): Options {
  const options: Options = {};
  const { overlay, pixelRatio, imageDim, defaultImage } = raw;
  if (overlay !== undefined) {
    if (typeof overlay === "boolean") options.overlay = overlay;
    else errors.push("overlay: must be a boolean");
  }
  if (pixelRatio !== undefined) {
    if (PIXEL_RATIOS.has(pixelRatio)) options.pixelRatio = pixelRatio as Options["pixelRatio"];
    else errors.push("pixelRatio: must be default or device");
  }
  if (imageDim !== undefined) {
    if (IMAGE_DIMS.has(imageDim)) options.imageDim = imageDim as Options["imageDim"];
    else errors.push("imageDim: must be auto, noDarkStep or none");
  }
  if (defaultImage !== undefined) {
    if (typeof defaultImage !== "string" || !IMAGE_FILE.test(defaultImage)) errors.push("defaultImage: must be a .jpg, .png or .webp file name beside shader.frag");
    else if (raw.image === "none") errors.push("defaultImage: needs image optional or required");
    else options.defaultImage = defaultImage;
  }
  if (raw.sceneTone !== undefined) options.sceneTone = sceneTone(raw.sceneTone, params, errors);
  return options;
}
