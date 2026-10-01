import { useCallback, useLayoutEffect, type RefObject } from "react";

/** Native content sizing first; older engines measure only on edits/width changes. */
export function useTextareaGrow(ref: RefObject<HTMLTextAreaElement | null>, enabled: boolean, value: unknown) {
  const grow = useCallback(() => {
    const element = ref.current;
    if (!enabled || !element || CSS.supports("field-sizing", "content")) return;
    const css = getComputedStyle(element);
    const line = parseFloat(css.lineHeight);
    const reserved = parseFloat(css.getPropertyValue("--focus-ring-width"));
    const padding = parseFloat(css.paddingBottom);
    element.style.height = "0px";
    const lines = Math.max(1, Math.round((element.scrollHeight - padding) / line));
    element.style.height = `${lines * line + reserved}px`;
  }, [ref, enabled]);
  useLayoutEffect(grow, [grow, value]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    let width = -1;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; grow(); }
    });
    observer.observe(element);
    void document.fonts.ready.then(grow);
    return () => observer.disconnect();
  }, [ref, grow, enabled]);
  return grow;
}
