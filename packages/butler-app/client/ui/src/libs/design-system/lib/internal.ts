/**
 * DS-internal styling capability. Only design-system code may import this
 * module (ESLint `no-restricted-imports` blocks it everywhere else).
 *
 * Public DS component types drop `className` and `style`
 * (`DsBaseProps`, lib/dsProps.ts) and keep them only as private slots typed
 * `DsClassName` / `DsStyle`. Those brands can only be minted here, so DS
 * internals compose other DS components with `className={dsClass(...)}` and
 * `style={dsStyle(...)}` while product code cannot style a DS component at
 * all: it uses props, or `UNSAFE_style` (geometry only) where a component
 * offers it.
 */
import type { CSSProperties } from "react";
import type { ClassValue } from "clsx";
import { cn } from "./utils";

declare const dsClassBrand: unique symbol;
declare const dsStyleBrand: unique symbol;

/** A class list only DS code can produce (see `dsClass`). */
export type DsClassName = string & { readonly [dsClassBrand]: true };
/** A style object only DS code can produce (see `dsStyle`). */
export type DsStyle = CSSProperties & { readonly [dsStyleBrand]: true };

type StyleInput = CSSProperties & { [custom: `--${string}`]: string | number | undefined };

/** Merge classes (like `cn`) for a DS component rendered by DS code. */
export function dsClass(...inputs: ClassValue[]): DsClassName {
  return cn(...inputs) as DsClassName;
}

/** Pass a style to a DS component rendered by DS code (custom properties allowed). */
export function dsStyle(style: CSSProperties | StyleInput | undefined): DsStyle | undefined {
  return style as DsStyle | undefined;
}
