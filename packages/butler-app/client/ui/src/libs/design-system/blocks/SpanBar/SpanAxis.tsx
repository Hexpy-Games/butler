import { useEffect, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { Typo } from "../../components/Typo";
import { dsClass, dsStyle } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { formatSpanMs, spanLevel, spanTicks } from "./spanGeometry";
import styles from "./SpanBar.module.css";

/** Room one tick label needs, start to start ("7.11초" at caption size plus a gap). */
const LABEL_SPACING_PX = 64;

export interface SpanAxisProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** The whole trace, the same `total` every SpanBar of the trace gets. */
  total: number;
  /** Interior tick values; default 1·2·5 steps. 0 and the total are always shown. */
  ticks?: readonly number[];
  /** Tick label, e.g. ms → "2초". Default: "412ms" / "2s". */
  format?: (value: number) => string;
  /**
   * disclosure: starts where a DisclosureRow's description starts (row-indent SpanRows).
   * row: spans the row inside its inset, as the `bar` of a DisclosureRow does (text-indent
   * SpanRows); maxDepth does not apply.
   */
  inset?: "none" | "disclosure" | "row";
  /** Row-indent traces: the deepest level, as passed to every SpanRow, so the axis moves with the bars. */
  maxDepth?: number;
}

/**
 * Time labels for a trace's shared axis: 0 at the start, the total at the
 * end, round steps between. Visual only (aria-hidden); every SpanBar carries
 * its own spoken label.
 */
export function SpanAxis({
  total, ticks, format = formatSpanMs, inset = "none", maxDepth = 0, className, style, ...props
}: SpanAxisProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const width = useTrackWidth(ref);
  // Before the first measure (or without layout) assume room for four steps.
  const values = spanTicks(total, ticks, width > 0 ? Math.min(1, LABEL_SPACING_PX / width) : undefined);
  const last = values.length - 1;
  return (
    <div {...props} className={cn(styles.axis, className)} data-slot="span-axis" data-inset={inset} aria-hidden="true"
      style={dsStyle({ ...style, "--span-max-depth": spanLevel(maxDepth) })}>
      <span ref={ref} className={styles.axisTrack}>
        {values.map((value, position) => (
          <Typo.Caption key={value} tone="tertiary" numeric="tabular" className={dsClass(styles.tick)}
            data-edge={position === 0 ? "start" : position === last ? "end" : undefined}
            style={dsStyle({ "--span-tick": `${total > 0 ? (value / total) * 100 : 0}%` })}>
            {format(value)}
          </Typo.Caption>
        ))}
      </span>
    </div>
  );
}

/** The axis width, live: tick density follows it. */
function useTrackWidth(ref: RefObject<HTMLSpanElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
