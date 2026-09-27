import type { ReactNode } from "react";
import { Typo } from "../Typo";
import { LegendSwatch } from "./LegendSwatch";
import styles from "./Chart.module.css";

export { LegendSwatch, type LegendSwatchProps } from "./LegendSwatch";

export const CHART_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6", "success", "warning", "danger"] as const;
export type ChartColor = (typeof CHART_COLORS)[number];

/** The token for a chart color: use it for Recharts fills and ChartConfig so bars match the legend. */
export function chartColor(color: ChartColor): string {
  return color.startsWith("chart-") ? `var(--context-${color})` : `var(--color-${color})`;
}

export interface ChartLegendItem {
  key: string;
  label: ReactNode;
  color: ChartColor;
  shape?: "dot" | "bar";
}

/** A wrapping row of labelled swatches for a chart's series. */
export function ChartLegend({ items }: { items: readonly ChartLegendItem[] }) {
  return (
    <ul className={styles.legend} data-slot="chart-legend">
      {items.map((item) => (
        <li key={item.key} className={styles.legendItem}>
          <LegendSwatch color={item.color} shape={item.shape} />
          <Typo.Caption>{item.label}</Typo.Caption>
        </li>
      ))}
    </ul>
  );
}
