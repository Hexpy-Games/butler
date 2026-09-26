import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./IconSlot.module.css";

/** `sidebar` follows the sidebar density icon size; the rest are `--icon-size-*`. */
export type IconSlotSize = "sidebar" | "xs" | "sm" | "md" | "lg";

export interface IconSlotProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  children: ReactNode;
  size?: IconSlotSize;
  /** Keep at least one line box tall so the slot sits on the text baseline row. */
  minHeight?: "line";
  /** Let pointer events pass through to the row beneath (status glyphs). */
  passive?: boolean;
  /** Glyph color; omit to inherit the row color. */
  tone?: "secondary" | "tertiary";
}

/** A fixed square that centers one glyph: row glyphs, status marks, timeline markers. */
export function IconSlot({ children, size = "md", minHeight, passive = false, tone, className, ...props }: IconSlotProps) {
  return (
    <span
      className={cn(styles.slot, className)}
      data-slot="icon-slot"
      data-size={size}
      data-min-height={minHeight}
      data-passive={passive ? "true" : undefined}
      data-tone={tone}
      {...props}
    >
      {children}
    </span>
  );
}
