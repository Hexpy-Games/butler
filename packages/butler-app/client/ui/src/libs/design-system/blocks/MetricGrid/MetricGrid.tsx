import type { ReactNode } from "react";
import { Grid } from "../../components/Grid";
import { cn } from "../../lib/utils";
import styles from "./MetricGrid.module.css";

export interface MetricGridProps {
  /** MetricCard children */
  children: ReactNode;
  /** Number of columns (responsive default: 2-4) */
  columns?: number;
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
      className={cn(styles.grid, className)}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}
    >
      {children}
    </Grid>
  );
}
