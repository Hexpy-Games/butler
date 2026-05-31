import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "../Button";
import styles from "./PillButton.module.css";

export interface PillButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  icon?: ReactNode;
  stretch?: boolean;
}

export function PillButton({
  children,
  icon,
  stretch = false,
  type = "button",
  ...props
}: PillButtonProps) {
  const hasIconText = icon != null && children != null;

  return (
    <Button
      className={hasIconText ? styles.withIconText : undefined}
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
