import styles from "./SetupWizardMorph.module.css";

/** The morph's two layers: the card surface and the clip on the larger card (SetupWizardMorph.module.css). */
const SURFACE_VARS = ["--setup-morph-top", "--setup-morph-from-left", "--setup-morph-from-width", "--setup-morph-from-height",
  "--setup-morph-to-left", "--setup-morph-to-width", "--setup-morph-to-height"] as const;
const CLIP_VARS = ["--setup-morph-clip-from", "--setup-morph-clip-to"] as const;

export interface SetupMorphBox { left: number; top: number; width: number; height: number }

const px = (value: number) => `${Math.max(0, value).toFixed(2)}px`;

/** An element's rect relative to `origin`. */
export function boxIn(element: Element, origin: DOMRect): SetupMorphBox {
  const rect = element.getBoundingClientRect();
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height };
}

/** The small card's rect as an inset of the big card, with the card's own corner radius. */
function insetOf(big: SetupMorphBox, small: SetupMorphBox, radius: string): string {
  const right = big.left + big.width - small.left - small.width;
  const bottom = big.top + big.height - small.top - small.height;
  return `inset(${px(small.top - big.top)} ${px(right)} ${px(bottom)} ${px(small.left - big.left)} round ${radius})`;
}

/**
 * Puts the surface on the old rect and clips the larger card to the smaller
 * rect, commits that, then switches both to their end state so the
 * transitions run (top edge fixed at the new card's top).
 */
export function startLayers(surface: HTMLElement, big: HTMLElement, from: SetupMorphBox, to: SetupMorphBox, grow: boolean) {
  const radius = getComputedStyle(big).borderTopLeftRadius;
  const closed = insetOf(grow ? to : from, grow ? from : to, radius);
  const open = `inset(0px round ${radius})`;
  const values = [to.top, from.left, from.width, from.height, to.left, to.width, to.height];
  SURFACE_VARS.forEach((name, index) => surface.style.setProperty(name, `${values[index]!.toFixed(2)}px`));
  surface.hidden = false;
  big.style.setProperty(CLIP_VARS[0], grow ? closed : open);
  big.style.setProperty(CLIP_VARS[1], grow ? open : closed);
  big.classList.add(styles.clip);
  void surface.offsetWidth;
  surface.dataset.phase = "to";
  big.dataset.phase = "to";
}

/**
 * A static copy of a step frame. A cloned canvas comes out blank, so each
 * canvas (the mark) is copied as an image of its current pixels, sized like
 * the original.
 */
export function copyFrame(frame: HTMLElement): HTMLElement {
  const copy = frame.cloneNode(true) as HTMLElement;
  const sources = frame.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, index) => {
    const source = sources[index];
    if (!source) return;
    const image = document.createElement("img");
    try { image.src = source.toDataURL(); } catch { return; }
    image.alt = "";
    image.className = canvas.className;
    image.setAttribute("style", canvas.getAttribute("style") ?? "");
    image.style.width = `${source.clientWidth}px`;
    image.style.height = `${source.clientHeight}px`;
    canvas.replaceWith(image);
  });
  return copy;
}

/** At rest no surface or clip remains. */
export function clearLayers(surface: HTMLElement, big: HTMLElement) {
  surface.hidden = true;
  delete surface.dataset.phase;
  for (const name of SURFACE_VARS) surface.style.removeProperty(name);
  big.classList.remove(styles.clip);
  delete big.dataset.phase;
  for (const name of CLIP_VARS) big.style.removeProperty(name);
}
