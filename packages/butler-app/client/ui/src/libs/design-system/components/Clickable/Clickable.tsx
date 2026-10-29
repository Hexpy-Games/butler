import type { DsBaseProps } from "../../lib/dsProps";
import type {
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import styles from "./Clickable.module.css";

export interface ClickableProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /**
   * `inline`: the row reaches into its container's gutter by its own inline
   * padding, so its content lines up with sibling content while the hover and
   * selected fills extend past it. `block`: the fills reach `--space-xs` above
   * and below the content without moving it or the rows around it. `both`:
   * both at once. Row variant only.
   */
  bleed?: "inline" | "block" | "both";
  children: ReactNode;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  /**
   * Makes the row a toggle: `true` shows the selected fill, `false` an
   * unselected toggle. Sets `aria-pressed` while the role is `button`. Leave
   * undefined on rows that do not toggle. Row variant only.
   */
  selected?: boolean;
  stretch?: boolean;
  /** `row` (default): a padded row target with a hover fill. `text`: bare text that dims on hover. */
  variant?: "row" | "text";
}

export function Clickable({
  "aria-pressed": ariaPressed,
  bleed,
  children,
  disabled = false,
  onClick,
  onKeyDown,
  role = "button",
  selected,
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
  const row = variant === "row";

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-pressed={ariaPressed ?? (role === "button" ? selected : undefined)}
      data-bleed={row ? bleed : undefined}
      data-disabled={disabled || undefined}
      data-selected={row && selected !== undefined ? String(selected) : undefined}
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
