import type { ButtonHTMLAttributes, CSSProperties } from "react";
import styles from "./ContextDonutButton.module.css";

export interface ContextDonutButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  ratio: number;
}

export function ContextDonutButton({
  ratio,
  "aria-label": ariaLabel,
  type = "button",
  ...props
}: ContextDonutButtonProps) {
  const normalized = Math.min(1, Math.max(0, ratio));
  const circumference = 2 * Math.PI * 8;
  const offset = circumference * (1 - normalized);
  return (
    <button
      className={styles.button}
      aria-label={ariaLabel ?? `Context usage ${Math.round(normalized * 100)}%`}
      type={type}
      style={
        {
          "--context-circumference": circumference,
          "--context-offset": offset,
        } as CSSProperties
      }
      {...props}
    >
      <span className={styles.donut} aria-hidden="true">
        <svg className={styles.svg} viewBox="0 0 20 20">
          <circle className={styles.track} cx="10" cy="10" r="8" />
          <circle className={styles.progress} cx="10" cy="10" r="8" />
        </svg>
      </span>
    </button>
  );
}
