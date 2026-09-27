import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./IconTile.module.css";

/** `sm` 28px, `md` 36px (default), `lg` 56px, `xl` 64px. */
export type IconTileSize = "sm" | "md" | "lg" | "xl";
/** `neutral` raised square, `accent` info tint, `danger` error glyph, `plain` no surface. */
export type IconTileTone = "neutral" | "accent" | "danger" | "plain";

export interface IconTileProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  /** One icon, ProviderLogo or ButlerThinkingMark. */
  children: ReactNode;
  size?: IconTileSize;
  tone?: IconTileTone;
}

/**
 * A rounded square that holds one glyph: a service logo on a choice card, a
 * point in a consent list, the state glyph of a sign-in or setup screen.
 * Decorative; the text beside it carries the meaning.
 */
export function IconTile({ children, size = "md", tone = "neutral", className, ...props }: IconTileProps) {
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn(styles.tile, className)}
      data-size={size}
      data-slot="icon-tile"
      data-tone={tone}
    >
      {children}
    </span>
  );
}
