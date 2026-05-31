import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./SidebarShell.module.css";

export interface SidebarShellProps {
  titlebar?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  collapsed?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function SidebarShell({
  titlebar,
  header,
  children,
  footer,
  collapsed = false,
  ariaLabel,
  className,
}: SidebarShellProps) {
  return (
    <aside
      className={cn(styles.shell, className)}
      data-collapsed={collapsed ? "true" : undefined}
      data-test-class="app-sidebar"
      aria-label={ariaLabel}
    >
      {titlebar ? (
        <div className={cn(styles.titlebar, "drag-region")}>{titlebar}</div>
      ) : null}
      <div className={cn(styles.content, collapsed && styles.contentCollapsed)}>
        {header ? (
          <div className={styles.header} data-test-class="sidebar-fixed-header">
            {header}
          </div>
        ) : null}
        <div
          className={styles.scrollFrame}
          data-test-class="sidebar-scroll-frame"
        >
          <div className={styles.scroll} data-test-class="sidebar-scroll">
            <div className={styles.scrollContent}>{children}</div>
          </div>
        </div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </aside>
  );
}

export function SidebarTrafficSpace() {
  return <div className={styles.trafficSpace} aria-hidden="true" />;
}

export function SidebarNav({ children }: { children: ReactNode }) {
  return <nav className={styles.nav}>{children}</nav>;
}
