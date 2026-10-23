import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A closing inspector leaves keyboard focus and the accessibility tree the
 * moment it starts closing, not when its slide ends: it turns inert in the
 * same commit. Focus inside it, or focus the close dropped (a close control
 * outside the panel that unmounts with it), first returns to the control that
 * held focus when it opened (when that can still take focus), else to the
 * workspace, so a later Tab starts from there and never reaches the sliding panel.
 */
export function useInspectorInert(panelRef: RefObject<HTMLElement | null>, open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body && !panel.contains(active) ? active : null;
      panel.inert = false;
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || panel.contains(active)) returnFocus(panel, opener.current);
    opener.current = null;
    panel.inert = true;
  }, [open, panelRef]);
}

function returnFocus(panel: HTMLElement, opener: HTMLElement | null) {
  if (opener?.isConnected && !panel.contains(opener)) {
    opener.focus({ preventScroll: true });
    if (document.activeElement === opener) return;
  }
  const workspace = panel.parentElement?.querySelector<HTMLElement>(':scope > [data-slot="adaptive-shell-workspace"]');
  if (!workspace) return;
  // The workspace takes programmatic focus only while it holds it.
  if (!workspace.hasAttribute("tabindex")) {
    workspace.tabIndex = -1;
    workspace.addEventListener("blur", () => workspace.removeAttribute("tabindex"), { once: true });
  }
  workspace.focus({ preventScroll: true });
}
