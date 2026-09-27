import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { cn } from "../../lib/utils";
import { useComposedRefs } from "../../lib/composeRefs";
import { useScrollEdges } from "../../lib/useScrollEdges";
import styles from "./SidebarShell.module.css";
import { useStickyClipping } from "./hooks/useStickyClipping";

export type SidebarDensity = "compact" | "comfortable" | "touch";

export interface SidebarShellProps extends DsPrivateStyleProps {
  /**
   * Row height, inline padding, icon size, gaps and action targets of every
   * NavRow inside (tokens in tokens.css). Comfortable becomes touch on phones
   * and coarse pointers.
   */
  density?: SidebarDensity;
  titlebar?: ReactNode;
  header?: ReactNode;
  scrollHeader?: ReactNode;
  stickyHeader?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  collapsed?: boolean;
  ariaLabel?: string;
  scrollFade?: boolean;
  scrollRef?: Ref<HTMLDivElement>;
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
  scrollRef,
  density = "comfortable",
}: SidebarShellProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const edgesRef = useScrollEdges("y", scrollFade);
  const composedScrollRef = useComposedRefs(scrollRef, edgesRef);
  const stickyRef = useRef<HTMLDivElement>(null);
  useStickyClipping(contentRef, Boolean(stickyHeader));
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
      data-sidebar-density={density}
      data-has-titlebar={Boolean(titlebar) || undefined}
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
            ref={composedScrollRef}
            className={styles.scroll}
            data-test-class="sidebar-scroll"
          >
            <div
              ref={contentRef}
              className={styles.scrollContent}
              data-sticky-header={stickyHeader ? "true" : undefined}
            >
              {scrollHeader ? (
                <div className={styles.scrollHeader} data-slot="sidebar-scroll-header">
                  {scrollHeader}
                </div>
              ) : null}
              {stickyHeader ? (
                <div
                  ref={stickyRef}
                  className={styles.stickyHeader}
                  data-test-class="sidebar-sticky-header"
                >
                  <div className={styles.stickyCover} aria-hidden="true" />
                  {stickyHeader}
                </div>
              ) : null}
              {stickyHeader ? (
                <div className={styles.clippedContent} data-sticky-clip="root">
                  {children}
                </div>
              ) : children}
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

/** A list of sidebar rows; rows are spaced by the density's --sidebar-row-spacing. */
export function SidebarNav({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) {
  return <nav className={styles.nav} aria-label={ariaLabel}>{children}</nav>;
}

/** The product title row: titlebar height in the titlebar, action height in the header. */
export function SidebarBrand({ children }: { children: ReactNode }) {
  return <div className={styles.brand} data-slot="sidebar-brand">{children}</div>;
}
