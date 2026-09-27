import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(scopes: Array<HTMLElement | null>): HTMLElement[] {
  return scopes.flatMap((scope) => (scope ? [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)] : []))
    .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
}

/**
 * The navigation drawer as a modal on drawer widths: Escape closes it, Tab stays
 * inside the drawer and its toggle, and the page behind does not scroll. The
 * shell's workspace is made inert by the caller; the scrim closes on tap.
 */
export function useNavDrawer({ active, root, onClose }: {
  active: boolean;
  root: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!active) return undefined;
    const shell = root.current;
    const sidebar = shell?.querySelector<HTMLElement>('[data-slot="adaptive-shell-sidebar"]') ?? null;
    const toggle = shell?.querySelector<HTMLElement>("[data-ds-nav-toggle]") ?? null;
    const inside = (node: Node | null) => Boolean(node && (sidebar?.contains(node) || toggle?.contains(node)));
    // Focus moves into the drawer itself (no ring on touch); Tab then walks its rows.
    if (!inside(document.activeElement)) sidebar?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
        toggle?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      // Tab is moved by hand: engines differ on what Tab reaches (WebKit skips buttons).
      event.preventDefault();
      const list = focusables([sidebar, toggle]);
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      const next = index < 0 ? (event.shiftKey ? list.length - 1 : 0) : (index + step + list.length) % list.length;
      list[next]!.focus();
    };
    const html = document.documentElement;
    const previous = { html: html.style.overflow, body: document.body.style.overflow };
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      html.style.overflow = previous.html;
      document.body.style.overflow = previous.body;
      if (sidebar?.contains(document.activeElement)) toggle?.focus();
    };
  }, [active, root, onClose]);
}
