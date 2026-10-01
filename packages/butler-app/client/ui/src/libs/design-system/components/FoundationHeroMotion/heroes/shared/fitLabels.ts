/** The smallest a label group is set, so a label never shrinks past legibility (its box should be sized instead). */
const MIN_FIT = 0.6;

/**
 * Labels that must never break inside a token name (`white-space: nowrap`)
 * fit their boxes instead: every `[data-fit-label]` of a `[data-fit]` group
 * is measured unscaled, and the group gets one `--label-fit` (the tightest
 * label's ratio), so all its labels stay one size. Styles read it as
 * `calc(<font-size> * var(--label-fit, 1))`. Call before measuring a layout.
 */
export function fitLabels(root: HTMLElement): void {
  for (const group of root.querySelectorAll<HTMLElement>("[data-fit]")) {
    group.style.removeProperty("--label-fit");
    const labels = [...group.querySelectorAll<HTMLElement>("[data-fit-label]")].filter((label) => label.clientWidth > 0);
    const ratio = Math.min(1, ...labels.map((label) => label.clientWidth / Math.max(1, label.scrollWidth)));
    if (ratio < 1) group.style.setProperty("--label-fit", String(Math.max(MIN_FIT, Math.floor(ratio * 1000) / 1000)));
  }
}
