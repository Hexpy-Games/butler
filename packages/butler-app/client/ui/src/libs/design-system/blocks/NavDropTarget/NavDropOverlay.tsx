import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import type { NavDropAutoScrollEdge } from "./navDropAutoScroll";
import styles from "./NavDropTarget.module.css";

type Box = { left: number; top: number; width: number; height: number };

/** The theme class of the element's scope, so a body portal keeps its tokens (light panel in dark chrome). */
function themeClassOf(element: Element): string | undefined {
  const scope = element.closest(".theme-dark, .theme-light");
  return scope ? (scope.classList.contains("theme-dark") ? "theme-dark" : "theme-light") : undefined;
}

/** The nearest ancestor that scrolls vertically (the sidebar list), else the element itself. */
export function scrollContainerOf(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return element;
}

/** The element's viewport box, kept current through scroll and resize while mounted. */
function useViewportBox(element: HTMLElement | null): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    if (!element) return undefined;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBox((current) => current && current.left === rect.left && current.top === rect.top && current.width === rect.width
        && current.height === rect.height ? current : { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [element]);
  return box;
}

/**
 * The drop label for an outside payload, beside the row header and above every surface (the sidebar
 * clips its rows, so it is portaled and fixed like a tooltip). Never part of the row's layout.
 */
export function NavDropLabel({ anchor, indicator, invalid, children }: {
  anchor: HTMLElement | null;
  indicator?: { top: number; height: number };
  invalid: boolean;
  children: ReactNode;
}) {
  const box = useViewportBox(anchor);
  if (!anchor || !box || typeof document === "undefined") return null;
  const middle = box.top + (indicator ? indicator.top + indicator.height / 2 : box.height / 2);
  return createPortal(
    <div className={themeClassOf(anchor)}>
      <span className={styles.outsideLabel} data-slot="nav-drop-label" data-invalid={invalid || undefined} role="status"
        style={{ left: box.left + box.width, top: middle }}>
        <Typo.Caption>{children}</Typo.Caption>
      </span>
    </div>,
    document.body,
  );
}

/**
 * The auto-scroll band at the list's top or bottom edge while a drag scrolls it. Finds the list
 * through a `display: none` marker, which is no flex item, so no row moves.
 */
export function NavDropEdge({ edge }: { edge: NavDropAutoScrollEdge }) {
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null);
  const scope = marker?.parentElement ?? null;
  const scroller = scope ? scrollContainerOf(scope) : null;
  const box = useViewportBox(scroller);
  const band = !scroller || !box || typeof document === "undefined" ? null : createPortal(
    <div className={themeClassOf(scroller)}>
      <span className={styles.autoScroll} data-slot="nav-drop-auto-scroll" data-edge={edge} aria-hidden="true"
        style={{ left: box.left, width: box.width, top: edge === "start" ? box.top : box.top + box.height }}>
        <ChevronDown size="md" />
      </span>
    </div>,
    document.body,
  );
  return <><span ref={setMarker} hidden />{band}</>;
}
