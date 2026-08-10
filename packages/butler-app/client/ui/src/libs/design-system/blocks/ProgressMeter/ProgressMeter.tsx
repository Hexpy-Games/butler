import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ProgressMeter.module.css";

export interface ProgressMeterProps {
  label: ReactNode;
  value: number;
  meta?: ReactNode;
  ariaLabel?: string;
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
}

export function ProgressMeter({
  label,
  value,
  meta,
  ariaLabel,
  tone = "default",
  className,
}: ProgressMeterProps) {
  const normalized = Math.max(0, Math.min(100, value));

  return (
    <Stack gap="xs" className={cn(styles.root, className)}>
      <Stack align="row" justify="between" cross="center" gap="sm">
        <Typo.Caption className={styles.label}>{label}</Typo.Caption>
        <Typo.Caption className={styles.meta}>{meta ?? `${normalized}%`}</Typo.Caption>
      </Stack>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={normalized}
      >
        <span className={cn(styles.fill, styles[tone])} style={{ width: `${normalized}%` }} />
      </div>
    </Stack>
  );
}
