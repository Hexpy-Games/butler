import type { CSSProperties, ReactNode } from "react";
import { Collapsible } from "../../components/Collapsible";
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
  /** Actions to display on the group header */
  actions?: ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Opt-in tree hierarchy; flat remains the default for existing navigation. */
  indented?: boolean;
  /** Opt-in stacked sticky header, relative to the outer list scroll container. */
  stickyDepth?: number;
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
  actions,
  className,
  indented = false,
  stickyDepth,
  dataTestClass,
  contentDataTestClass,
}: CollapsibleNavGroupProps) {
  return (
    <div
      className={cn(
        styles.group,
        stickyDepth !== undefined && styles.stickyGroup,
        className,
      )}
      style={
        stickyDepth === undefined
          ? undefined
          : ({ "--nav-sticky-depth": stickyDepth } as CSSProperties)
      }
    >
      <NavRow
        icon={icon}
        label={label}
        actions={actions}
        actionsVisibility={indented ? "visible" : "hover"}
        onClick={onToggle}
        className={styles.header}
        dataTestClass={dataTestClass}
        ariaExpanded={expanded}
      />
      <Collapsible
        open={expanded}
        className={styles.content}
        data-test-class={contentDataTestClass}
        data-sticky-clip={stickyDepth !== undefined ? "branch" : undefined}
      >
        <div className={cn(styles.items, indented && styles.indented)}>
          {children}
        </div>
      </Collapsible>
    </div>
  );
}
