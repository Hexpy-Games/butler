import type { ComponentProps, ReactNode } from "react";
import { ComposerControl } from "@/butler-ds";

type ComposerControlButtonProps = Omit<ComponentProps<typeof ComposerControl>, "label"> & {
  children: ReactNode;
};

export function ComposerControlButton({
  children,
  compact = "label",
  type = "button",
  ...props
}: ComposerControlButtonProps) {
  return (
    <ComposerControl
      label={children}
      compact={compact}
      type={type}
      {...props}
    />
  );
}
