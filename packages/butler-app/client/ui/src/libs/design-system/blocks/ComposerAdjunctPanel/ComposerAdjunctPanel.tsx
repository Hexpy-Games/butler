import type { HTMLAttributes, ReactNode } from "react";
import { useId, useState } from "react";
import { ChevronDown } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ComposerAdjunctPanel.module.css";

export interface ComposerAdjunctPanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  heading?: ReactNode;
  icon?: ReactNode;
  collapsedSummary?: ReactNode;
  defaultCollapsed?: boolean;
  children: ReactNode;
}

export function ComposerAdjunctPanel({
  heading,
  icon,
  collapsedSummary,
  defaultCollapsed = false,
  children,
  className,
  ...props
}: ComposerAdjunctPanelProps) {
  const hasHeader = Boolean(heading) || Boolean(icon);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();

  return (
    <section className={cn(styles.panel, className)} {...props}>
      {hasHeader ? (
        <button
          type="button"
          className={styles.header}
          data-has-icon={icon ? "true" : "false"}
          data-has-summary={
            collapsed && collapsedSummary ? "true" : "false"
          }
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((value) => !value)}
        >
          {icon ? (
            <span className={styles.icon} aria-hidden="true">
              {icon}
            </span>
          ) : null}
          {heading ? (
            <Typo.Body as="span" className={styles.heading}>
              {heading}
            </Typo.Body>
          ) : null}
          {collapsed && collapsedSummary ? (
            <Typo.Caption as="span" className={styles.summary}>
              {collapsedSummary}
            </Typo.Caption>
          ) : null}
          <span
            className={styles.chevron}
            data-collapsed={collapsed ? "true" : "false"}
            aria-hidden="true"
          >
            <ChevronDown size={14} />
          </span>
        </button>
      ) : null}
      <div
        className={styles.body}
        data-collapsed={collapsed ? "true" : "false"}
        aria-hidden={collapsed}
        id={bodyId}
      >
        <div className={styles.bodyInner}>{children}</div>
      </div>
    </section>
  );
}
