import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";

/** Browser conditions the scheduler reacts to. */
export interface WallpaperSignals {
  documentHidden: boolean;
  intersecting: boolean;
  reducedMotion: boolean;
  onBattery: boolean;
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
  };
}

/**
 * Subscribes to document visibility, on-screen state, reduced motion,
 * battery (where `navigator.getBattery` exists) and canvas resizes. Window
 * focus is not watched: a visible window behind another app keeps animating.
 */
export function watchWallpaperSignals(
  canvas: HTMLCanvasElement,
  onChange: (patch: Partial<WallpaperSignals>) => void,
  onResize: () => void,
): () => void {
  const cleanups: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, handler: () => void) => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  listen(document, "visibilitychange", () => onChange({ documentHidden: document.visibilityState === "hidden" }));
  cleanups.push(subscribeReducedMotion((reducedMotion) => onChange({ reducedMotion })));

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
