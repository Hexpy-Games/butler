import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ComposerControl } from "@/butler-ds";

interface ComposerControlButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  icon?: ReactNode;
  detail?: ReactNode;
  compact?: "label" | "icon";
}

export function ComposerControlButton({
  children,
  detail,
  icon,
  compact = "label",
  type = "button",
  ...props
}: ComposerControlButtonProps) {
  return (
    <ComposerControl
      label={children}
      detail={detail}
      icon={icon}
      compact={compact}
      type={type}
      {...props}
    />
  );
}
