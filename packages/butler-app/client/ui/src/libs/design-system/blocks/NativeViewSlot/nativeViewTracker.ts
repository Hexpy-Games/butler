import {
  GEOMETRY_TRANSITIONS, hasGeometryAnimation, rectsOverlap, sameNativeViewBounds, toNativeViewBounds,
  type NativeViewBounds, type NativeViewViewport,
} from "./nativeViewGeometry";
import { NATIVE_VIEW_OCCLUDERS } from "./nativeViewOccluders";
import { observeMove } from "./observeMove";

export { NATIVE_VIEW_OCCLUDERS };

export interface NativeViewTrackerSettings {
  hidden: boolean;
  covered: boolean;
  viewport?: NativeViewViewport;
  /** Extra occluder selector, joined to NATIVE_VIEW_OCCLUDERS. */
  occluders?: string;
}

export interface NativeViewTrackerOptions extends NativeViewTrackerSettings {
  /** The slot: observed for size and excluded from occluder checks. */
  root: HTMLElement;
  /** The rect the native view takes (the aspect frame in fixed-viewport mode). */
  target: HTMLElement;
  onBounds: (bounds: NativeViewBounds) => void;
  onOcclusion: (occluded: boolean) => void;
}

/** Running geometry motion on an ancestor (the slot moves) or on an element crossing the slot. */
function panelAnimating(root: HTMLElement, rect: DOMRect, movers: Set<Element>): boolean {
  for (let node = root.parentElement; node; node = node.parentElement) if (hasGeometryAnimation(node)) return true;
  for (const mover of movers) {
    if (!mover.isConnected) movers.delete(mover);
    else if (hasGeometryAnimation(mover) && rectsOverlap(mover.getBoundingClientRect(), rect)) return true;
  }
  return false;
}

function overlayCovers(root: HTMLElement, rect: DOMRect, selector: string): boolean {
  for (const overlay of root.ownerDocument.querySelectorAll(selector)) {
    if (!root.contains(overlay) && rectsOverlap(overlay.getBoundingClientRect(), rect)) return true;
  }
  return false;
}

function observeNativeChanges(root: HTMLElement, target: HTMLElement, selector: () => string,
  schedule: () => void, flush: () => void, onMotionStart: (event: Event) => void) {
  const doc = root.ownerDocument;
  const onMutation = (records: MutationRecord[]) => {
    const css = selector();
    const touches = (node: Node) => node instanceof Element && (node.matches(css) || node.querySelector(css) !== null);
    const relevant = records.some((record) => record.type === "attributes"
      ? record.attributeName === "data-left-peek" || (record.target as Element).closest?.(css) !== null
      : [...record.addedNodes, ...record.removedNodes].some(touches));
    if (relevant) schedule();
  };

  // A resize is measured in the same frame (ResizeObserver runs after layout, before paint), so a
  // layout change that starts a panel motion is covered before that frame paints.
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(flush);
  resize?.observe(root);
  resize?.observe(target);
  const move = observeMove(target, schedule);
  const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(onMutation);
  mutations?.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "hidden", "open", "data-left-peek"] });
  const listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions]> = [
    [doc.defaultView ?? window, "resize", schedule, { passive: true }],
    [doc, "scroll", schedule, { capture: true, passive: true }],
    ...["transitionrun", "animationstart"].map((type): [EventTarget, string, EventListener, AddEventListenerOptions] => [doc, type, onMotionStart, { capture: true }]),
    ...["transitionend", "transitioncancel", "animationend", "animationcancel"].map((type): [EventTarget, string, EventListener, AddEventListenerOptions] => [doc, type, schedule, { capture: true }]),
  ];
  for (const [eventTarget, type, listener, listenerOptions] of listeners) eventTarget.addEventListener(type, listener, listenerOptions);
  return {
    refresh: () => move.refresh(),
    destroy() {
      resize?.disconnect(); move.disconnect(); mutations?.disconnect();
      for (const [eventTarget, type, listener, listenerOptions] of listeners) eventTarget.removeEventListener(type, listener, listenerOptions);
    },
  };
}

/**
 * Change-driven bounds and occlusion tracking for a native view slot. Work is batched into one
 * animation frame; frames keep coming only while something moves, and stop once the rect settles.
 */
/** A rect change this soon after panel motion is still part of it (a track committed when a slide ends). */
const MOTION_SETTLE_MS = 120;

export function createNativeViewTracker(options: NativeViewTrackerOptions) {
  let settings: NativeViewTrackerSettings = options;
  let frame = 0;
  let last: NativeViewBounds | null = null;
  let lastMotion = Number.NEGATIVE_INFINITY;
  // Every new presenter reports its initial state, including clear coverage.
  let occluded: boolean | undefined;
  const movers = new Set<Element>();
  const { root, target } = options;
  const selector = () => [NATIVE_VIEW_OCCLUDERS, settings.occluders].filter(Boolean).join(", ");
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  /** Measures now (layout is clean in a ResizeObserver callback) instead of on the next frame. */
  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    tick();
  };

  function tick() {
    frame = 0;
    const rect = target.getBoundingClientRect();
    const shown = !settings.hidden && target.isConnected && (target.checkVisibility?.({ visibilityProperty: true }) ?? true);
    const bounds = toNativeViewBounds(rect, shown, settings.viewport);
    const changed = !last || !sameNativeViewBounds(last, bounds);
    if (changed) {
      last = bounds;
      options.onBounds(bounds);
    }
    const animating = bounds.visible && panelAnimating(root, rect, movers);
    const now = typeof performance === "undefined" ? Date.now() : performance.now();
    if (animating) lastMotion = now;
    // While a panel moves the slot, and for a rect change that lands as the motion ends, the native
    // view is covered (the still stands in) so it never shows at stale bounds.
    const settling = changed && now - lastMotion < MOTION_SETTLE_MS;
    const covered = bounds.visible && (settings.covered || animating || settling || overlayCovers(root, rect, selector()));
    if (covered !== occluded) {
      occluded = covered;
      options.onOcclusion(covered);
    }
    // One more frame after a change confirms the settled rect; motion keeps sampling.
    if (animating || changed) schedule();
  }

  const onMotionStart = (event: Event) => {
    const element = event.target as Element | null;
    if (!element || root.contains(element)) return;
    if ("propertyName" in event && !GEOMETRY_TRANSITIONS.has(String(event.propertyName))) return;
    movers.add(element);
    schedule();
  };
  const observers = observeNativeChanges(root, target, selector, schedule, flush, onMotionStart);
  schedule();

  return {
    /** New props: re-measure on the next frame. */
    update(next: NativeViewTrackerSettings) {
      settings = next;
      observers.refresh();
      schedule();
    },
    /** Stops all observers; a visible view is reported hidden so the App can detach it. */
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      observers.destroy();
      if (last?.visible) options.onBounds({ ...last, visible: false });
      if (occluded) options.onOcclusion(false);
    },
  };
}

export type NativeViewTracker = ReturnType<typeof createNativeViewTracker>;
