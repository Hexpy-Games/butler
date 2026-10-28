/** Browser-context predicate: scroll-driven motion follows position, not elapsed time. */
export function timeBasedFiniteAnimationsSettled(): boolean {
  return document.getAnimations().every(animation =>
    !(animation.timeline instanceof DocumentTimeline)
    || animation.effect?.getTiming().iterations === Infinity
    || animation.playState !== "running");
}
