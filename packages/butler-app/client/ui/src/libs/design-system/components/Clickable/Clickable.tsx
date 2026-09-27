import type { DsBaseProps } from "../../lib/dsProps";
import type {
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import styles from "./Clickable.module.css";

export interface ClickableProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  children: ReactNode;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  stretch?: boolean;
  /** `row` (default): a padded row target with a hover fill. `text`: bare text that dims on hover. */
  variant?: "row" | "text";
}

export function Clickable({
  children,
  disabled = false,
  onClick,
  onKeyDown,
  role = "button",
  stretch = false,
  variant = "row",
  tabIndex,
  className,
  ...props
}: ClickableProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget || disabled || !onClick) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.currentTarget.click();
    }
  };

  return (
    <div
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      data-slot="clickable"
      data-stretch={stretch ? "true" : undefined}
      data-variant={variant === "text" ? "text" : undefined}
      role={role}
      tabIndex={tabIndex ?? (disabled ? undefined : 0)}
      className={[styles.clickable, className].filter(Boolean).join(" ")}
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}
