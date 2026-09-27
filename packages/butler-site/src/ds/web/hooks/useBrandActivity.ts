import { useEffect, useState, type RefObject } from "react";

/** Window event the page dispatches while Butler works for the reader (e.g. a search). */
export const THINKING_EVENT = "butler:thinking";

/** How long an intro mark thinks after it appears. */
const INTRO_MS = 1800;

/**
 * The mark "thinks" while its link (or hover target) is hovered or focused,
 * while a THINKING_EVENT with `detail: true` is active, and briefly after it
 * appears when `intro` is set.
 */
export function useBrandActivity(anchor: RefObject<HTMLElement | null>, intro = false): boolean {
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [introducing, setIntroducing] = useState(intro);
  useEffect(() => {
    if (!intro) return undefined;
    const timer = window.setTimeout(() => setIntroducing(false), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [intro]);
  useEffect(() => {
    const target = anchor.current?.closest<HTMLElement>("a, [data-mark-hover]");
    const on = () => setHovered(true);
    const off = () => setHovered(false);
    const onThinking = (event: Event) => setBusy(Boolean((event as CustomEvent<boolean>).detail));
    target?.addEventListener("pointerenter", on);
    target?.addEventListener("pointerleave", off);
    target?.addEventListener("focusin", on);
    target?.addEventListener("focusout", off);
    window.addEventListener(THINKING_EVENT, onThinking);
    return () => {
      target?.removeEventListener("pointerenter", on);
      target?.removeEventListener("pointerleave", off);
      target?.removeEventListener("focusin", on);
      target?.removeEventListener("focusout", off);
      window.removeEventListener(THINKING_EVENT, onThinking);
    };
  }, [anchor]);
  return hovered || busy || introducing;
}
