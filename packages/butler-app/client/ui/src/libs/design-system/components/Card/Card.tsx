import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./Card.module.css";

export interface CardProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  children: ReactNode;
  padding?: "none" | "sm" | "md";
  interactive?: boolean;
  selected?: boolean;
}

export function Card({
  children,
  className,
  interactive = false,
  padding = "md",
  selected = false,
  onClick,
  onKeyDown,
  ...props
}: CardProps) {
  // An interactive card with onClick is a keyboard-operable button.
  const actionable = interactive && Boolean(onClick);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (!actionable || event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.currentTarget.click();
    }
  };
  return (
    <div
      className={cn(styles.card, className)}
      data-interactive={interactive ? "true" : undefined}
      data-padding={padding}
      data-selected={selected ? "true" : undefined}
      data-slot="card"
      role={actionable ? "button" : undefined}
      tabIndex={actionable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={actionable ? handleKeyDown : onKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}
