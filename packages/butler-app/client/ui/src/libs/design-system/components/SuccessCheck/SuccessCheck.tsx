import styles from "./SuccessCheck.module.css";

/** Hugeicons geometry (24 grid, 1.5 stroke) so a static check matches CheckIcon / CheckCircle2. */
const PLAIN_MARK = "M5 14L8.5 17.5L19 6.5";
const RING_MARK = "M8 12.5L10.5 15L16 9";

export interface SuccessCheckProps {
  /** Pixel box size (ICON_SIZE values); default 16. */
  size?: number;
  /** Draw the check inside a ring (the Spinner's done state, status icons). */
  ring?: boolean;
  /** Draw the stroke and pop in on mount; false renders the finished check. */
  animate?: boolean;
  /** Accessible name; without it the check is decorative. */
  label?: string;
  "data-test-class"?: string;
}

/**
 * The DS completion mark: the ring and check strokes draw in with a subtle
 * scale and fade (~310ms on motion tokens). Mount it when the work completes;
 * remount (key) to play it again. Reduced motion keeps only the fade.
 */
export function SuccessCheck({ size = 16, ring = false, animate = true, label, "data-test-class": dataTestClass }: SuccessCheckProps) {
  return (
    <svg
      className={styles.check}
      data-slot="success-check"
      data-animate={animate ? "true" : "false"}
      data-test-class={dataTestClass}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {ring ? (
        <circle className={styles.ring} cx="12" cy="12" r="10" pathLength="100" strokeDasharray="100"
          stroke="currentColor" strokeWidth="1.5" />
      ) : null}
      <path className={styles.mark} d={ring ? RING_MARK : PLAIN_MARK} pathLength="100" strokeDasharray="100"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
