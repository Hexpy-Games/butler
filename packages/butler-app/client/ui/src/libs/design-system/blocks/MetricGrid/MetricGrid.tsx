import type { ReactNode } from "react";
import { Grid, type GridColumnPreset, type GridResponsiveColumns } from "../../components/Grid";
import { cn } from "../../lib/utils";
import styles from "./MetricGrid.module.css";

export interface MetricGridProps {
  /** MetricCard children */
  children: ReactNode;
  /** Grid column preset or `{ base, wide }`; default fills 150px+ columns. */
  columns?: GridColumnPreset | GridResponsiveColumns;
  /** Additional CSS class */
  className?: string;
}

export function MetricGrid({
  children,
  columns,
  className,
}: MetricGridProps) {
  return (
    <Grid
      gap="md"
      columns={columns}
      className={cn(!columns && styles.grid, className)}
      data-slot="metric-grid"
    >
      {children}
    </Grid>
  );
}
