import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "../Button";
import { cn } from "../../lib/utils";
import styles from "./PillButton.module.css";

export interface PillButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
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
      className={cn(hasIconText && styles.withIconText, surface === "glass" && styles.glass, className)}
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
