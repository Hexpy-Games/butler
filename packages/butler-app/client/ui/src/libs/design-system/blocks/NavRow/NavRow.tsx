import type { HTMLAttributes, ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { cn } from "../../lib/utils";
import styles from "./NavRow.module.css";

export interface NavRowProps {
  /** Icon element to display at the start */
  icon?: ReactNode;
  /** Label text or element */
  label: ReactNode;
  /** Optional badge text or number */
  badge?: ReactNode;
  /** Whether this row is currently active/selected */
  active?: boolean;
  /** Whether this row is disabled */
  disabled?: boolean;
  /** Action buttons or elements to display on the right */
  actions?: ReactNode;
  /** Visibility mode for actions: always visible or only on hover */
  actionsVisibility?: "visible" | "hover" | "hover-compact-hidden";
  /** Additional CSS class */
  className?: string;
  /** Test identifier */
  dataTestClass?: string;
  /** Click handler */
  onClick?: HTMLAttributes<HTMLDivElement>["onClick"];
  /** Context menu handler */
  onContextMenu?: HTMLAttributes<HTMLDivElement>["onContextMenu"];
  /** Accessible label (falls back to label if string) */
  ariaLabel?: string;
  /** Expanded state for tree-like navigation rows */
  ariaExpanded?: boolean;
}

export function NavRow({
  icon,
  label,
  badge,
  active = false,
  disabled = false,
  actions,
  actionsVisibility = "visible",
  className,
  dataTestClass,
  onClick,
  onContextMenu,
  ariaLabel,
  ariaExpanded,
}: NavRowProps) {
  const hasHoverActions = Boolean(actions && actionsVisibility !== "visible");
  const content = (
    <>
      <span className={styles.labelRegion}>
        {icon && (
          <span className={styles.icon} aria-hidden="true" data-slot="nav-row-icon">
            {icon}
          </span>
        )}
        <span className={styles.label} data-slot="nav-row-label">{label}</span>
      </span>
      {(badge || actions) && (
        <span
          className={styles.controlRegion}
          data-has-hover-actions={hasHoverActions ? "true" : undefined}
        >
          {badge && <span className={styles.badge}>{badge}</span>}
          {actions && (
            <span
              className={cn(
                styles.actions,
                actionsVisibility !== "visible" && styles.hoverActions,
                actionsVisibility === "hover-compact-hidden" &&
                  styles.compactHiddenActions,
              )}
            >
              {actions}
            </span>
          )}
        </span>
      )}
    </>
  );

  const rowClassName = cn(
    styles.row,
    active && styles.active,
    disabled && styles.disabled,
    onClick && styles.interactive,
    className,
  );

  const accessibleLabel = ariaLabel ?? (typeof label === "string" ? label : undefined);

  if (onClick && !disabled) {
    return (
      <Clickable
        aria-current={active ? "page" : undefined}
        aria-label={accessibleLabel}
        aria-disabled={disabled}
        className={rowClassName}
        data-has-hover-actions={hasHoverActions ? "true" : undefined}
        data-test-class={dataTestClass}
        title={accessibleLabel}
        aria-expanded={ariaExpanded}
        stretch
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {content}
      </Clickable>
    );
  }

  return (
    <div
      className={rowClassName}
      data-test-class={dataTestClass}
      title={accessibleLabel}
      aria-disabled={disabled}
      aria-expanded={ariaExpanded}
      data-has-hover-actions={hasHoverActions ? "true" : undefined}
    >
      {content}
    </div>
  );
}
