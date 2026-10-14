// test-category: pure-logic
/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { settleGrid } from "./gridSettle";

const GLOBAL_KEYS = ["window", "document", "getComputedStyle"] as const;
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function installEnvironment(reduce = false) {
  const win = {
    matchMedia: (query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)" }),
    getComputedStyle: () => ({ opacity: "1", getPropertyValue: () => "" }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  Object.assign(globalThis, { window: win, document: { documentElement: {} }, getComputedStyle: win.getComputedStyle });
}

/** A grid whose height follows `state.height`; each animate() is recorded and finishes when `finish()` runs. */
function fakeGrid(state: { height: number }) {
  const animations: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean }> = [];
  const pending: Array<() => void> = [];
  const grid = {
    offsetWidth: 400,
    getBoundingClientRect: () => ({ width: 400, height: state.height }),
    closest: () => null,
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const record = { keyframes, options, cancelled: false };
      animations.push(record);
      const finished = new Promise<void>((resolve) => pending.push(resolve));
      return { finished, cancel: () => { record.cancelled = true; } } as unknown as Animation;
    },
  } as unknown as HTMLElement;
  return { grid, animations, finish: () => pending.splice(0).forEach((resolve) => resolve()) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a column change dips out, applies once, dips back and eases the height", async () => {
  installEnvironment();
  const state = { height: 100 };
  const { grid, animations, finish } = fakeGrid(state);
  const applied: string[] = [];
  settleGrid(grid, () => { applied.push("final"); state.height = 160; }, { reflow: true });
  expect(applied).toEqual([]);
  expect(animations.map((animation) => animation.keyframes)).toEqual([[{ opacity: 1 }, { opacity: 0.2 }]]);
  finish();
  await tick();
  expect(applied).toEqual(["final"]);
  expect(animations[0]!.cancelled).toBe(true);
  expect(animations.slice(1).map((animation) => animation.keyframes)).toEqual([
    [{ opacity: 0.2 }, { opacity: 1 }],
    [{ height: "100px", overflow: "clip" }, { height: "160px", overflow: "clip" }],
  ]);
});

test("without a column change only the height eases; calls while waiting join the same settle", async () => {
  installEnvironment();
  const state = { height: 100 };
  const { grid, animations } = fakeGrid(state);
  const applied: string[] = [];
  settleGrid(grid, () => { applied.push("rows"); state.height = 120; });
  settleGrid(grid, () => applied.push("joined"), { reflow: true });
  await tick();
  expect(applied).toEqual(["rows", "joined"]);
  expect(animations.map((animation) => animation.keyframes)).toEqual([
    [{ height: "100px", overflow: "clip" }, { height: "120px", overflow: "clip" }],
  ]);
});

test("reduced motion keeps a shallow opacity dip and applies the height at once", async () => {
  installEnvironment(true);
  const state = { height: 100 };
  const { grid, animations, finish } = fakeGrid(state);
  let applied = false;
  settleGrid(grid, () => { applied = true; state.height = 160; }, { reflow: true });
  expect(animations[0]!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0.6 }]);
  finish();
  await tick();
  expect(applied).toBe(true);
  expect(animations.slice(1).map((animation) => animation.keyframes)).toEqual([[{ opacity: 0.6 }, { opacity: 1 }]]);
});

test("the change still applies when the dip never finishes", async () => {
  installEnvironment();
  const { grid } = fakeGrid({ height: 100 });
  let applied = false;
  settleGrid(grid, () => { applied = true; }, { reflow: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(applied).toBe(true);
});
