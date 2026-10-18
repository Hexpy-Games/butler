import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsStyle } from "../../lib/internal";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { cn } from "../../lib/utils";
import { DisclosureRowIndent } from "../DisclosureRow/DisclosureRowIndent";
import { spanFraction, spanLevel, spanPieces, type SpanSegmentInput } from "./spanGeometry";
import styles from "./SpanBar.module.css";

/**
 * What a span is (model, tool, app, agent) or its status (error, wait);
 * each maps to its --trace-* fill and -alt hatch partner.
 */
export type SpanBarTone = "model" | "tool" | "app" | "agent" | "error" | "wait";

/** A direct child of the span: where it sits on the trace and its tone. */
export type SpanBarSegment = SpanSegmentInput<SpanBarTone>;

/** Rows past this index arrive together, so a long trace never waits on its stagger. */
const STAGGER_ROWS = 12;

/** Text-indent mode indents at most this many levels; deeper rows show a depth cue instead. */
export const SPAN_TEXT_INDENT_CAP = 3;

export interface SpanBarProps extends Omit<DsBaseProps<HTMLAttributes<HTMLSpanElement>>, "children"> {
  /** Start of the span, in the same unit as `total` (ms from the trace start). */
  offset: number;
  duration: number;
  /** The whole trace; every bar of a trace shares it, so bars line up on one axis. */
  total: number;
  /** The span's own fill, and the fill of its time no child covers. Default `model`. */
  tone?: SpanBarTone;
  /**
   * One per direct child, in trace time. The whole span stays filled; each
   * child paints its piece, adjacent children alternating solid and hatch.
   */
  segments?: readonly SpanBarSegment[];
  /** Row position; staggers the grow-in by --motion-stagger-row per row. */
  index?: number;
  /** Spoken text for the bar, e.g. "시작 +0.58초, 2.00초". Without it the bar is hidden from assistive tech. */
  label?: string;
}

/**
 * One span on a trace's shared time axis: a pill on a 6px track, placed by
 * its start offset and sized by its duration (at least 3px). With segments,
 * the pill is split into its children's pieces: rounded outer ends, square
 * inner joints. Spans-only: no text, no interaction; the row owns both.
 */
export function SpanBar({
  offset, duration, total, tone = "model", segments, index = 0, label, className, ...props
}: SpanBarProps) {
  const reduced = useReducedMotion();
  const { start, width } = spanFraction(offset, duration, total);
  const pieces = segments?.length ? spanPieces(start * total, width * total, tone, segments) : [];
  const geometry = dsStyle({
    "--span-start": `${start * 100}%`,
    "--span-width": `${width * 100}%`,
    "--span-stagger": Math.min(spanLevel(index), STAGGER_ROWS),
  });
  return (
    <span {...props} className={cn(styles.root, className)} data-slot="span-bar" data-tone={tone}>
      <span className={styles.track} aria-hidden="true">
        <span className={styles.bar} style={geometry} data-tone={tone} data-reduced={reduced ? "true" : undefined}>
          {pieces.map((piece) => (
            <span key={piece.start} className={styles.piece} data-tone={piece.tone}
              data-hatch={piece.hatch ? "true" : undefined}
              style={dsStyle({ "--piece-start": `${piece.start * 100}%`, "--piece-width": `${piece.width * 100}%` })} />
          ))}
        </span>
      </span>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export interface SpanRowProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /** Nesting level of the span (0 for a root span). */
  depth?: number;
  /**
   * The trace's deepest level, the same on every row and on the SpanAxis.
   * Row indent only: when the deepest indent would pass the row's inner
   * inset, the shared axis moves right by the difference.
   */
  maxDepth?: number;
  /**
   * row (default): the whole row indents 16px per level and its bar reaches
   * back to the shared axis. text: only the row's text indents (16px per
   * level, at most 3); the fill and the bar keep the full width.
   */
  indent?: "row" | "text";
  /** Text indent only: the cue a row deeper than 3 levels shows after its description, e.g. (5) => "깊이 5". */
  depthLabel?: (depth: number) => ReactNode;
  children: ReactNode;
}

/**
 * One trace row (usually a DisclosureRow) at its nesting depth. Every row's
 * bar lines up on the shared axis while titles show the nesting.
 */
export function SpanRow({
  depth = 0, maxDepth = 0, indent = "row", depthLabel, children, className, style, ...props
}: SpanRowProps) {
  const level = spanLevel(depth);
  const text = indent === "text";
  const cue = text && level > SPAN_TEXT_INDENT_CAP ? depthLabel?.(level) : undefined;
  return (
    <div {...props} className={cn(styles.row, className)} data-slot="span-row" data-depth={level} data-indent={indent}
      style={dsStyle({ ...style, "--span-depth": level, "--span-max-depth": text ? 0 : spanLevel(maxDepth) })}>
      {text ? (
        <DisclosureRowIndent level={Math.min(level, SPAN_TEXT_INDENT_CAP)} cue={cue}>{children}</DisclosureRowIndent>
      ) : children}
    </div>
  );
}
