/**
 * While a finite animation runs on `element` or an ancestor (an inspector
 * track sliding open moves the page under it every frame), calls `settled`
 * once all of them have ended and returns true. Returns false, and never
 * calls `settled`, when none runs.
 */
export function waitForAncestorMotion(element: Element, settled: () => void): boolean {
  const motion = ancestorMotion(element);
  if (!motion.length) return false;
  void Promise.allSettled(motion.map((animation) => animation.finished)).then(settled);
  return true;
}

function ancestorMotion(element: Element): Animation[] {
  if (typeof document.getAnimations !== "function") return [];
  return document.getAnimations().filter((animation) => {
    const effect = animation.effect;
    const target = effect instanceof KeyframeEffect ? effect.target : null;
    return animation.playState === "running" && target !== null && target.contains(element)
      && Number.isFinite(Number(effect?.getComputedTiming().endTime));
  });
}
