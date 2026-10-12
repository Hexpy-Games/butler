import { animateMotion, motionDistance, motionDuration } from "../../lib/motion";
import { boxIn, clearLayers, retargetLayers, startLayers, type SetupMorphBox } from "./setupMorphLayers";

/** A solid setup card (`SetupWizardContent surface="solid"`). */
const CARD = "[data-setup-card]";
/** A row group whose children arrive one by one (the step card's body). */
const ROW_GROUP = "data-setup-rows";

export type { SetupMorphBox };

export interface SetupWizardMorph {
  /** The card rects relative to the stage: the print beat and the ink keep-out follow them. */
  from: SetupMorphBox;
  to: SetupMorphBox;
  /** Jumps to the end state at once (a resize or new copy makes the measured rects stale). */
  finish(): void;
}

/** Both frames hold a solid card: any step change morphs, whether the width (420 and 520px), the height or both change. */
export function canMorph(from: Element, to: Element): boolean {
  return from.querySelector(CARD) !== null && to.querySelector(CARD) !== null;
}

/** The card's rows in reading order; a row group (the step body) contributes its own children. */
function cardRows(card: Element): Element[] {
  const column = card.firstElementChild;
  if (!column) return [];
  return [...column.children].flatMap((row) => (row.hasAttribute(ROW_GROUP) ? [...row.children] : [row]));
}

const present = (animation: Animation | null): animation is Animation => animation !== null;

/** The new card's rows rise in once the surface is nearly there, one after another; `elapsed` is the morph time already gone. */
function riseRows(toCard: Element, elapsed: number): Animation[] {
  const rise = `translateY(${motionDistance("sm")}px)`;
  const start = motionDuration("morph-rows") - elapsed;
  const step = motionDuration("stagger-row");
  return cardRows(toCard).map((row, index) => animateMotion(row, [{ opacity: 0, transform: rise }, { opacity: 1, transform: "none" }],
    { duration: "base", easing: "decelerate", delay: Math.max(0, start + index * step), fill: "backwards" })).filter(present);
}

/** A visibilitychange listener: pauses the running animations while the document is hidden and plays them on return. */
function pauseWhileHidden(running: () => Animation[]): () => void {
  let paused: Animation[] = [];
  return () => {
    if (document.hidden) {
      paused = running().filter((animation) => animation.playState === "running");
      for (const animation of paused) animation.pause();
    } else {
      for (const animation of paused) animation.play();
      paused = [];
    }
  };
}

/** Within half a pixel: a re-measure that moved nothing changes nothing. */
const sameBox = (a: SetupMorphBox, b: SetupMorphBox) =>
  Math.abs(a.left - b.left) + Math.abs(a.top - b.top) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height) < 0.5;

/**
 * Morphs the card in `fromFrame` (an inert copy of the old step) into the
 * card in `toFrame` (rev 5 container transform), for every step change in
 * either direction. One surface with the card paint moves its real edges from
 * one rect to the other on --motion-deliberate/--motion-ease-emphasized with
 * the top edge fixed; both cards hide their own paint and the content of the
 * larger card is clipped to the moving edge. While it runs the stage takes no
 * clicks; a window resize finishes it at once, the new card settling its own
 * size (content that loads in) retargets the edge from where it is, and a
 * hidden document pauses it. At the end no surface, clip or animation
 * remains, and `onEnd` drops the old copy.
 */
export function startSetupMorph(stage: HTMLElement, surface: HTMLElement, fromFrame: Element, toFrame: Element, onEnd: () => void): SetupWizardMorph | null {
  const fromCard = fromFrame.querySelector<HTMLElement>(CARD);
  const toCard = toFrame.querySelector<HTMLElement>(CARD);
  if (!fromCard || !toCard) return null;
  const origin = stage.getBoundingClientRect();
  const from = boxIn(fromCard, origin);
  let to = boxIn(toCard, origin);
  const grow = to.width * to.height >= from.width * from.height;
  const big = grow ? toCard : fromCard;
  stage.dataset.morph = "run";
  const radius = startLayers(surface, big, from, to, grow);
  // The old content leaves in the first third (sooner going back, where the shrinking edge reaches it).
  const out = animateMotion(fromCard, [{ opacity: 1 }, { opacity: 0 }],
    { duration: grow ? "exit-base" : "exit-fast", easing: "accelerate", fill: "forwards" });
  const startedAt = performance.now();
  let rows: Animation[] | null = null;
  let run: Animation[] = [];
  let done = false;
  let generation = 0;
  let frame = 0;
  // getAnimations() flushes style once, so a retargeted transition is the one collected.
  const collect = () => { run = [...surface.getAnimations(), ...big.getAnimations(), out, ...(rows ?? [])].filter(present); };
  // A transition the browser cancels on its own (a node replaced mid-morph) jumps to the end; the cancel of a retarget does not.
  const settle = () => {
    const mine = ++generation;
    void Promise.all(run.map((animation) => animation.finished)).then(() => { if (mine === generation) end(); }, () => { if (mine === generation) finish(); });
  };
  const block = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  const visibility = pauseWhileHidden(() => run);
  const retarget = () => {
    if (done) return;
    const next = boxIn(toCard, stage.getBoundingClientRect());
    if (sameBox(next, to)) return;
    to = next;
    retargetLayers(surface, big, from, to, grow, radius);
    if (rows) { collect(); settle(); }
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(retarget) : null;
  const end = () => {
    if (done) return;
    done = true;
    window.removeEventListener("resize", finish);
    document.removeEventListener("visibilitychange", visibility);
    stage.removeEventListener("click", block, true);
    observer?.disconnect();
    cancelAnimationFrame(frame);
    for (const animation of run) animation.cancel();
    clearLayers(surface, big);
    delete stage.dataset.morph;
    onEnd();
  };
  function finish() {
    if (done) return;
    collect();
    for (const animation of run) {
      // A transition the browser already cancelled has no end to jump to.
      try { animation.finish(); } catch { /* end() below still clears every layer */ }
    }
    end();
  }
  window.addEventListener("resize", finish);
  document.addEventListener("visibilitychange", visibility);
  stage.addEventListener("click", block, true);
  observer?.observe(toCard);
  // Rows are found in the next frame, before it paints: a step that re-keys its body while it
  // mounts (SetupWizardStepCard contentKey) has replaced those nodes by then.
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (done) return;
    rows = riseRows(toCard, performance.now() - startedAt);
    collect();
    settle();
  });
  return { from, to, finish };
}
