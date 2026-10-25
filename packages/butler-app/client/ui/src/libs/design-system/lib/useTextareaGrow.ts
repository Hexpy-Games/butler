import { useCallback, useLayoutEffect, type RefObject } from "react";

/**
 * How a textarea grows: `lines` (underline: whole lines plus the focus line) or `content` (bordered: the
 * content box plus borders, clamped by the CSS min and max height); `null` does not grow.
 */
export type TextareaGrowMode = "lines" | "content" | null;

/** Native content sizing first; older engines measure only on edits/width changes. */
export function useTextareaGrow(ref: RefObject<HTMLTextAreaElement | null>, mode: TextareaGrowMode, value: unknown) {
  const enabled = mode !== null;
  const grow = useCallback(() => {
    const element = ref.current;
    if (!mode || !element || CSS.supports("field-sizing", "content")) return;
    const css = getComputedStyle(element);
    element.style.height = "0px";
    if (mode === "content") {
      element.style.height = `${element.scrollHeight + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth)}px`;
      return;
    }
    const line = parseFloat(css.lineHeight);
    const reserved = parseFloat(css.getPropertyValue("--focus-ring-width"));
    const padding = parseFloat(css.paddingBottom);
    const lines = Math.max(1, Math.round((element.scrollHeight - padding) / line));
    element.style.height = `${lines * line + reserved}px`;
  }, [ref, mode]);
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
