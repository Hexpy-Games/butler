import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsStyle } from "../../lib/internal";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { cn } from "../../lib/utils";
import { spanFraction, spanLevel } from "./spanGeometry";
import styles from "./SpanBar.module.css";

export type SpanBarTone = "default" | "parent" | "danger" | "warning" | "muted";

/** Rows past this index arrive together, so a long trace never waits on its stagger. */
const STAGGER_ROWS = 12;

export interface SpanBarProps extends Omit<DsBaseProps<HTMLAttributes<HTMLSpanElement>>, "children"> {
  /** Start of the span, in the same unit as `total` (ms from the trace start). */
  offset: number;
  duration: number;
  /** The whole trace; every bar of a trace shares it, so bars line up on one axis. */
  total: number;
  /** default: a leaf span; parent: a span that contains others; muted: a secondary leaf. */
  tone?: SpanBarTone;
  /** Row position; staggers the grow-in by --motion-stagger-row per row. */
  index?: number;
  /** Spoken text for the bar, e.g. "시작 +0.58초, 2.00초". Without it the bar is hidden from assistive tech. */
  label?: string;
}

/**
 * One span on a trace's shared time axis: a pill on a 6px track, placed by
 * its start offset and sized by its duration (at least 3px). Spans-only:
 * no text, no interaction; the row around it owns both.
 */
export function SpanBar({ offset, duration, total, tone = "default", index = 0, label, className, ...props }: SpanBarProps) {
  const reduced = useReducedMotion();
  const { start, width } = spanFraction(offset, duration, total);
  const geometry = dsStyle({
    "--span-start": `${start * 100}%`,
    "--span-width": `${width * 100}%`,
    "--span-stagger": Math.min(spanLevel(index), STAGGER_ROWS),
  });
  return (
    <span {...props} className={cn(styles.root, className)} data-slot="span-bar" data-tone={tone}>
      <span className={styles.track} aria-hidden="true">
        <span className={styles.bar} style={geometry} data-reduced={reduced ? "true" : undefined} />
      </span>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export interface SpanRowProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /** Nesting level of the span (0 for a root span); indents the row 16px per level. */
  depth?: number;
  /**
   * The trace's deepest level, the same on every row and on the SpanAxis.
   * When the deepest indent would pass the row's inner inset, the shared
   * axis moves right by the difference, so no bar leaves its row.
   */
  maxDepth?: number;
  children: ReactNode;
}

/**
 * One trace row (usually a DisclosureRow) indented by its depth. A SpanBar
 * inside reaches back to the shared axis, so every row's bar lines up while
 * titles show the nesting; the bar never leaves the row's inner inset.
 */
export function SpanRow({ depth = 0, maxDepth = 0, children, className, style, ...props }: SpanRowProps) {
  const level = spanLevel(depth);
  return (
    <div {...props} className={cn(styles.row, className)} data-slot="span-row" data-depth={level}
      style={dsStyle({ ...style, "--span-depth": level, "--span-max-depth": spanLevel(maxDepth) })}>
      {children}
    </div>
  );
}
