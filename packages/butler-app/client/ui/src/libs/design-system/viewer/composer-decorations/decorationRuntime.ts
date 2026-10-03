import { animateMotion, motionDuration, prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import type { DecorationSettings } from "./types";

export interface DecorationMetrics {
  edits: number; frames: number; mainMs: number; maxInputMs: number; active: boolean;
}

function spriteMotion(root: HTMLElement, settings: DecorationSettings) {
  const strength = settings.intensity / 100;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-decor-sprite]"), (sprite, index) => {
    const direction = index % 2 ? 1 : -1;
    const peak = settings.theme === "flowers" ? `rotate(${direction * strength * 12}deg)`
      : settings.theme === "cherry" ? `translate(${strength * 8}px, ${strength * 8}px) rotate(${direction * 20}deg)`
        : `translateY(${-strength * 8}px) rotate(${direction * strength * 5}deg)`;
    const animation = animateMotion(sprite, [{ transform: "none" }, { transform: peak, offset: 0.45 }, { transform: "none" }],
      { duration: "deliberate", easing: "standard" });
    animation?.cancel();
    return animation;
  }).filter((animation): animation is Animation => animation !== null);
}

/** Content-free, event-driven response. Cached timing/animations; one pending frame, no idle timer. */
export function decorationRuntime(root: HTMLElement, settings: DecorationSettings,
  report: (metrics: DecorationMetrics) => void, drawCoast?: (delta: number) => void) {
  let animations = spriteMotion(root, settings);
  const metrics: DecorationMetrics = { edits: 0, frames: 0, mainMs: 0, maxInputMs: 0, active: false };
  const duration = motionDuration("deliberate");
  let reduced = prefersReducedMotion();
  let visible = true;
  let frame = 0;
  let until = 0;
  let previous = 0;
  let pending = false;
  const publish = () => report({ ...metrics });
  const stop = () => {
    cancelAnimationFrame(frame); frame = 0; pending = false;
    animations.forEach(animation => animation.cancel());
    metrics.active = false; publish();
  };
  const tick = (now: number) => {
    frame = 0;
    if (document.hidden || !visible || reduced) { stop(); return; }
    const start = performance.now();
    if (pending) {
      animations.forEach(animation => {
        if (animation.playState !== "running") { animation.currentTime = 0; animation.play(); }
      });
      pending = false;
    }
    // Match the existing wallpaper's 20fps policy; sprite motion stays compositor-driven.
    if (drawCoast && now - previous >= 50) {
      drawCoast((now - previous) * settings.intensity / 100);
      previous = now;
    }
    metrics.frames += 1;
    if (now < until) frame = requestAnimationFrame(tick);
    else { animations.forEach(animation => animation.cancel()); metrics.active = false; }
    metrics.mainMs += performance.now() - start;
    if (!frame) publish();
  };
  const pulse = () => {
    if (settings.mode === "static" || reduced || !visible || document.hidden) return;
    const start = performance.now();
    metrics.edits += 1; metrics.active = true; pending = true;
    until = start + duration;
    if (!frame) { previous = start; frame = requestAnimationFrame(tick); }
    publish();
    const elapsed = performance.now() - start;
    metrics.mainMs += elapsed; metrics.maxInputMs = Math.max(metrics.maxInputMs, elapsed);
  };
  const unsubscribe = subscribeReducedMotion(value => {
    reduced = value;
    if (value) stop();
    else if (animations.length === 0) animations = spriteMotion(root, settings);
  });
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (!visible) stop(); });
  observer.observe(root);
  const visibility = () => { if (document.hidden) stop(); };
  document.addEventListener("visibilitychange", visibility);
  publish();
  return { pulse, stop, dispose() {
    stop(); unsubscribe(); observer.disconnect();
    document.removeEventListener("visibilitychange", visibility);
  } };
}
