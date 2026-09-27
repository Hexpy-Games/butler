import type { ChartColor } from "./ChartLegend";
import styles from "./Chart.module.css";

export interface LegendSwatchProps {
  color: ChartColor;
  /** `dot` for points and bars in a key, `bar` for a series line or stacked band. */
  shape?: "dot" | "bar";
}

/** A decorative color key; pair it with a text label. */
export function LegendSwatch({ color, shape = "dot" }: LegendSwatchProps) {
  return <span className={styles.swatch} data-slot="legend-swatch" data-color={color} data-shape={shape} aria-hidden="true" />;
}
