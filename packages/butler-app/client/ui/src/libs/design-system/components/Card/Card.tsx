import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./Card.module.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
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
  ...props
}: CardProps) {
  return (
    <div
      className={cn(styles.card, className)}
      data-interactive={interactive ? "true" : undefined}
      data-padding={padding}
      data-selected={selected ? "true" : undefined}
      data-slot="card"
      {...props}
    >
      {children}
    </div>
  );
}
