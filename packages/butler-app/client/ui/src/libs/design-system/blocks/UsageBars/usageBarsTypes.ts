import type { ReactNode } from "react";
import type { DsPrivateStyleProps } from "../../lib/dsProps";

/** Existing chart tokens a series may use (`--context-chart-1` ... `--context-chart-6`). */
export type UsageBarsColor = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "chart-6";
export type UsageBarsSize = "popover" | "panel";
export type UsageBarsState = "ready" | "loading" | "empty";

/** One stacked series; the `series` order is the stacking order, bottom first. */
export interface UsageBarsSeries {
  id: string;
  color: UsageBarsColor;
  /** Legend name. The block draws no legend; product legends reuse the same list. */
  label: string;
}

export interface UsageBarsSegment {
  /** A `UsageBarsSeries.id`; segments with an unknown id or a value <= 0 are not drawn. */
  id: string;
  value: number;
}

export interface UsageBarsBucket {
  key: string;
  segments: UsageBarsSegment[];
  /** Row header of the screen-reader table and the selection announcement ("14:00–15:00"). */
  label: string;
  /** Formatted value of the row ("12.4K tokens"). */
  valueText: string;
}

export interface UsageBarsAxisLabel {
  /** Bucket index the label sits under. */
  index: number;
  text: string;
}

export interface UsageBarsYTicks {
  /** Formats the half and top gridline values ("2M", "4M"). */
  format: (value: number) => string;
}

export interface UsageBarsProps extends DsPrivateStyleProps {
  buckets: UsageBarsBucket[];
  series: UsageBarsSeries[];
  /** popover: 56px plot, columns up to 14px. panel: --chart-height-panel, columns up to 24px. Default popover. */
  size?: UsageBarsSize;
  /** Default ready. empty shows `emptyLabel` over a bare baseline. */
  state?: UsageBarsState;
  /** Controlled selection; omit to let the block keep its own. Null or out of range: nothing selected. */
  selectedIndex?: number | null;
  /** Hover, tap, arrow keys, Home/End, Esc and blur report the selected bucket here (null clears). */
  onSelect?: (index: number | null) => void;
  axisLabels?: UsageBarsAxisLabel[];
  /** The plot keeps at least this many column slots, so a few buckets do not stretch. Default 8. */
  minSlots?: number;
  /** Panel only: faint half and top gridlines with their values in a left gutter. */
  yTicks?: UsageBarsYTicks;
  /** Text centered in the plot when empty (state empty, or every bucket is zero). */
  emptyLabel?: ReactNode;
  /** Accessible name of the loading skeleton. */
  loadingLabel?: string;
  /** One muted caption after the last bar ("Just started"); for a few buckets only. */
  note?: ReactNode;
  /** Name of the chart group and caption of its screen-reader table. */
  ariaLabel: string;
}
