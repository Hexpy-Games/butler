import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes } from "react";
import { ProgressRing } from "../../components/ProgressRing";
import { dsClass } from "../../lib/internal";
import styles from "./ContextDonutButton.module.css";

export interface ContextDonutButtonProps
  extends Omit<DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>, "children"> {
  ratio: number;
}

export function ContextDonutButton({
  ratio,
  "aria-label": ariaLabel,
  type = "button",
  ...props
}: ContextDonutButtonProps) {
  const normalized = Math.min(1, Math.max(0, ratio));
  return (
    <button
      className={styles.button}
      aria-label={ariaLabel ?? `Context usage ${Math.round(normalized * 100)}%`}
      type={type}
      {...props}
    >
      {/* The button carries the name, so the ring is decorative. */}
      <ProgressRing className={dsClass(styles.donut)} value={normalized} aria-hidden="true" />
    </button>
  );
}
