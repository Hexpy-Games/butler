import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { CSSProperties, ReactNode } from "react";
import { Spinner } from "../../components/Spinner";
import { IconSlot } from "../../components/IconSlot";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ProgressMeter.module.css";
import { dsClass } from "../../lib/internal";

interface ProgressMeterBaseProps extends DsPrivateStyleProps {
  /** Visible label; omit only with `bare`. */
  label?: ReactNode;
  meta?: ReactNode;
  ariaLabel?: string;
  tone?: "default" | "success" | "warning" | "danger";
  /** Track only (4px), no label row; name it with `ariaLabel`. */
  bare?: boolean;
}

/**
 * A known value (0–100) is required unless `indeterminate` is set. A caller
 * that switches between the two passes both (`value` is ignored while
 * `indeterminate` is true).
 */
export type ProgressMeterProps = ProgressMeterBaseProps & (
  | { value: number; indeterminate?: boolean }
  | {
    /** Unknown total: a spinner beside one caption line, without a fabricated track or percentage. */
    indeterminate: true;
    value?: never;
  }
);

export function ProgressMeter(props: ProgressMeterProps) {
  const { label, meta, ariaLabel, tone = "default", className, bare = false } = props;
  if (props.indeterminate) {
    return (
      <Stack align="row" cross="start" gap="xs" role="status" aria-label={ariaLabel}
        className={dsClass(styles.root, styles.indeterminate, className)} data-indeterminate="true">
        <IconSlot size="sm" minHeight="line" tone="secondary"><Spinner size={12} /></IconSlot>
        <Typo.Caption tone="secondary">{label}{meta != null ? <> · {meta}</> : null}</Typo.Caption>
      </Stack>
    );
  }
  const normalized = Math.max(0, Math.min(100, props.value));
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
    <Stack gap="xs" className={dsClass(styles.root, className)}>
      <Stack align="row" justify="between" cross="center" gap="sm">
        <Typo.Caption className={dsClass(styles.label)}>{label}</Typo.Caption>
        <Typo.Caption className={dsClass(styles.meta)}>{meta ?? `${normalized}%`}</Typo.Caption>
      </Stack>
      {track}
    </Stack>
  );
}
