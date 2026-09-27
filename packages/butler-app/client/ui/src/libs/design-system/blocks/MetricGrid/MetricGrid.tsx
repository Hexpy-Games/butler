import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Grid, type GridColumnPreset, type GridResponsiveColumns } from "../../components/Grid";
import styles from "./MetricGrid.module.css";
import { dsClass } from "../../lib/internal";

export interface MetricGridProps extends DsPrivateStyleProps {
  /** MetricCard children */
  children: ReactNode;
  /** Grid column preset or `{ base, wide }`; default fills 150px+ columns. */
  columns?: GridColumnPreset | GridResponsiveColumns;
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
      className={dsClass(!columns && styles.grid, className)}
      data-slot="metric-grid"
    >
      {children}
    </Grid>
  );
}
