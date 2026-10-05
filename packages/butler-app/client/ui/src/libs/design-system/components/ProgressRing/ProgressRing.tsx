import type { CSSProperties, HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./ProgressRing.module.css";

/** r 8 in a 20-unit box: the ring geometry ContextDonutButton draws too. */
const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Share of the ring the indeterminate arc covers (also the static arc under reduced motion). */
const INDETERMINATE_ARC = 0.25;

/** `--icon-size-*`; `sidebar` follows the sidebar density icon size, like `IconSlot size="sidebar"`. */
export type ProgressRingSize = "xs" | "sm" | "md" | "lg" | "sidebar";
export type ProgressRingTone = "default" | "success" | "warning" | "danger";

export interface ProgressRingProps
  extends Omit<DsBaseProps<HTMLAttributes<HTMLSpanElement>>, "children" | "role"> {
  /** Completed fraction from 0 to 1 (clamped). Ignored while `indeterminate`. */
  value?: number;
  /** Work runs with no known fraction: a rotating quarter arc, static under reduced motion. */
  indeterminate?: boolean;
  size?: ProgressRingSize;
  /** Fill colour: `default` is the accent, `success` once complete, `danger` when it failed. */
  tone?: ProgressRingTone;
}

/**
 * A non-interactive ring that shows progress in an icon-sized square. It is a
 * `progressbar` named by `aria-label`; with `aria-hidden` it is decorative
 * (inside a control that carries the name, like ContextDonutButton).
 */
export function ProgressRing({
  value = 0,
  indeterminate = false,
  size = "md",
  tone = "default",
  className,
  style,
  ...props
}: ProgressRingProps) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const decorative = props["aria-hidden"] === true || props["aria-hidden"] === "true";
  const geometry = {
    "--progress-ring-dash": indeterminate ? `${CIRCUMFERENCE * INDETERMINATE_ARC} ${CIRCUMFERENCE}` : CIRCUMFERENCE,
    "--progress-ring-offset": indeterminate ? 0 : CIRCUMFERENCE * (1 - fraction),
  } as CSSProperties;
  return (
    <span
      className={cn(styles.ring, className)}
      data-slot="progress-ring"
      data-size={size}
      data-tone={tone}
      data-state={indeterminate ? "indeterminate" : fraction >= 1 ? "complete" : "determinate"}
      role={decorative ? undefined : "progressbar"}
      aria-valuemin={decorative ? undefined : 0}
      aria-valuemax={decorative ? undefined : 100}
      aria-valuenow={decorative || indeterminate ? undefined : Math.round(fraction * 100)}
      style={{ ...geometry, ...style }}
      {...props}
    >
      <svg className={styles.svg} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle className={styles.track} cx="10" cy="10" r={RADIUS} />
        <circle className={styles.fill} data-slot="progress-ring-fill" cx="10" cy="10" r={RADIUS} />
      </svg>
    </span>
  );
}
