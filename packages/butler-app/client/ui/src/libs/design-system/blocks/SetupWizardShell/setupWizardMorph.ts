import { animateMotion, motionDistance, motionDuration } from "../../lib/motion";
import styles from "./SetupWizardMorph.module.css";

/** A solid setup card (`SetupWizardContent surface="solid"`). */
const CARD = "[data-setup-card]";
/** A row group whose children arrive one by one (the step card's body). */
const ROW_GROUP = "data-setup-rows";
const SURFACE_VARS = ["--setup-morph-top", "--setup-morph-from-left", "--setup-morph-from-width", "--setup-morph-from-height",
  "--setup-morph-to-left", "--setup-morph-to-width", "--setup-morph-to-height"] as const;
const CLIP_VARS = ["--setup-morph-clip-from", "--setup-morph-clip-to"] as const;

export interface SetupMorphBox { left: number; top: number; width: number; height: number }

export interface SetupWizardMorph {
  /** The card rects relative to the stage: the print beat and the ink keep-out follow them. */
  from: SetupMorphBox;
  to: SetupMorphBox;
  /** Jumps to the end state at once (a resize or new copy makes the measured rects stale). */
  finish(): void;
}

const px = (value: number) => `${Math.max(0, value).toFixed(2)}px`;

function boxIn(element: Element, origin: DOMRect): SetupMorphBox {
  const rect = element.getBoundingClientRect();
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height };
}

/** Both frames hold a solid card and the card width changes (the 420px intro and a 520px step). */
export function canMorph(from: Element, to: Element): boolean {
  const before = from.querySelector(CARD);
  const after = to.querySelector(CARD);
  return Boolean(before && after && before.getAttribute("data-width") !== after.getAttribute("data-width"));
}

/** The card's rows in reading order; a row group (the step body) contributes its own children. */
function cardRows(card: Element): Element[] {
  const column = card.firstElementChild;
  if (!column) return [];
  return [...column.children].flatMap((row) => (row.hasAttribute(ROW_GROUP) ? [...row.children] : [row]));
}

/** The small card's rect as an inset of the big card, with the card's own corner radius. */
function insetOf(big: SetupMorphBox, small: SetupMorphBox, radius: string): string {
  const right = big.left + big.width - small.left - small.width;
  const bottom = big.top + big.height - small.top - small.height;
  return `inset(${px(small.top - big.top)} ${px(right)} ${px(bottom)} ${px(small.left - big.left)} round ${radius})`;
}

function placeSurface(surface: HTMLElement, from: SetupMorphBox, to: SetupMorphBox) {
  const values = [to.top, from.left, from.width, from.height, to.left, to.width, to.height];
  SURFACE_VARS.forEach((name, index) => surface.style.setProperty(name, `${values[index]!.toFixed(2)}px`));
  surface.hidden = false;
}

/** Content swap: the old card's content leaves; the new card's rows rise in once the surface is nearly there. */
function swapContent(fromCard: HTMLElement, toCard: HTMLElement, grow: boolean): Array<Animation | null> {
  const out = animateMotion(fromCard, [{ opacity: 1 }, { opacity: 0 }],
    { duration: grow ? "exit-base" : "exit-fast", easing: "accelerate", fill: "forwards" });
  const rise = `translateY(${motionDistance("sm")}px)`;
  const start = motionDuration("morph-rows");
  const step = motionDuration("stagger-row");
  return [out, ...cardRows(toCard).map((row, index) => animateMotion(row, [{ opacity: 0, transform: rise }, { opacity: 1, transform: "none" }],
    { duration: "base", easing: "decelerate", delay: start + index * step, fill: "backwards" }))];
}

/**
 * Morphs the card in `fromFrame` (an inert copy of the old step) into the
 * card in `toFrame` (rev 5 container transform). One surface with the card
 * paint moves its real edges from one rect to the other on
 * --motion-deliberate/--motion-ease-emphasized with the top edge fixed; both
 * cards hide their own paint and the larger card's content is clipped to the
 * moving edge. While it runs the stage takes no clicks; a resize finishes it
 * at once and a hidden document pauses it. At the end no surface, clip or
 * animation remains, and `onEnd` drops the old copy.
 */
export function startSetupMorph(stage: HTMLElement, surface: HTMLElement, fromFrame: Element, toFrame: Element, onEnd: () => void): SetupWizardMorph | null {
  const fromCard = fromFrame.querySelector<HTMLElement>(CARD);
  const toCard = toFrame.querySelector<HTMLElement>(CARD);
  if (!fromCard || !toCard) return null;
  const origin = stage.getBoundingClientRect();
  const from = boxIn(fromCard, origin);
  const to = boxIn(toCard, origin);
  const grow = to.width * to.height >= from.width * from.height;
  const [big, bigBox, smallBox] = grow ? [toCard, to, from] : [fromCard, from, to];
  const radius = getComputedStyle(big).borderTopLeftRadius;
  const closed = insetOf(bigBox, smallBox, radius);
  const open = `inset(0px round ${radius})`;
  stage.dataset.morph = "run";
  placeSurface(surface, from, to);
  big.style.setProperty(CLIP_VARS[0], grow ? closed : open);
  big.style.setProperty(CLIP_VARS[1], grow ? open : closed);
  big.classList.add(styles.clip);
  // Commit the start geometry, then switch both layers to the end state so the transitions run.
  void surface.offsetWidth;
  surface.dataset.phase = "to";
  big.dataset.phase = "to";
  const run = [...surface.getAnimations(), ...big.getAnimations(), ...swapContent(fromCard, toCard, grow)]
    .filter((animation): animation is Animation => animation !== null);

  let done = false;
  let paused: Animation[] = [];
  let measured = false;
  const block = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  const visibility = () => {
    if (document.hidden) {
      paused = run.filter((animation) => animation.playState === "running");
      for (const animation of paused) animation.pause();
    } else {
      for (const animation of paused) animation.play();
      paused = [];
    }
  };
  const observer = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => { if (measured) finish(); measured = true; }) : null;
  const end = () => {
    if (done) return;
    done = true;
    window.removeEventListener("resize", finish);
    document.removeEventListener("visibilitychange", visibility);
    stage.removeEventListener("click", block, true);
    observer?.disconnect();
    for (const animation of run) animation.cancel();
    surface.hidden = true;
    delete surface.dataset.phase;
    for (const name of SURFACE_VARS) surface.style.removeProperty(name);
    big.classList.remove(styles.clip);
    delete big.dataset.phase;
    for (const name of CLIP_VARS) big.style.removeProperty(name);
    delete stage.dataset.morph;
    onEnd();
  };
  function finish() {
    if (done) return;
    for (const animation of run) animation.finish();
    end();
  }
  window.addEventListener("resize", finish);
  document.addEventListener("visibilitychange", visibility);
  stage.addEventListener("click", block, true);
  observer?.observe(toCard);
  // A transition the browser cancels on its own (a node replaced mid-morph) also jumps to the end.
  void Promise.all(run.map((animation) => animation.finished)).then(end, finish);
  return { from, to, finish };
}
