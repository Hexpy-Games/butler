// test-category: pure-logic
/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createWallpaperCrossfade } from "./crossfade";

interface FakeAnimation { keyframes: Keyframe[]; options: KeyframeAnimationOptions; onfinish: (() => void) | null; cancelled: boolean; cancel: () => void }

const saved = { window: globalThis.window, document: globalThis.document };
let reduced = false;

beforeEach(() => {
  reduced = false;
  globalThis.window = {
    matchMedia: () => ({ matches: reduced, addEventListener: () => undefined, removeEventListener: () => undefined }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  } as unknown as typeof window;
  globalThis.document = { body: { dataset: {} }, documentElement: {} } as unknown as Document;
});

afterEach(() => {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
});

function animated<T extends object>(target: T) {
  const animations: FakeAnimation[] = [];
  return Object.assign(target, {
    animations,
    animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation: FakeAnimation = { keyframes, options, onfinish: null, cancelled: false, cancel: () => { animation.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  });
}

function layers() {
  const canvas = animated({ width: 300, height: 200, style: { visibility: "" } });
  const overlay = animated({ width: 0, height: 0, hidden: true, snapshots: 0, getContext: () => ({ drawImage: () => { overlay.snapshots += 1; } }) });
  const crossfade = createWallpaperCrossfade(canvas as unknown as HTMLCanvasElement, overlay as unknown as HTMLCanvasElement);
  return { canvas, overlay, crossfade };
}

test("a crossfade freezes the frame on the overlay and fades it out on --motion-slow", () => {
  const { overlay, crossfade } = layers();
  crossfade.start();
  expect(overlay.snapshots).toBe(1);
  expect(overlay.hidden).toBe(false);
  expect([overlay.width, overlay.height]).toEqual([300, 200]);
  expect(overlay.animations.map((animation) => animation.keyframes)).toEqual([[{ opacity: 0 }]]);
  expect(overlay.animations[0]!.options.duration).toBe(220);
  overlay.animations[0]!.onfinish?.();
  expect(overlay.hidden).toBe(true);
  expect(overlay.width).toBe(0);
});

test("none hides the canvas and frees its buffer; the next scene fades in from its first frame", () => {
  const { canvas, crossfade } = layers();
  crossfade.clear();
  expect([canvas.width, canvas.height, canvas.style.visibility]).toEqual([0, 0, "hidden"]);
  crossfade.show(true);
  expect(canvas.style.visibility).toBe("hidden");
  crossfade.drawn();
  expect(canvas.style.visibility).toBe("");
  expect(canvas.animations.map((animation) => animation.keyframes)).toEqual([[{ opacity: 0, offset: 0 }]]);
  // Later frames do not fade again; a scene that is not after none shows at once.
  crossfade.drawn();
  crossfade.clear();
  crossfade.show(false);
  expect(canvas.style.visibility).toBe("");
  crossfade.drawn();
  expect(canvas.animations).toHaveLength(1);
  crossfade.dispose();
  expect(canvas.animations[0]!.cancelled).toBe(true);
});

test("reduced motion switches instantly: no snapshot, no fade", () => {
  reduced = true;
  const { canvas, overlay, crossfade } = layers();
  crossfade.start();
  crossfade.clear();
  crossfade.show(true);
  crossfade.drawn();
  expect(canvas.style.visibility).toBe("");
  expect(overlay.snapshots).toBe(0);
  expect(overlay.hidden).toBe(true);
  expect(overlay.animations).toEqual([]);
  expect(canvas.animations).toEqual([]);
});

test("a new crossfade replaces a running one", () => {
  const { overlay, crossfade } = layers();
  crossfade.start();
  crossfade.start();
  expect(overlay.animations[0]!.cancelled).toBe(true);
  expect(overlay.snapshots).toBe(2);
  expect(overlay.hidden).toBe(false);
});
