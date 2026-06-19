import type { ReactNode } from "react";
import { NavRow } from "../NavRow";
import { cn } from "../../lib/utils";
import styles from "./CollapsibleNavGroup.module.css";

export interface CollapsibleNavGroupProps {
  /** Icon element to display */
  icon?: ReactNode;
  /** Group label */
  label: ReactNode;
  /** Whether the group is expanded */
  expanded: boolean;
  /** Toggle handler */
  onToggle: () => void;
  /** Child navigation items */
  children: ReactNode;
  /** Optional badge to display on the group header */
  badge?: ReactNode;
  /** Actions to display on the group header */
  actions?: ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Test identifier for the group header row */
  dataTestClass?: string;
  /** Test identifier for the collapsible content region */
  contentDataTestClass?: string;
}

export function CollapsibleNavGroup({
  icon,
  label,
  expanded,
  onToggle,
  children,
  badge,
  actions,
  className,
  dataTestClass,
  contentDataTestClass,
}: CollapsibleNavGroupProps) {
  return (
    <div className={cn(styles.group, className)}>
      <NavRow
        icon={icon}
        label={label}
        badge={badge}
        actions={actions}
        actionsVisibility="hover"
        onClick={onToggle}
        className={styles.header}
        dataTestClass={dataTestClass}
        ariaExpanded={expanded}
      />
      <div
        className={cn(styles.content, !expanded && styles.collapsed)}
        data-test-class={contentDataTestClass}
        data-state={expanded ? "open" : "closed"}
        aria-hidden={!expanded}
      >
        <div className={styles.inner}>
          <div className={styles.items}>{children}</div>
        </div>
      </div>
    </div>
  );
}
