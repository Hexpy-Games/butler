import type { ReactNode } from "react";
import { AnimatedNumber } from "../../components/AnimatedNumber";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./MetricCard.module.css";

export interface MetricCardProps {
  /** Metric value; numbers count to new values through AnimatedNumber. */
  value: string | number;
  /** Formats a numeric value (for example compact notation). */
  format?: (value: number) => string;
  /** Metric label */
  label: string;
  /** Optional trend direction */
  trend?: "up" | "down" | "neutral";
  /** Optional change indicator (e.g., "+12%") */
  change?: string;
  /** Optional icon */
  icon?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export function MetricCard({
  value,
  format,
  label,
  trend,
  change,
  icon,
  className,
}: MetricCardProps) {
  return (
    <Stack gap="xs" className={cn(styles.card, className)}>
      <Stack align="row" justify="between" cross="center">
        <Typo.MetricValue className={styles.value} numeric="tabular" data-slot="metric-value">
          {typeof value === "number" ? <AnimatedNumber value={value} format={format} /> : value}
        </Typo.MetricValue>
        {icon && <span className={cn(styles.icon, trend && styles[`trend-${trend}`])}>{icon}</span>}
      </Stack>
      <Typo.Caption className={styles.label} data-slot="metric-label">{label}</Typo.Caption>
      {change && (
        <Typo.Caption className={cn(styles.change, trend && styles[`trend-${trend}`])}>
          {change}
        </Typo.Caption>
      )}
    </Stack>
  );
}
