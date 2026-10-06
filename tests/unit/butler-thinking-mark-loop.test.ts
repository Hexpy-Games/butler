// test-category: pure-logic
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  pendingMarkFrames,
  startMarkLoop,
  type MarkLoop,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/markLoop.ts";
import { heldMorphKeys, holdMorph } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/morphContinuity.ts";
import { MorphSim } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/motion.ts";

/*
 * The mark's frame loop against a minimal browser: a fake requestAnimationFrame
 * queue, observers we can drive, and a no-op 2D context that counts what the
 * engine asks it to draw. The context does no raster work, so timings here are
 * the engine's own per-frame cost (lattice, tone, outline trace, path building).
 */

type Stub = Record<string, unknown>;
const FRAME_MS = 1000 / 60;
let rafQueue = new Map<number, FrameRequestCallback>();
let rafRequests = 0;
let nextRaf = 1;
let now = 0;
let intersection: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
let boundingReads = 0;
const saved: Record<string, unknown> = {};

function context(canvas: Stub, counts: { draws: number; arcs: number }) {
  const noop = () => undefined;
  return {
    canvas,
    setTransform: noop, clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    fill: noop, stroke: noop,
    arc: () => { counts.arcs += 1; },
    drawImage: () => { counts.draws += 1; },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
  } as unknown as CanvasRenderingContext2D;
}

function canvas(side: number, counts = { draws: 0, arcs: 0 }) {
  const element: Stub = { width: 0, height: 0 };
  element.getContext = () => context(element, counts);
  element.getBoundingClientRect = () => { boundingReads += 1; return { width: side, height: side }; };
  element.closest = () => null;
  return { element: element as unknown as HTMLCanvasElement, counts };
}

function frame() {
  now += FRAME_MS;
  const due = rafQueue;
  rafQueue = new Map();
  for (const callback of due.values()) callback(now);
}

