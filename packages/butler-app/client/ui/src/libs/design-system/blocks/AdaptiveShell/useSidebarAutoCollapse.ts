import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MIN_PAGE_WIDTH, sidebarAutoCollapses } from "./conversationFrame";

/**
 * Auto-collapse for the docked sidebar while a conversation shows the browser pane: true when the
 * page would be narrower than `minPageWidth` (720px) with the sidebar open. Measures the shell root
 * (ResizeObserver, no polling). The product passes `leftOpen={open && !collapsed}` and keeps its own
 * preference untouched, so the sidebar returns when the window grows again; peek still works.
 */
export function useSidebarAutoCollapse(rootRef: RefObject<HTMLElement | null>, { enabled, sidebarWidth, chatWidth, minPageWidth = MIN_PAGE_WIDTH }: {
  /** Only while the browser pane is open beside the chat. */
  enabled: boolean;
  sidebarWidth: number;
  chatWidth: number;
  minPageWidth?: number;
}): boolean {
  const [collapsed, setCollapsed] = useState(false);
  const latest = useRef(collapsed);
  latest.current = collapsed;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) {
      setCollapsed(false);
      return undefined;
    }
    const measure = () => {
      const next = sidebarAutoCollapses({ shellWidth: root.clientWidth, sidebarWidth, chatWidth, collapsed: latest.current, minPageWidth });
      if (next !== latest.current) setCollapsed(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef, enabled, sidebarWidth, chatWidth, minPageWidth]);

  return enabled && collapsed;
}
