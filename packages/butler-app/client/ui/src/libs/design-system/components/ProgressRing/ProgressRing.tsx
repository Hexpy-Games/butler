import type { CSSProperties, HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { ICON_SIZE } from "../Icons";
import { Spinner } from "../Spinner";
import styles from "./ProgressRing.module.css";

/** r 8 in a 20-unit box: the ring geometry ContextDonutButton draws too. */
const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** `--icon-size-*`; `sidebar` follows the sidebar density icon size, like `IconSlot size="sidebar"`. */
export type ProgressRingSize = "xs" | "sm" | "md" | "lg" | "sidebar";
export type ProgressRingTone = "default" | "success" | "warning" | "danger";

/** The Spinner drawn while indeterminate; `sidebar` uses the 16px Spinner scaled to the row's icon size. */
const SPINNER_SIZE: Record<ProgressRingSize, number> = {
  xs: ICON_SIZE.xs, sm: ICON_SIZE.sm, md: ICON_SIZE.md, lg: ICON_SIZE.lg, sidebar: ICON_SIZE.md,
};

export interface ProgressRingProps
  extends Omit<DsBaseProps<HTMLAttributes<HTMLSpanElement>>, "children" | "role"> {
  /** Completed fraction from 0 to 1 (clamped). Ignored while `indeterminate`. */
  value?: number;
  /** Work runs with no known fraction: the DS Spinner in the same square (its motion and reduced motion). */
  indeterminate?: boolean;
  size?: ProgressRingSize;
  /** Fill colour of the determinate ring: `default` is the accent, `success` once complete, `danger` when it failed. */
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
  const geometry = indeterminate ? undefined : {
    "--progress-ring-dash": CIRCUMFERENCE,
    "--progress-ring-offset": CIRCUMFERENCE * (1 - fraction),
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
      {indeterminate ? (
        <Spinner className={dsClass(styles.spinner)} size={SPINNER_SIZE[size]} />
      ) : (
        <svg className={styles.svg} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle className={styles.track} cx="10" cy="10" r={RADIUS} />
          <circle className={styles.fill} data-slot="progress-ring-fill" cx="10" cy="10" r={RADIUS} />
        </svg>
      )}
    </span>
  );
}
