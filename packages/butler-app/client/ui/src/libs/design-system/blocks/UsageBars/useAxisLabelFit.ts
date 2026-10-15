import { useLayoutEffect, type RefObject } from "react";

/**
 * Keeps labels inside the axis (a label that would spill past an edge shifts
 * back in), then hides labels that would touch a kept neighbour; the last
 * label (usually "now") always stays.
 */
function fitLabels(axis: HTMLElement): void {
  const labels = [...axis.children] as HTMLElement[];
  for (const label of labels) {
    delete label.dataset.hidden;
    label.style.removeProperty("--usage-bars-nudge");
  }
  // Read every box first, then write, so the fit costs one layout.
  const bounds = axis.getBoundingClientRect();
  const measured = labels.map((label) => label.getBoundingClientRect());
  const rects = measured.map((rect, index) => {
    const nudge = Math.max(0, bounds.left - rect.left) + Math.min(0, bounds.right - rect.right);
    if (nudge !== 0) labels[index]!.style.setProperty("--usage-bars-nudge", `${nudge}px`);
    return { left: rect.left + nudge, right: rect.right + nudge };
  });
  if (labels.length < 2) return;
  const gap = Number.parseFloat(window.getComputedStyle(axis).columnGap) || 0;
  const last = rects[rects.length - 1]!;
  let keptRight = -Infinity;
  rects.forEach((rect, index) => {
    if (index === rects.length - 1) return;
    if (rect.left < keptRight + gap || rect.right + gap > last.left) labels[index]!.dataset.hidden = "true";
    else keptRight = rect.right;
  });
}

/**
 * Axis labels are the caller's anchors; on a narrow chart some of them would
 * overlap. This keeps a readable subset: left to right, a label stays only
 * when it clears the previous kept one and the last one. Re-fits on resize.
 */
export function useAxisLabelFit(axisRef: RefObject<HTMLElement | null>, signature: string): void {
  useLayoutEffect(() => {
    const axis = axisRef.current;
    if (!axis) return undefined;
    let live = true;
    fitLabels(axis);
    // Label widths change once the web font arrives.
    void document.fonts?.ready.then(() => { if (live) fitLabels(axis); });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitLabels(axis)) : null;
    observer?.observe(axis);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [axisRef, signature]);
}
