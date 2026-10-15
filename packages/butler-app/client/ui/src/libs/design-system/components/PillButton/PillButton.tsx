import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "../Button";
import styles from "./PillButton.module.css";
import { dsClass } from "../../lib/internal";

export interface PillButtonProps
 extends DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>> {
  children: ReactNode;
  icon?: ReactNode;
  stretch?: boolean;
  surface?: "plain" | "glass";
  /** A toggle or the chosen chip of a row (aria-pressed): flat selection background. */
  pressed?: boolean;
  /** A quiet number after the label ("Travel 5"). */
  count?: ReactNode;
  /** A drag is over the chip: accent ring (a drop target such as a group). */
  drop?: boolean;
}

export function PillButton({
  children,
  icon,
  stretch = false,
  surface = "plain",
  pressed,
  count,
  drop = false,
  className,
  type = "button",
  ...props
}: PillButtonProps) {
  const hasIconText = icon != null && children != null;
  const text = count == null ? children : <>{children}<span className={styles.count}>{count}</span></>;

  return (
    <Button
      className={dsClass(hasIconText && styles.withIconText, surface === "glass" && styles.glass, styles.pill, className)}
      data-surface={surface === "glass" ? "glass-pill" : undefined}
      data-pressed={pressed ? "true" : undefined}
      data-drop={drop ? "true" : undefined}
      aria-pressed={pressed}
      iconStart={icon}
      shape="pill"
      stretch={stretch}
      text={text}
      type={type}
      variant="borderless"
      {...props}
    />
  );
}
