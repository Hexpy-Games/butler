import { useLayoutEffect, useState, type RefObject } from "react";
import { animateMotion, motionDistance, prefersReducedMotion } from "./motion";

/**
 * Send flight (DS spec Motion Contract, M7): the composer records where its
 * text box sat when the user sent, and the next user bubble that enters flies
 * from there to its place with `translate` only. User bubbles are
 * right-aligned, so the flight starts with the bubble's right edge on the
 * composer text box's right edge (text top on the composer text top): the
 * travel is mostly vertical instead of a slide from the composer's left. When no fresh origin exists,
 * the message is long (origin text or bubble taller than
 * SEND_FLIGHT_MAX_HEIGHT_RATIO of the viewport), the bubble is off screen or
 * reduced motion is on, callers keep the regular insert animation.
 */

/** An origin older than this no longer belongs to the bubble that enters. */
export const SEND_ORIGIN_MAX_AGE_MS = 800;
/** A long message (taller than this share of the viewport) never flies. */
export const SEND_FLIGHT_MAX_HEIGHT_RATIO = 0.35;
/** Travel beyond this uses --motion-deliberate instead of --motion-slow. */
const LONG_TRAVEL_PX = 240;
/** Frames in which the list may still scroll or re-measure the new row... */
const RETARGET_FRAMES = 8;
/** ...bounded in time, so the main-thread phase does not stretch at low frame rates. */
const RETARGET_WINDOW_MS = 64;

interface SendOrigin {
  /** Right edge of the composer's text box (content edge, inside padding). */
  right: number;
  top: number;
  /** Full height of the sent text, before clipping to the editor box. */
  height: number;
  at: number;
  claimedBy: Element | null;
}

let origin: SendOrigin | null = null;

function textRect(element: Element): DOMRect | null {
  try {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const box = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    if (box && box.width > 0 && box.height > 0) return box;
  } catch {
    // Fall back to the element box.
  }
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? box : null;
}

/** Remember where the sent text sat (the composer editor), clipped to what was visible. */
export function recordSendOrigin(element: Element | null | undefined): void {
  const box = element ? textRect(element) : null;
  if (!element || !box) {
    origin = null;
    return;
  }
  const visible = element.getBoundingClientRect();
  const paddingRight = px(window.getComputedStyle(element).paddingRight);
  origin = {
    right: visible.right - paddingRight,
    top: Math.max(box.top, visible.top, 0),
    height: box.height,
    at: Date.now(),
    claimedBy: null,
  };
}

function tooTall(height: number): boolean {
  return height > window.innerHeight * SEND_FLIGHT_MAX_HEIGHT_RATIO;
}

export function clearSendOrigin(): void {
  origin = null;
}

export function hasSendOrigin(): boolean {
  return Boolean(origin && Date.now() - origin.at <= SEND_ORIGIN_MAX_AGE_MS);
}

