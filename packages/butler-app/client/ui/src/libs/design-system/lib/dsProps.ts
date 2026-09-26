/**
 * Public prop contracts for DS components and blocks.
 *
 * Product code styles DS components only through their props. `className`
 * and `style` are not part of the public DS types: `DsBaseProps` omits them
 * and re-adds them as private slots whose types (`DsClassName`, `DsStyle`)
 * only `lib/internal` can produce. Geometry that is genuinely data-driven
 * goes through `UNSAFE_style` on the few components that offer it; every
 * product use is allowlisted per file (`butler-ds/unsafe-style-allowlist`).
 */
import type { CSSProperties } from "react";
import type { DsClassName, DsStyle } from "./internal";

/** DS-private styling slots; values come only from `dsClass()` / `dsStyle()`. */
export interface DsPrivateStyleProps {
  /** DS-internal only (`dsClass()` from lib/internal). Product code styles DS components through props. */
  className?: DsClassName;
  /** DS-internal only (`dsStyle()` from lib/internal). Product geometry uses `UNSAFE_style` where offered. */
  style?: DsStyle;
}

/** DOM/Radix attributes of a DS component without public `className` or `style`. */
export type DsBaseProps<Attributes> = Omit<Attributes, "className" | "style"> & DsPrivateStyleProps;

/** The only inline style product code may pass: geometry and custom properties. */
export type UnsafeStyle = Pick<
  CSSProperties,
  "width" | "height" | "minWidth" | "maxWidth" | "minHeight" | "maxHeight" | "transform" | "inset"
> & { [custom: `--${string}`]: string | number | undefined };

export interface UnsafeStyleProps {
  /**
   * Geometry escape hatch for data-driven sizes and positions (virtualized
   * rows, resizable panels). Every product use is allowlisted per file.
   */
  UNSAFE_style?: UnsafeStyle;
}

/** Style for the root element: DS-internal style first, then product geometry. */
export function withUnsafeStyle(style: CSSProperties | undefined, unsafe: UnsafeStyle | undefined): CSSProperties | undefined {
  if (!unsafe) return style;
  return { ...style, ...(unsafe as CSSProperties) };
}
