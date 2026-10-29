import { animateMotion, motionDuration, prefersReducedMotion } from "./motion";
import styles from "./saveFlight.module.css";

/**
 * Save flight (DS spec Motion Contract): a saved piece of content flies into the place it was saved to
 * (the 서랍 entry). A ghost of the content's box (surface, line and radius; no content, so nothing is
 * cloned or re-rendered) leaves from the content and lands on the target, shrinking to the target's
 * size; the content itself never moves. With reduced motion, or when the target is missing or off
 * screen, it crossfades instead: the ghost fades out over the content and the target fades its mark in.
 */
export interface SaveFlight {
  cancel: () => void;
}

function visible(box: DOMRect): boolean {
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0
    && box.top < window.innerHeight && box.left < window.innerWidth;
}

function ghostAt(box: DOMRect): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = styles.ghost!;
  ghost.setAttribute("aria-hidden", "true");
  ghost.dataset.slot = "save-flight";
  Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  document.body.append(ghost);
  return ghost;
}

/** Fly `source`'s box into `target` (null: no visible target, crossfade). Returns null when nothing ran. */
export function flySaveToTarget(source: Element, target: Element | null): SaveFlight | null {
  const from = source.getBoundingClientRect();
  if (!visible(from)) return null;
  const to = target?.getBoundingClientRect();
  const ghost = ghostAt(from);
  const flies = Boolean(to && visible(to)) && !prefersReducedMotion();
  const animations: (Animation | null)[] = [];
  if (flies && to) {
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const scale = Math.max(to.width / from.width, to.height / from.height, 0.02);
    animations.push(animateMotion(ghost, [
      { opacity: 0.9, translate: "0px 0px", scale: "1" },
      { opacity: 0.6, offset: 0.7 },
      { opacity: 0, translate: `${dx}px ${dy}px`, scale: `${scale}` },
    ], { duration: "flight", easing: "emphasized", fill: "forwards" }));
    animations.push(animateMotion(target!, [{ scale: "1" }, { scale: "1.12", offset: 0.4 }, { scale: "1" }],
      { duration: "slow", easing: "standard", delay: Math.round(motionDuration("flight") * 0.75) }));
  } else {
    animations.push(animateMotion(ghost, [{ opacity: 0.9 }, { opacity: 0 }], { duration: "slow", easing: "standard", fill: "forwards" }));
    if (target) animations.push(animateMotion(target, [{ opacity: 0.4 }, { opacity: 1 }], { duration: "slow", easing: "standard" }));
  }
  const main = animations[0];
  const done = () => ghost.remove();
  if (main) main.finished.then(done, done);
  else done();
  return { cancel: () => { for (const animation of animations) animation?.cancel(); done(); } };
}