function claimOrigin(target: Element): SendOrigin | null {
  if (!origin || !hasSendOrigin()) return null;
  if (origin.claimedBy && origin.claimedBy !== target) return null;
  origin.claimedBy = target;
  return origin;
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SendFlight {
  cancel: () => void;
}

/**
 * Fly `target` (the bubble) from the recorded origin to where it is laid out.
 * Returns null when the caller should use the regular insert instead.
 */
export function flySendBubble(target: HTMLElement): SendFlight | null {
  if (prefersReducedMotion()) return null;
  const from = claimOrigin(target);
  if (!from) return null;
  const box = target.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  if (tooTall(from.height) || tooTall(box.height)) return null;
  const style = window.getComputedStyle(target);
  // Right-align the bubble's text edge to the composer text box and put its
  // text top where the composer text sat.
  const startRight = from.right + px(style.paddingRight);
  const startTop = from.top - px(style.paddingTop);
  const dx = Math.round(startRight - box.right);
  const dy = Math.round(startTop - box.top);
  if (Math.abs(dy) > window.innerHeight * 3) return null;
  const duration = Math.hypot(dx, dy) > LONG_TRAVEL_PX ? "deliberate" : "slow";
  // Where the flight currently starts from (its first keyframe offset).
  let fromX = dx;
  let fromY = dy;
  const fly = (x: number, y: number) => {
    fromX = x;
    fromY = y;
    return animateMotion(target, [{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }], { duration, easing: "decelerate" });
  };
  let animation = fly(dx, dy);
  if (!animation) return null;
  // Layout is read from the bubble's unanimated parent (plus the bubble's
  // offset in it), never from the bubble: reading the animated element's box
  // or computed translate would sample the compositor animation on the main
  // thread (style, layout and paint) in every retarget frame.
  const anchor = target.parentElement;
  const anchorStart = anchor?.getBoundingClientRect();
  const offsetLeft = box.left - (anchorStart?.left ?? 0);
  const offsetTop = box.top - (anchorStart?.top ?? 0);
  const startedAt = performance.now();

  // The list scrolls to the new row (in the same commit or a later frame) and
  // re-measures it during the next frames. Follow the new layout position
  // without a visual jump: keep the bubble where it was drawn before the
  // scroll moved it, and finish the remaining time toward the new place.
  // A bubble that ends outside the viewport uses the regular insert instead.
  let layoutLeft = box.left;
  let layoutTop = box.top;
  let frames = 0;
  let frame = 0;
  const check = () => {
    frame = 0;
    if (!animation || !target.isConnected || !anchor) return;
    const anchorBox = anchor.getBoundingClientRect();
    const left = anchorBox.left + offsetLeft;
    const top = anchorBox.top + offsetTop;
    // The eased progress gives the translate the bubble is drawn with.
    const progress = animation.effect?.getComputedTiming().progress ?? 0;
    const tx = fromX * (1 - progress);
    const ty = fromY * (1 - progress);
    if (frames === 0 && (top + box.height <= 0 || top >= window.innerHeight)) {
      animation.cancel();
      animation = animateMotion(target, [
        { opacity: 0, translate: `0px ${motionDistance("sm")}px` },
        { opacity: 1, translate: "0px 0px" },
      ], { duration: "base", easing: "decelerate" });
      return;
    }
    if (Math.abs(left - layoutLeft) > 0.5 || Math.abs(top - layoutTop) > 0.5) {
      // Where the bubble was on screen before the list moved it: the scroll
      // shifts the element (and its translate) with the content, so the
      // position seen after the scroll is not where the flight was drawn.
      const drawnLeft = layoutLeft + tx;
      const drawnTop = layoutTop + ty;
      layoutLeft = left;
      layoutTop = top;
      const elapsed = animation.currentTime;
      // The computed progress already has the decelerate easing applied.
      const remaining = 1 - (animation.effect?.getComputedTiming().progress ?? 0);
      if (remaining > 0.05) {
        animation.cancel();
        animation = fly(Math.round((drawnLeft - left) / remaining), Math.round((drawnTop - top) / remaining));
        if (animation && elapsed !== null) animation.currentTime = elapsed;
      }
    }
    frames += 1;
    if (animation && frames < RETARGET_FRAMES && performance.now() - startedAt < RETARGET_WINDOW_MS) {
      frame = window.requestAnimationFrame(check);
    }
  };
  // After the commit (the list's scroll to the new row) and before paint.
  queueMicrotask(check);

  return {
    cancel: () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      animation?.cancel();
      animation = null;
    },
  };
}

/**
 * Runs the send flight on `ref` when `enabled` (a just-inserted user bubble).
 * Returns true while the flight replaces the regular insert animation.
 */
export function useSendFlight(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [flying, setFlying] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const flight = flySendBubble(node);
    if (!flight) return;
    setFlying(true);
    return () => flight.cancel();
  }, [enabled, ref]);
  return flying;
}
