import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./MetricCard.module.css";

export interface MetricCardProps {
  /** Metric value */
  value: string | number;
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
  label,
  trend,
  change,
  icon,
  className,
}: MetricCardProps) {
  return (
    <Stack gap="xs" className={cn(styles.card, className)}>
      <Stack align="row" justify="between" cross="center">
        <Typo.MetricValue className={styles.value}>{value}</Typo.MetricValue>
        {icon && <span className={cn(styles.icon, trend && styles[`trend-${trend}`])}>{icon}</span>}
      </Stack>
      <Typo.Caption className={styles.label}>{label}</Typo.Caption>
      {change && (
        <Typo.Caption className={cn(styles.change, trend && styles[`trend-${trend}`])}>
          {change}
        </Typo.Caption>
      )}
    </Stack>
  );
}
