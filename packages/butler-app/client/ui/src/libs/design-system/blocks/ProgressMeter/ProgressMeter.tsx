import type { CSSProperties, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ProgressMeter.module.css";

export interface ProgressMeterProps {
  /** Visible label; omit only with `bare`. */
  label?: ReactNode;
  value: number;
  meta?: ReactNode;
  ariaLabel?: string;
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
  /** Track only (4px), no label row; name it with `ariaLabel`. */
  bare?: boolean;
}

export function ProgressMeter({
  label,
  value,
  meta,
  ariaLabel,
  tone = "default",
  className,
  bare = false,
}: ProgressMeterProps) {
  const normalized = Math.max(0, Math.min(100, value));
  const track = (
    <div
      className={styles.track}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalized}
    >
      <span
        className={cn(styles.fill, styles[tone])}
        data-slot="progress-fill"
        style={{ "--progress-scale": normalized / 100 } as CSSProperties}
      />
    </div>
  );
  if (bare) {
    return <div className={cn(styles.root, className)} data-bare="true">{track}</div>;
  }

  return (
    <Stack gap="xs" className={cn(styles.root, className)}>
      <Stack align="row" justify="between" cross="center" gap="sm">
        <Typo.Caption className={styles.label}>{label}</Typo.Caption>
        <Typo.Caption className={styles.meta}>{meta ?? `${normalized}%`}</Typo.Caption>
      </Stack>
      {track}
    </Stack>
  );
}
