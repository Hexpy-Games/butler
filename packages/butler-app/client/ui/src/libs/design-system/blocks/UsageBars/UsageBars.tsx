import { useMemo, useRef, type CSSProperties } from "react";
import { cn } from "../../lib/utils";
import { usageBarsGeometry } from "./usageBarsLayout";
import type { UsageBarsProps } from "./usageBarsTypes";
import {
  UsageBarsAxis, UsageBarsColumnView, UsageBarsGridlines, UsageBarsNote, UsageBarsSkeleton, UsageBarsTable, UsageBarsYAxis,
} from "./UsageBarsParts";
import { useUsageBarsMotion } from "./useUsageBarsMotion";
import { useUsageBarsSelection } from "./useUsageBarsSelection";
import styles from "./UsageBars.module.css";

export type {
  UsageBarsAxisLabel, UsageBarsBucket, UsageBarsColor, UsageBarsProps, UsageBarsSegment, UsageBarsSeries, UsageBarsSize,
  UsageBarsState, UsageBarsYTicks,
} from "./usageBarsTypes";

const DEFAULT_MIN_SLOTS = 8;

/**
 * Stacked usage columns over time: a 56px popover strip or a panel chart with
 * y ticks. Presenter only: buckets, series colors, labels and copy come from
 * props; the selected bucket's readout lives in the caller (no tooltip). One
 * tab stop; arrows move the selection.
 */
export function UsageBars({
  buckets, series, size = "popover", state = "ready", selectedIndex, onSelect, axisLabels = [], minSlots = DEFAULT_MIN_SLOTS,
  yTicks, emptyLabel, loadingLabel, note, ariaLabel, className, style,
}: UsageBarsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const ticks = size === "panel" && yTicks !== undefined;
  const geometry = useMemo(
    () => usageBarsGeometry(state === "ready" ? buckets : [], series, { minSlots: Math.max(minSlots, buckets.length), ticks }),
    [buckets, minSlots, series, state, ticks],
  );
  const ready = state === "ready" && !geometry.blank;
  const count = ready ? geometry.columns.length : 0;
  const { selected, plotHandlers, rootHandlers } = useUsageBarsSelection({
    count, slots: geometry.slots, selectedIndex, onSelect, rootRef, plotRef,
  });
  const signature = useMemo(() => geometry.columns.map((column) => column.fraction.toFixed(4)).join(","), [geometry]);
  useUsageBarsMotion(plotRef, ready, signature);
  const selectedBucket = selected === null ? undefined : buckets[selected];

  return (
    <div ref={rootRef} className={cn(styles.root, className)} style={style} data-slot="usage-bars" data-size={size}
      data-state={state} data-ticks={ticks && ready ? "true" : undefined} data-selected={selected === null ? undefined : "true"}
      role={state === "loading" ? "status" : "group"} aria-label={ariaLabel} aria-busy={state === "loading" || undefined}
      tabIndex={ready ? 0 : undefined} {...(ready ? rootHandlers : {})}>
      {ticks && ready ? <UsageBarsYAxis ticks={geometry.ticks} top={geometry.top} format={yTicks.format} /> : null}
      <div ref={plotRef} className={styles.plot} style={{ "--usage-bars-slots": geometry.slots } as CSSProperties}
        {...(ready ? plotHandlers : {})}>
        {state === "loading" ? <UsageBarsSkeleton slots={geometry.slots} label={loadingLabel} /> : null}
        {ready ? <UsageBarsGridlines ticks={geometry.ticks} top={geometry.top} /> : null}
        {ready ? geometry.columns.map((column, index) => (
          <UsageBarsColumnView key={column.key} column={column} selected={index === selected} />
        )) : null}
        {ready && note ? <UsageBarsNote count={count} slots={geometry.slots}>{note}</UsageBarsNote> : null}
        {state !== "loading" && !ready && emptyLabel ? <span className={styles.empty}>{emptyLabel}</span> : null}
      </div>
      <UsageBarsAxis labels={state === "loading" ? [] : axisLabels} slots={geometry.slots} size={size} />
      {ready ? <UsageBarsTable caption={ariaLabel} buckets={buckets} /> : null}
      {ready ? (
        <span className="sr-only" aria-live="polite">
          {selectedBucket ? `${selectedBucket.label}, ${selectedBucket.valueText}` : ""}
        </span>
      ) : null}
    </div>
  );
}
