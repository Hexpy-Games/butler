import { useRef, type CSSProperties, type ReactNode } from "react";
import { Skeleton } from "../../components/Skeleton";
import { dsClass, dsStyle } from "../../lib/internal";
import { placeAxisLabels, skeletonHeights, type UsageBarsColumn, type UsageBarsColumnSegment } from "./usageBarsLayout";
import type { UsageBarsAxisLabel, UsageBarsBucket, UsageBarsSize } from "./usageBarsTypes";
import { useAxisLabelFit } from "./useAxisLabelFit";
import { USAGE_BARS_COLUMN_ATTRIBUTE, USAGE_BARS_HATCH_ATTRIBUTE } from "./useUsageBarsMotion";
import styles from "./UsageBars.module.css";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/**
 * One segment. Painted leaves carry data-pattern: a solid segment, a whole
 * hatched one (all subtask, or merged into its larger hatched part), or a
 * split pair with the hatched subtask part on top and no gap between.
 */
function UsageBarsSegmentView({ segment, hatchKey }: { segment: UsageBarsColumnSegment; hatchKey: string }) {
  const share = { "--usage-bars-share": segment.share } as Vars;
  const hatch = { [USAGE_BARS_HATCH_ATTRIBUTE]: hatchKey };
  if (segment.subtask <= 0) return <span className={styles.segment} data-color={segment.color} data-pattern="solid" style={share} />;
  if (segment.subtask >= 1) {
    return <span className={styles.segment} data-color={segment.color} data-pattern="hatched" {...hatch} style={share} />;
  }
  return (
    <span className={styles.segment} data-color={segment.color} data-split="true" style={share}>
      <span className={styles.part} data-pattern="solid" style={{ "--usage-bars-part": 1 - segment.subtask } as Vars} />
      <span className={styles.part} data-pattern="hatched" {...hatch} style={{ "--usage-bars-part": segment.subtask } as Vars} />
    </span>
  );
}

/** One stacked column; the segments share its height in proportion to their values, with no gaps. */
export function UsageBarsColumnView({ column, selected }: { column: UsageBarsColumn; selected: boolean }) {
  return (
    <div className={styles.slot}>
      <div className={styles.column} {...{ [USAGE_BARS_COLUMN_ATTRIBUTE]: "" }}
        data-zero={column.total > 0 ? undefined : "true"} data-selected={selected ? "true" : undefined}
        style={{ "--usage-bars-fraction": column.fraction } as Vars}>
        <div className={styles.stack}>
          {column.segments.map((segment) => (
            <UsageBarsSegmentView key={segment.id} segment={segment} hatchKey={`${column.key}/${segment.id}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Half and top gridlines across the plot. */
export function UsageBarsGridlines({ ticks, top }: { ticks: number[]; top: number }) {
  return ticks.map((tick) => (
    <span key={tick} className={styles.gridline} aria-hidden="true" style={{ "--usage-bars-fraction": tick / top } as Vars} />
  ));
}

/** Left gutter with 0, half and top values; as wide as its widest label. */
export function UsageBarsYAxis({ ticks, top, format }: { ticks: number[]; top: number; format: (value: number) => string }) {
  return (
    <div className={styles.yAxis} aria-hidden="true">
      {[0, ...ticks].map((tick) => (
        <span key={tick} className={styles.yLabel} style={{ "--usage-bars-fraction": tick / top } as Vars}>{format(tick)}</span>
      ))}
    </div>
  );
}

export function UsageBarsAxis({ labels, slots, size }: { labels: UsageBarsAxisLabel[]; slots: number; size: UsageBarsSize }) {
  const axisRef = useRef<HTMLDivElement>(null);
  const placed = placeAxisLabels(labels, slots, size);
  useAxisLabelFit(axisRef, placed.map((label) => `${label.left}:${label.text}`).join("|"));
  return (
    <div ref={axisRef} className={styles.axis} aria-hidden="true">
      {placed.map((label) => (
        <span key={label.key} className={styles.axisLabel} data-align={label.align}
          style={{ "--usage-bars-left": label.left } as Vars}>{label.text}</span>
      ))}
    </div>
  );
}

export function UsageBarsNote({ count, slots, children }: { count: number; slots: number; children: ReactNode }) {
  return <span className={styles.note} style={{ "--usage-bars-left": count / slots } as Vars}>{children}</span>;
}

export function UsageBarsSkeleton({ slots, label }: { slots: number; label?: string }) {
  return (
    <>
      {skeletonHeights(slots).map((height, index) => (
        <div key={index} className={styles.slot}>
          <Skeleton className={dsClass(styles.skeletonColumn)} style={dsStyle({ "--usage-bars-fraction": height })} />
        </div>
      ))}
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  );
}

/**
 * The data as a table for assistive tech: one row per bucket. The wrapper is
 * the sr-only box: a table grows to fit its rows and ignores the 1px size.
 */
export function UsageBarsTable({ caption, buckets }: { caption: string; buckets: UsageBarsBucket[] }) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.key}><th scope="row">{bucket.label}</th><td>{bucket.valueText}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
