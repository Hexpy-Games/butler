import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import { watchWallpaperHost, wallpaperHostConstrained, type WallpaperWindowBlur } from "./hostSignals";

/** Browser conditions the scheduler reacts to. */
export interface WallpaperSignals {
  documentHidden: boolean;
  intersecting: boolean;
  reducedMotion: boolean;
  onBattery: boolean;
  /** Window blur level (drift modules only: half speed after 2 min, paused after 10). */
  windowBlur: WallpaperWindowBlur;
  /** Low power or thermal pressure (`setWallpaperHostConstrained`): drift modules hold a static print. */
  constrained: boolean;
}

interface BatteryLike extends EventTarget {
  charging: boolean;
}

type BatteryNavigator = Navigator & { getBattery?: () => Promise<BatteryLike> };

export function readWallpaperSignals(): WallpaperSignals {
  return {
    documentHidden: document.visibilityState === "hidden",
    // Assume visible until the IntersectionObserver reports.
    intersecting: true,
    reducedMotion: prefersReducedMotion(),
    onBattery: false,
    windowBlur: 0,
    constrained: wallpaperHostConstrained(),
  };
}

/**
 * Subscribes to document visibility, on-screen state, reduced motion,
 * battery (where `navigator.getBattery` exists), canvas resizes, window blur
 * and the host-constrained flag. Only drift modules read the blur: a visible
 * window behind another app keeps animating. `onReturn`: shown and focused
 * again after 5 min away.
 */
export function watchWallpaperSignals(
  canvas: HTMLCanvasElement,
  onChange: (patch: Partial<WallpaperSignals>) => void,
  onResize: () => void,
  onReturn: () => void = () => undefined,
): () => void {
  const cleanups: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, handler: () => void) => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  listen(document, "visibilitychange", () => onChange({ documentHidden: document.visibilityState === "hidden" }));
  cleanups.push(subscribeReducedMotion((reducedMotion) => onChange({ reducedMotion })));
  cleanups.push(watchWallpaperHost({
    onBlur: (windowBlur) => onChange({ windowBlur }),
    onConstrained: (constrained) => onChange({ constrained }),
    onReturn,
  }));

  if (typeof IntersectionObserver === "function") {
    const intersection = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) onChange({ intersecting: entry.isIntersecting });
    });
    intersection.observe(canvas);
    cleanups.push(() => intersection.disconnect());
  }
  if (typeof ResizeObserver === "function") {
    const resize = new ResizeObserver(() => onResize());
    resize.observe(canvas);
    cleanups.push(() => resize.disconnect());
  }

  let disposed = false;
  const getBattery = (navigator as BatteryNavigator).getBattery;
  getBattery?.call(navigator).then((battery) => {
    if (disposed) return;
    const update = () => onChange({ onBattery: !battery.charging });
    update();
    listen(battery, "chargingchange", update);
  }).catch(() => undefined);

  return () => {
    disposed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}

/** `webglcontextlost` (default prevented, so the context can come back) and `webglcontextrestored`. */
export function watchWallpaperContext(canvas: HTMLCanvasElement, onLost: () => void, onRestored: () => void): () => void {
  const lost = (event: Event) => {
    event.preventDefault();
    onLost();
  };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return () => {
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}
