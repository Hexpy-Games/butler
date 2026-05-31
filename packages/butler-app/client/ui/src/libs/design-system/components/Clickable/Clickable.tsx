import type {
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import styles from "./Clickable.module.css";

export interface ClickableProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  stretch?: boolean;
}

export function Clickable({
  children,
  disabled = false,
  onClick,
  onKeyDown,
  role = "button",
  stretch = false,
  tabIndex,
  className,
  ...props
}: ClickableProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled || !onClick) return;
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
