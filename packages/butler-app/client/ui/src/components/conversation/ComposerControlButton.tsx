import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ComposerControl } from "@/butler-ds";

interface ComposerControlButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  icon?: ReactNode;
  detail?: ReactNode;
}

export function ComposerControlButton({
  children,
  detail,
  icon,
  type = "button",
  ...props
}: ComposerControlButtonProps) {
  return (
    <ComposerControl
      label={children}
      detail={detail}
      icon={icon}
      type={type}
      {...props}
    />
  );
}
