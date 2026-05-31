import type { ReactNode } from "react";
import { Stack, type StackProps } from "../Stack";
import { cn } from "../../lib/utils";
import styles from "./ButtonContainer.module.css";

export type ButtonContainerSize =
  | "xs"
  | "sm"
  | "default"
  | "lg"
  | "icon-xs"
  | "icon-sm"
  | "icon"
  | "icon-lg";

interface ButtonContainerProps extends Omit<StackProps, "children" | "gap"> {
  children: ReactNode;
  size: ButtonContainerSize;
}

function gapForButtonSize(size: ButtonContainerSize): StackProps["gap"] {
  if (size === "xs" || size === "icon-xs") return "1";
  if (size === "lg" || size === "icon-lg") return "3";
  return "2";
}

export function ButtonContainer({
  children,
  size,
  align = "row",
  cross = "center",
  wrap = true,
  className,
  ...props
}: ButtonContainerProps) {
  return (
    <Stack
      align={align}
      className={cn(styles.container, className)}
      cross={cross}
      data-button-size={size}
      data-slot="button-container"
      gap={gapForButtonSize(size)}
      wrap={wrap}
      {...props}
    >
      {children}
    </Stack>
  );
}
