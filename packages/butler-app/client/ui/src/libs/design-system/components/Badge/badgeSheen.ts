// When a Badge's sheen lap runs. CSS owns the look and the one-lap keyframes (transform on ::after); this file only
// starts laps, one timer for every badge, and only while a badge is on screen in a visible, focused window with motion
// allowed. Between laps no animation exists.
import { motionDuration, prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";

const badges = new Set<HTMLElement>();
const onScreen = new Set<HTMLElement>();
let observer: IntersectionObserver | undefined;
let timer: number | undefined;
let focused = true;
let stopSignals: (() => void) | undefined;

function canPlay(): boolean {
  return onScreen.size > 0 && document.visibilityState === "visible" && focused && !prefersReducedMotion();
}

function lapRunning(): boolean {
  for (const badge of badges) if (badge.dataset.sheen) return true;
  return false;
}

function clearTimer(): void {
  window.clearTimeout(timer);
  timer = undefined;
}

function schedule(delay: number): void {
  clearTimer();
  if (!canPlay()) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    if (!canPlay()) return;
    for (const badge of onScreen) badge.dataset.sheen = "run";
  }, delay);
}

/** After any signal: stop at once when no badge can be seen, else make sure a lap is coming. */
function update(): void {
  if (!canPlay()) {
    clearTimer();
    for (const badge of badges) delete badge.dataset.sheen;
    return;
  }
  // The first lap follows shortly, so it never overlaps the page's own enter motion.
  if (timer === undefined && !lapRunning()) schedule(motionDuration("deliberate"));
}

function onLapEnd(event: AnimationEvent): void {
  if (event.pseudoElement !== "::after") return;
  delete (event.currentTarget as HTMLElement).dataset.sheen;
  if (!lapRunning()) schedule(motionDuration("sheen-pause"));
}

function startSignals(): void {
  focused = document.hasFocus();
  const focus = () => { focused = true; update(); };
  const blur = () => { focused = false; update(); };
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", update);
  const stopMotion = subscribeReducedMotion(() => update());
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const badge = entry.target as HTMLElement;
      if (entry.isIntersecting) onScreen.add(badge);
      else onScreen.delete(badge);
    }
    update();
  });
  stopSignals = () => {
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
    document.removeEventListener("visibilitychange", update);
    stopMotion();
    observer?.disconnect();
    observer = undefined;
    clearTimer();
  };
}

/** Registers one badge; returns its cleanup. The last badge to leave removes every listener and the timer. */
export function playBadgeSheen(badge: HTMLElement): () => void {
  if (badges.size === 0) startSignals();
  badges.add(badge);
  badge.addEventListener("animationend", onLapEnd);
  observer?.observe(badge);
  return () => {
    badge.removeEventListener("animationend", onLapEnd);
    observer?.unobserve(badge);
    delete badge.dataset.sheen;
    badges.delete(badge);
    onScreen.delete(badge);
    if (badges.size === 0) {
      stopSignals?.();
      stopSignals = undefined;
    } else update();
  };
}
