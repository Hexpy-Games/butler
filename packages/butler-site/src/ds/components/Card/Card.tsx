import type { ReactNode } from "react";
import styles from "./Card.module.css";

export interface CardProps {
  children: ReactNode;
  padding?: "none" | "sm" | "md" | "lg";
  /** Renders the card as a link; the whole card is the hit target. */
  href?: string;
  /** Opens the link in a new tab (external destinations). */
  external?: boolean;
  selected?: boolean;
  /** Unavailable destination: muted, not focusable, never a link. */
  disabled?: boolean;
  "aria-label"?: string;
}

export function Card({ children, padding = "md", href, external = false, selected = false, disabled = false, ...props }: CardProps) {
  const shared = {
    className: styles.card,
    "data-padding": padding,
    "data-selected": selected ? "true" : undefined,
    "data-slot": "card",
    ...props,
  };
  if (href && !disabled) {
    return (
      <a {...shared} data-interactive="true" href={href} {...(external ? { rel: "noopener", target: "_blank" } : {})}>
        {children}
      </a>
    );
  }
  return <div {...shared} aria-disabled={disabled || undefined} data-disabled={disabled ? "true" : undefined}>{children}</div>;
}