beforeEach(() => {
  for (const key of ["window", "document", "ResizeObserver", "IntersectionObserver", "MutationObserver"]) saved[key] = (globalThis as Stub)[key];
  rafQueue = new Map();
  rafRequests = 0;
  nextRaf = 1;
  now = 1000;
  intersection = [];
  boundingReads = 0;
  Object.assign(globalThis, {
    window: {
      devicePixelRatio: 3,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        rafRequests += 1;
        const id = nextRaf++;
        rafQueue.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => { rafQueue.delete(id); },
      matchMedia: () => ({ matches: false }),
    },
    document: {
      visibilityState: "visible",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      createElement: () => canvas(1).element,
    },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { intersection.push(callback); }
      observe() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (globalThis as Stub)[key];
    else (globalThis as Stub)[key] = value;
  }
});

function mount(side: number, working: { value: boolean }, sim: { current: MorphSim | null } = { current: null }) {
  const target = canvas(side);
  const loop = startMarkLoop(target.element, {
    theme: "light",
    isWorking: () => working.value,
    isReduced: () => false,
    sim,
  }) as MarkLoop;
  return { ...target, loop, sim };
}

test("any number of working marks share one requestAnimationFrame per frame", () => {
  const working = { value: true };
  const marks = [14, 14, 16, 20, 24, 24, 32, 96].map((side) => mount(side, working));
  expect(pendingMarkFrames()).toBe(1);
  expect(rafQueue.size).toBe(1);
  rafRequests = 0;
  for (let i = 0; i < 60; i += 1) {
    const before = marks.map((mark) => mark.counts.draws);
    frame();
    expect(rafQueue.size).toBe(1);
    // every mark drew exactly once this frame (one composite onto its canvas, plus the ring stroke)
    marks.forEach((mark, index) => expect(mark.counts.draws - before[index]!).toBeGreaterThan(0));
  }
  expect(rafRequests).toBe(60);
  // restarting an already-running mark never adds a loop
  for (const mark of marks) mark.loop.start();
  expect(rafQueue.size).toBe(1);
  for (const mark of marks) mark.loop.dispose();
  expect(pendingMarkFrames()).toBe(0);
  expect(rafQueue.size).toBe(0);
});

test("the shared loop stops once every mark has settled back to the logo", () => {
  const working = { value: true };
  const marks = [14, 24].map((side) => mount(side, working));
  for (let i = 0; i < 120; i += 1) frame();
  working.value = false;
  for (const mark of marks) mark.loop.start();
  let frames = 0;
  while (pendingMarkFrames() > 0 && frames < 60 * 8) {
    frame();
    frames += 1;
  }
  expect(pendingMarkFrames()).toBe(0);
  expect(marks.every((mark) => mark.sim.current!.idle)).toBe(true);
  const draws = marks.map((mark) => mark.counts.draws);
  for (let i = 0; i < 30; i += 1) frame();
  expect(marks.map((mark) => mark.counts.draws)).toEqual(draws);
  for (const mark of marks) mark.loop.dispose();
});

test("an offscreen mark stops drawing while the others keep the loop", () => {
  const working = { value: true };
  const visible = mount(24, working);
  const hidden = mount(24, working);
  intersection[1]!([{ isIntersecting: false }]);
  const before = [visible.counts.draws, hidden.counts.draws];
  for (let i = 0; i < 30; i += 1) frame();
  expect(visible.counts.draws).toBeGreaterThan(before[0]!);
  expect(hidden.counts.draws).toBe(before[1]!);
  expect(rafQueue.size).toBe(1);
  visible.loop.dispose();
  hidden.loop.dispose();
});

test("canvas is sized once at DPR <= 2 and layout is never read per frame", () => {
  const working = { value: true };
  const mark = mount(24, working);
  expect(mark.element.width).toBe(48);
  const reads = boundingReads;
  for (let i = 0; i < 60; i += 1) frame();
  expect(boundingReads).toBe(reads);
  expect(mark.element.width).toBe(48);
  mark.loop.dispose();
});

test("marks sharing a morphKey advance one simulation once per frame and survive a remount", async () => {
  const working = { value: true };
  const first = { current: null as MorphSim | null };
  const release = holdMorph("turn-1", first);
  const a = mount(24, working, first);
  for (let i = 0; i < 30; i += 1) frame();
  const T30 = first.current!.T;
  // a second mark on the same work: the shared clock must not run twice as fast
  const second = { current: null as MorphSim | null };
  const releaseSecond = holdMorph("turn-1", second);
  expect(second.current).toBe(first.current);
  const b = mount(24, working, second);
  for (let i = 0; i < 30; i += 1) frame();
  expect(first.current!.T - T30).toBeCloseTo(30 * (1 / 60) * 1, 1);
  // remount: release the old mark and hold again in the same commit -> same simulation, mid-morph
  a.loop.dispose();
  release();
  b.loop.dispose();
  releaseSecond();
  const remounted = { current: null as MorphSim | null };
  const releaseRemount = holdMorph("turn-1", remounted);
  expect(remounted.current).toBe(first.current);
  expect(remounted.current!.M.x).toBeGreaterThan(0.5);
  releaseRemount();
  await Promise.resolve();
  expect(heldMorphKeys()).not.toContain("turn-1");
});

test("per-frame engine cost stays within budget: <= 0.3 ms per small mark, <= 1 ms for a 96px mark", () => {
  const working = { value: true };
  const small = [14, 16, 20, 24, 32].flatMap((side) => [mount(side, working), mount(side, working)]);
  const large = mount(96, working);
  // warm up (JIT) through the whole morph, then time morph + steady frames of every mark
  for (let i = 0; i < 60; i += 1) frame();
  const FRAMES = 240;
  // Wall-clock timing on a shared machine only ever reads high, never low: take
  // the best of several trials (each restarting the morph) so a busy CPU cannot
  // fail the budget, while a real regression still slows every trial.
  const bestPerFrame = (marks: typeof small) => {
    let best = Infinity;
    for (let trial = 0; trial < 5; trial += 1) {
      for (const mark of marks) {
        mark.sim.current!.park();
        mark.loop.start();
      }
      const start = performance.now();
      for (let i = 0; i < FRAMES; i += 1) frame();
      best = Math.min(best, (performance.now() - start) / FRAMES);
    }
    return best;
  };
  const perFrameAll = bestPerFrame([...small, large]);
  large.loop.dispose();
  const perSmallMark = bestPerFrame(small) / small.length;
  expect(perSmallMark).toBeLessThan(0.3);
  expect(perFrameAll - perSmallMark * small.length).toBeLessThan(1);
  for (const mark of small) mark.loop.dispose();
}, 15_000);
