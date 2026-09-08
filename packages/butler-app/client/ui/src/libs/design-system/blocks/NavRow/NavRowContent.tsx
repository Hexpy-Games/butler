import type { NavRowProps } from "./NavRow";
import { cn } from "../../lib/utils";
import styles from "./NavRow.module.css";

/** Row-one controls and full-width row-two metadata have independent tracks. */
export function NavRowContent({
  icon, iconInteractive, label, badge, actions, actionsVisibility = "visible", meta,
}: Pick<NavRowProps, "icon" | "iconInteractive" | "label" | "badge" | "actions" | "actionsVisibility" | "meta">) {
  const hasHoverActions = Boolean(actions && actionsVisibility !== "visible");
  return (
    <>
      <span className={styles.labelRegion}>
        {icon && (
          <span className={styles.icon} aria-hidden={iconInteractive ? undefined : true} data-slot="nav-row-icon">
            {icon}
          </span>
        )}
        <span className={styles.label} data-slot="nav-row-label">{label}</span>
      </span>
      {(badge || actions) && (
        <span className={styles.controlRegion} data-has-hover-actions={hasHoverActions ? "true" : undefined}>
          {badge && <span className={styles.badge}>{badge}</span>}
          {actions && (
            <span className={cn(styles.actions,
              actionsVisibility !== "visible" && styles.hoverActions,
              actionsVisibility === "hover-compact-hidden" && styles.compactHiddenActions)}>
              {actions}
            </span>
          )}
        </span>
      )}
      {meta && <span className={styles.meta} data-slot="nav-row-meta" data-has-icon={Boolean(icon) || undefined}>{meta}</span>}
    </>
  );
}
