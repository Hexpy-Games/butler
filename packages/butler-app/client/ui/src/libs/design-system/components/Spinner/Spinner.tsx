import type { SVGProps } from "react";
import { cn } from "../../lib/utils";
import styles from "./Spinner.module.css";

const MIN_STROKE_PX = 1.35;
const STROKE_SIZE_RATIO = 0.071;
const VIEWBOX_SIZE = 100;

export interface SpinnerProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  label?: string;
}

/** Butler's indeterminate traveling-gap indicator; the caller owns busy state. */
export function Spinner({ size = 16, label, className, ...props }: SpinnerProps) {
  const strokeWidth = Math.max(MIN_STROKE_PX, size * STROKE_SIZE_RATIO) * VIEWBOX_SIZE / size;

  return (
    <svg
      {...props}
      className={cn(styles.spinner, className)}
      data-slot="spinner"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      focusable="false"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        className={styles.orbit}
        data-slot="spinner-orbit"
        cx="50"
        cy="50"
        r="36.5"
        pathLength="100"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeDasharray="79 21"
        strokeLinecap="round"
      />
    </svg>
  );
}
