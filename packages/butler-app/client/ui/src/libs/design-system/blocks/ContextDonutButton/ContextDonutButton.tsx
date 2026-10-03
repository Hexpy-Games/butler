import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes } from "react";
import { PillButton } from "../../components/PillButton";
import { dsStyle } from "../../lib/internal";
import styles from "./ContextDonutButton.module.css";

export interface ContextDonutButtonProps
  extends Omit<DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>, "children"> {
  ratio: number;
  /** Plain preserves the compact trigger; glass shares PillButton sizing and states. */
  surface?: "plain" | "glass";
}

export function ContextDonutButton({
  ratio,
  surface = "plain",
  "aria-label": ariaLabel,
  type = "button",
  ...props
}: ContextDonutButtonProps) {
  const normalized = Math.min(1, Math.max(0, ratio));
  const circumference = 2 * Math.PI * 8;
  const offset = circumference * (1 - normalized);
  const ring = (
    <span className={styles.donut} aria-hidden="true">
      <svg className={styles.svg} viewBox="0 0 20 20">
        <circle className={styles.track} cx="10" cy="10" r="8" />
        <circle className={styles.progress} cx="10" cy="10" r="8" />
      </svg>
    </span>
  );
  const buttonProps = {
    "aria-label": ariaLabel ?? `Context usage ${Math.round(normalized * 100)}%`,
    type,
    style: dsStyle({
      "--context-circumference": circumference,
      "--context-offset": offset,
    }),
    ...props,
  };
  return surface === "glass" ? (
    <PillButton surface="glass" icon={ring} {...buttonProps}>{null}</PillButton>
  ) : (
    <button className={styles.button} {...buttonProps}>{ring}</button>
  );
}
