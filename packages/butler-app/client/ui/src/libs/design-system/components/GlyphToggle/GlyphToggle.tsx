import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { IconButton } from "../IconButton";
import styles from "./GlyphToggle.module.css";

export interface GlyphToggleProps extends Omit<DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>, "children"> {
  /** The row glyph shown at rest. */
  glyph: ReactNode;
  /** The toggle glyph shown on hover and keyboard focus (for example a star). */
  toggleGlyph: ReactNode;
  pressed: boolean;
  /** Accessible name of the toggle, including its state. */
  label: string;
}

/**
 * A row glyph that doubles as a toggle: it keeps the glyph's column width,
 * shows the toggle glyph on hover and focus, and keeps a full hit target.
 */
export function GlyphToggle({ glyph, toggleGlyph, pressed, label, className, ...props }: GlyphToggleProps) {
  return (
    <span className={cn(styles.slot, className)} data-slot="glyph-toggle">
      <IconButton className={dsClass(styles.toggle)} aria-pressed={pressed} label={label} {...props}>
        <span className={styles.glyph}>{glyph}</span>
        <span className={styles.toggleGlyph}>{toggleGlyph}</span>
      </IconButton>
    </span>
  );
}
