import { animateMotion, motionDuration, prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import type { CoastalScene } from "./coastalScene";
import type { DecorationSettings } from "./types";
import { decorationVisibility } from "./decorationVisibility";

export interface DecorationMetrics {
  edits: number; frames: number; mainMs: number; maxInputMs: number; active: boolean;
  drawMs: number; gpuMs: number; gpuSamples: number; gpuAvailable: boolean; ambient: boolean;
}

function spriteMotion(root: HTMLElement, settings: DecorationSettings) {
  const strength = settings.intensity / 100;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-decor-sprite]"), (sprite, index) => {
    const direction = index % 2 ? 1 : -1;
    const peak = settings.theme === "flowers" ? `rotate(${direction * strength * 12}deg)`
      : settings.theme === "cherry" ? `translate(${strength * 26}px, ${strength * 38}px) rotate(${direction * 40}deg)`
        : `translateY(${-strength * 8}px) rotate(${direction * strength * 5}deg)`;
    const frames = settings.theme === "cherry"
      ? [{ transform: "none", opacity: 0.8 }, { transform: peak, opacity: 0 }]
      : [{ transform: "none" }, { transform: peak, offset: 0.45 }, { transform: "none" }];
    const animation = animateMotion(sprite, frames, { duration: "deliberate", easing: "standard" });
    animation?.cancel();
    return animation;
  }).filter((animation): animation is Animation => animation !== null);
}

/** Coast alone is ambient. Other themes schedule only a finite committed-edit response. */
export function decorationRuntime(root: HTMLElement, settings: DecorationSettings,
  report: (metrics: DecorationMetrics) => void, coast?: CoastalScene) {
  let animations = spriteMotion(root, settings);
  const metrics: DecorationMetrics = { edits: 0, frames: 0, mainMs: 0, maxInputMs: 0, active: false,
    drawMs: 0, gpuMs: 0, gpuSamples: 0, gpuAvailable: false, ambient: false };
  const duration = motionDuration("deliberate");
  let reduced = prefersReducedMotion();
  let visible = false;
  let frame = 0;
  let timer = 0;
  let until = 0;
  let previous = 0;
  let pending = false;
  const canvas = root.querySelector("canvas");
  const publish = () => report({ ...metrics });
  const allowed = () => visible && !document.hidden && !canvas?.dataset.error;
  const moving = () => allowed() && !reduced && settings.mode === "interactive" && settings.theme !== "none";
  const stop = () => {
    cancelAnimationFrame(frame); clearTimeout(timer); frame = 0; timer = 0; pending = false; until = 0;
    animations.forEach(animation => animation.cancel());
    metrics.active = false; metrics.ambient = false; publish();
  };
  const draw = (delta: number, pulse: number) => {
    if (!coast) return;
    const start = performance.now();
    Object.assign(metrics, coast.draw(delta, pulse));
    metrics.drawMs += performance.now() - start; metrics.frames += 1;
  };
  const tick = (now: number) => {
    frame = 0;
    if (!moving()) { stop(); return; }
    const start = performance.now();
    if (pending) animations.forEach(animation => {
      if (animation.playState !== "running") { animation.currentTime = 0; animation.play(); }
    });
    pending = false;
    metrics.mainMs += performance.now() - start;
    const response = Math.max(0, (until - now) / duration);
    draw(Math.min(now - previous, 100), Math.sin(response * Math.PI) * settings.intensity / 100);
    previous = now;
    metrics.active = now < until;
    if (coast) timer = window.setTimeout(() => { timer = 0; frame = requestAnimationFrame(tick); }, 1000 / 30);
    else if (metrics.active) frame = requestAnimationFrame(tick);
    else animations.forEach(animation => animation.cancel());
    if (!coast) metrics.frames += 1;
    publish();
  };
  const resume = () => {
    if (coast && moving() && !frame && !timer) {
      previous = performance.now(); metrics.ambient = true; frame = requestAnimationFrame(tick);
    }
  };
  const pulse = () => {
    const start = performance.now();
    if (!moving()) return;
    metrics.edits += 1; metrics.active = true; pending = true; until = start + duration;
    if (!frame && !timer) frame = requestAnimationFrame(tick);
    const elapsed = performance.now() - start;
    metrics.mainMs += elapsed; metrics.maxInputMs = Math.max(metrics.maxInputMs, elapsed);
  };
  const unsubscribe = subscribeReducedMotion(value => {
    reduced = value; stop();
    if (!value && animations.length === 0) animations = spriteMotion(root, settings);
    if (allowed()) draw(0, 0);
    resume(); publish();
  });
  const detach = decorationVisibility(root, coast, value => {
    visible = value; stop(); if (allowed()) draw(0, 0); resume(); publish();
  });
  publish();
  return { pulse, blur() { if (!coast) stop(); }, dispose() { stop(); unsubscribe(); detach(); } };
}
