import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes, ReactNode, ComponentProps } from "react";
import { Button } from "../Button";
import styles from "./PillButton.module.css";
import { dsClass } from "../../lib/internal";

export interface PillButtonProps
 extends DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>> {
  children?: ReactNode;
  size?: ComponentProps<typeof Button>["size"];
  icon?: ReactNode;
  stretch?: boolean;
  surface?: "plain" | "glass";
}

export function PillButton({
  children,
  icon,
  stretch = false,
  surface = "plain",
  className,
  type = "button",
  ...props
}: PillButtonProps) {
  const hasIconText = icon != null && children != null;

  return (
    <Button
      className={dsClass(hasIconText && styles.withIconText, surface === "glass" && styles.glass, className)}
      data-surface={surface === "glass" ? "glass-pill" : undefined}
      iconStart={icon}
      shape="pill"
      stretch={stretch}
      text={children}
      type={type}
      variant="borderless"
      {...props}
    />
  );
}
