import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./SidebarShell.module.css";

export interface SidebarShellProps {
  titlebar?: ReactNode;
  header?: ReactNode;
  scrollHeader?: ReactNode;
  stickyHeader?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  collapsed?: boolean;
  ariaLabel?: string;
  className?: string;
  scrollFade?: boolean;
}

export function SidebarShell({
  titlebar,
  header,
  scrollHeader,
  stickyHeader,
  children,
  footer,
  collapsed = false,
  ariaLabel,
  className,
  scrollFade = true,
}: SidebarShellProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const sticky = stickyRef.current;
    if (!content || !sticky) return;
    const measure = () =>
      content.style.setProperty(
        "--sidebar-sticky-header-height",
        `${sticky.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sticky);
    return () => observer.disconnect();
  }, [Boolean(stickyHeader)]);
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
          <div
            className={cn(styles.scroll, !scrollFade && styles.unmasked)}
            data-test-class="sidebar-scroll"
          >
            <div
              ref={contentRef}
              className={styles.scrollContent}
              data-sticky-header={stickyHeader ? "true" : undefined}
            >
              {scrollHeader}
              {stickyHeader ? (
                <div
                  ref={stickyRef}
                  className={styles.stickyHeader}
                  data-test-class="sidebar-sticky-header"
                >
                  {stickyHeader}
                </div>
              ) : null}
              {children}
            </div>
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
