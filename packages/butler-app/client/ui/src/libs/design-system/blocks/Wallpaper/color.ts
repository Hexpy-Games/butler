const HEX = /^#[0-9a-f]{6}$/iu;

export function isWallpaperHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** A list of exactly `size` `#RRGGBB` colors. */
export function isWallpaperHexList(value: unknown, size: number): value is string[] {
  return Array.isArray(value) && value.length === size && value.every(isWallpaperHex);
}

export function normalizeWallpaperHex(value: string): string {
  return value.toLowerCase();
}

/** sRGB channels in 0..1. */
export function wallpaperHexToRgb(value: string): [number, number, number] {
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ];
}
