// WCAG 2.x contrast from computed colors. The Color chapter reads each
// foreground and surface with getComputedStyle, flattens translucent layers
// over the opaque base they sit on, and grades the ratio.

export interface Rgba { r: number; g: number; b: number; a: number }

/** `rgb()`/`rgba()` or `color(srgb …)` as computed by the browser; null for anything else. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim();
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/u.exec(text);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha(rgb[4]) };
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/u.exec(text);
  if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: alpha(srgb[4]) };
  return null;
}

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  return value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
}

/** Paints `top` over `bottom` (source-over); the result is opaque when `bottom` is. */
export function flatten(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (front: number, back: number) => (front * top.a + back * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = luminance(flatten(foreground, background));
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

export type ContrastGrade = "AAA" | "AA" | "AA large" | "Fail";

/** Body text needs 4.5:1 (AA) or 7:1 (AAA); large text and UI glyphs need 3:1. */
export function contrastGrade(ratio: number): ContrastGrade {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA large";
  return "Fail";
}

export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

/** The ink (near-black or white) that reads best on a swatch. */
export function inkOn(background: Rgba): "dark" | "light" {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  return contrastRatio(black, background) >= contrastRatio(white, background) ? "dark" : "light";
}
