import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./Card.module.css";

export interface CardProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  children: ReactNode;
  padding?: "none" | "sm" | "md";
  interactive?: boolean;
  selected?: boolean;
  /**
   * Live work state of the item. `running`: a --worker-active border and a
   * slow pulse ring; reduced motion (OS or data-motion) keeps the ring static.
   * Selection still wins the border; the ring stays.
   */
  activity?: "running";
  /**
   * Corner radius tier. `control` (default): --radius-control (8px), for
   * items in a grid or list. `lg`: --radius-popover (12px), for a card as
   * wide as the conversation column. A frame placed directly inside the card
   * follows its corners.
   */
  radius?: "control" | "lg";
}

export function Card({
  children,
  className,
  interactive = false,
  padding = "md",
  selected = false,
  activity,
  radius = "control",
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
      data-activity={activity}
      data-radius={radius === "lg" ? "lg" : undefined}
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
