import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Grid, type GridColumnPreset, type GridResponsiveColumns } from "../../components/Grid";
import styles from "./MetricGrid.module.css";
import { dsClass } from "../../lib/internal";

export interface MetricGridProps extends DsPrivateStyleProps {
  /** MetricCard children */
  children: ReactNode;
  /** Grid column preset or `{ base, wide }`; default fills 150px+ columns. Ignored by `joined`. */
  columns?: GridColumnPreset | GridResponsiveColumns;
  /**
   * `cards` (default): separate cards in a grid. `joined`: one card split by
   * hairlines; tiles grow from ~136px so every wrapped row fills its width.
   */
  variant?: "cards" | "joined";
}

export function MetricGrid({
  children,
  columns,
  variant = "cards",
  className,
}: MetricGridProps) {
  if (variant === "joined") {
    return <div className={dsClass(styles.joined, className)} data-slot="metric-grid" data-variant="joined">{children}</div>;
  }
  return (
    <Grid
      gap="md"
      columns={columns}
      className={dsClass(!columns && styles.grid, className)}
      data-slot="metric-grid"
    >
      {children}
    </Grid>
  );
}
