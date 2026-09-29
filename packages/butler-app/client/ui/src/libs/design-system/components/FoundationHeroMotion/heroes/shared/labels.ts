import { contrast } from "./measure";
import type { Label, Measured } from "./types";

/** A token and the contrast of its text on the flattened background behind it: the token, then the ratio as it applies. */
export function ratioLabel(token: string, inline = false): Label {
  return (m: Measured, _marks, layout) => {
    const ratio = contrast(m.color, m.bg);
    if (!ratio) return [token];
    if (inline) return [layout === "tall" ? `${ratio}:1` : `${token} ${ratio}:1`];
    return [token, `${token} · ${ratio}:1`];
  };
}

const SPACE: Record<number, string> = { 4: "xs", 8: "sm", 12: "md", 16: "lg", 20: "xl", 24: "2xl", 32: "3xl", 40: "4xl" };

/** The --space-* token of a length, or the length itself when no step matches. */
export function spaceToken(px: number): string {
  const name = SPACE[Math.round(px)];
  return name ? `--space-${name}` : `${Math.round(px)}px`;
}

/**
 * The measured value of an annotation (its gap, padding, size…) under a
 * token: the token, then the value counting in; nothing when the value is 0.
 * `token` may name the token from the value (spaceToken).
 */
export function valueLabel(token: string | ((value: number) => string), inline = false, unit = ""): Label {
  return (m: Measured, _marks, layout) => {
    const value = Math.round((m.value ?? 0) * 10) / 10;
    if (value <= 0) return [];
    const name = typeof token === "string" ? token : token(value);
    if (inline) return [layout === "tall" ? `${value}${unit}` : `${name} ${value}${unit}`];
    return [name, `${name} · ${value}${unit}`];
  };
}

const HEIGHT: Record<number, string> = {
  24: "--control-height-xs", 28: "--control-height-sm", 30: "--control-height-md", 34: "--control-height-lg", 44: "--touch-target", 48: "--titlebar-height",
};

/** The control-height (or touch, titlebar) token of a height, or the height itself. */
export function heightToken(px: number): string {
  return HEIGHT[Math.round(px)] ?? `${Math.round(px)}px`;
}

/** A token and a measured length (px), the length counting in as it applies; nothing when the length is zero. */
export function lengthLabel(token: string, read: (m: Measured) => number, inline = false): Label {
  return (m: Measured, _marks, layout) => {
    const value = Math.round(read(m));
    if (value <= 0) return [];
    if (inline) return [layout === "tall" ? `${value}` : `${token} ${value}`];
    return [token, `${token} · ${value}`];
  };
}
