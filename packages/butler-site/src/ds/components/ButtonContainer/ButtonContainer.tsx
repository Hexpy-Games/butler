import type { ReactNode } from "react";
import type { ButtonSize } from "../Button";
import styles from "./ButtonContainer.module.css";

export interface ButtonContainerProps {
  children: ReactNode;
  /** The size every button inside uses; it sets the inter-button gap. */
  size: ButtonSize;
  "aria-label"?: string;
}

function gapForButtonSize(size: ButtonSize): "xs" | "sm" | "md" {
  if (size === "xs" || size === "icon-xs") return "xs";
  if (size === "lg" || size === "icon-lg") return "md";
  return "sm";
}

/** Consecutive buttons are always wrapped in a ButtonContainer. */
export function ButtonContainer({ children, size, ...props }: ButtonContainerProps) {
  return (
    <div className={styles.container} data-button-size={size} data-gap={gapForButtonSize(size)} data-slot="button-container" {...props}>
      {children}
    </div>
  );
}
