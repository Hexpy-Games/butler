// Runs the shell side of the first-run ink intro against its timeline: measures the card and the mark slot for the
// GL scene, plays the card motion when the reveal starts, skips on a click or a key, pauses with the clock, and
// sends the print beat and the hand-off when the card changes.
import { prefersReducedMotion } from "../../lib/motion";
import type { WallpaperIntroEvent, WallpaperIntroTimeline } from "../Wallpaper/intro/introTimeline";
import { hideSurface, type SetupMorphBox } from "./setupMorphLayers";
import { playSetupIntro } from "./setupIntroMotion";

/** pending: the card waits for the reveal; play: the reveal runs (the card takes no input, a click skips). */
export type SetupIntroPhase = "pending" | "play" | null;

export interface SetupIntroRun {
  /** The card or its slot moved (a step change settled). */
  measure(): void;
  /** The step changed: the print shifts between the two card rects (stage px) and the intro hands off. */
  stepChanged(from: SetupMorphBox | null, to: SetupMorphBox | null): void;
  dispose(): void;
}

interface SetupIntroOptions {
  stage: HTMLElement;
  surface: HTMLElement;
  frame(): HTMLElement | null;
  timeline: WallpaperIntroTimeline;
  /** The re-run variant: the card has its own entrance; the print is drawn still. */
  rerun: boolean;
  onPhase(phase: SetupIntroPhase): void;
}

/** If nothing starts the reveal while the window shows (no wallpaper engine at all), the card appears anyway. */
const SETUP_INTRO_START_TIMEOUT_MS = 1500;

const client = (box: SetupMorphBox, origin: DOMRect) => ({ x: box.left + origin.left, y: box.top + origin.top, width: box.width, height: box.height });

export function runSetupIntro({ stage, surface, frame, timeline, rerun, onPhase }: SetupIntroOptions): SetupIntroRun {
  let animations: Animation[] = [];
  let scroll = 0;
  const measure = () => {
    const card = frame()?.querySelector("[data-setup-card]");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const slot = card.querySelector("[data-setup-mark]")?.getBoundingClientRect();
    timeline.setLayout({
      card: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      slot: slot ? { x: slot.left + slot.width / 2, y: slot.top + slot.height / 2 } : null,
    });
  };
  const onScroll = () => {
    if (!scroll) scroll = requestAnimationFrame(() => { scroll = 0; measure(); });
  };
  const skip = (event: Event) => {
    if (event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey || event.altKey)) return;
    timeline.skip();
  };
  const listen = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("pointerdown", skip, true);
    window[method]("keydown", skip, true);
  };
  const end = () => {
    listen(false);
    animations = [];
    hideSurface(surface);
    onPhase(null);
  };
  const play = (started: "full" | "still" | "fallback") => {
    const node = frame();
    if (rerun || !node) return onPhase(null);
    // Reduced motion without WebGL2: the still card fade, never the SVG draw.
    const kind = started === "fallback" && prefersReducedMotion() ? "still" : started;
    animations = playSetupIntro(stage, surface, node, kind);
    onPhase(animations.length && kind !== "still" ? "play" : null);
    if (!animations.length) return end();
    if (kind !== "still") listen(true);
    if (document.hidden) for (const animation of animations) animation.pause();
    const running = animations;
    void Promise.all(running.map((animation) => animation.finished)).then(() => { if (animations === running) end(); }, () => undefined);
  };
  const onEvent = (event: WallpaperIntroEvent) => {
    if (event.type === "start") play(event.kind);
    else if (event.type === "skip") for (const animation of animations) animation.finish();
    else if (event.type === "pause") for (const animation of animations) animation.pause();
    else if (event.type === "resume") for (const animation of animations) animation.play();
  };

  const unsubscribe = timeline.subscribe(onEvent);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  observer?.observe(stage);
  window.addEventListener("resize", measure);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  measure();
  const fallback = window.setTimeout(() => { if (timeline.started() === null && !document.hidden) timeline.start("still"); }, SETUP_INTRO_START_TIMEOUT_MS);
  if (timeline.started() !== null) play(timeline.started()!);

  return {
    measure,
    stepChanged(from, to) {
      const origin = stage.getBoundingClientRect();
      if (from && to) timeline.beat(client(from, origin), client(to, origin));
      measure();
      timeline.handoff();
    },
    dispose() {
      window.clearTimeout(fallback);
      cancelAnimationFrame(scroll);
      unsubscribe();
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", onScroll, { capture: true });
      listen(false);
      for (const animation of animations) animation.cancel();
      hideSurface(surface);
    },
  };
}
