/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import {
  animateMotion,
  easeProgress,
  motionDistance,
  motionDuration,
  motionEasing,
  prefersReducedMotion,
  reducedMotionKeyframes,
} from "./motion";

const GLOBAL_KEYS = ["window", "document", "getComputedStyle"] as const;
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

function restoreGlobals() {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
}

function installEnvironment({ reduce, tokens }: { reduce: boolean; tokens: Record<string, string> }) {
  const style = { getPropertyValue: (name: string) => tokens[name] ?? "" };
  const win = {
    matchMedia: (query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)" }),
    getComputedStyle: () => style,
  };
  Object.assign(globalThis, {
    window: win,
    document: { documentElement: {} },
    getComputedStyle: win.getComputedStyle,
  });
}

function fakeElement() {
  const calls: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  const element = {
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ keyframes, options });
      return { finished: Promise.resolve() } as unknown as Animation;
    },
  } as unknown as HTMLElement;
  return { element, calls };
}

afterEach(restoreGlobals);

test("motion durations and easings come from the tokens", () => {
  installEnvironment({
    reduce: false,
    tokens: { "--motion-base": " 160ms", "--motion-slow": "0.22s", "--motion-ease-decelerate": " cubic-bezier(0, 0, 0, 1)" },
  });
  expect(motionDuration("base")).toBe(160);
  expect(motionDuration("slow")).toBe(220);
  expect(motionEasing("decelerate")).toBe("cubic-bezier(0, 0, 0, 1)");
});

test("motion distances come from the tokens and collapse under reduced motion", () => {
  installEnvironment({ reduce: false, tokens: { "--motion-distance-lg": "24px" } });
  expect(motionDistance("lg")).toBe(24);
  expect(motionDistance("sm")).toBe(4);
  installEnvironment({ reduce: true, tokens: { "--motion-distance-lg": "24px" } });
  expect(motionDistance("lg")).toBe(0);
});

test("motion falls back to the token scale when tokens are not loaded", () => {
  installEnvironment({ reduce: false, tokens: {} });
  expect(motionDuration("instant")).toBe(60);
  expect(motionDuration("exit-fast")).toBe(90);
  expect(motionEasing("accelerate")).toBe("cubic-bezier(0.3, 0, 1, 1)");
});

test("reduced motion keeps opacity and drops transforms", () => {
  expect(reducedMotionKeyframes([
    { opacity: 0, transform: "translateX(24px)" },
    { opacity: 1, transform: "none" },
  ])).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  expect(reducedMotionKeyframes([{ transform: "scale(0.97)" }, { transform: "none" }])).toBeNull();
});

test("animateMotion animates with token timing", () => {
  installEnvironment({ reduce: false, tokens: { "--motion-base": "160ms", "--motion-ease-decelerate": "cubic-bezier(0, 0, 0, 1)" } });
  const { element, calls } = fakeElement();
  expect(prefersReducedMotion()).toBe(false);
  animateMotion(element, [{ opacity: 0, transform: "translateX(24px)" }, { opacity: 1, transform: "none" }]);
  expect(calls).toHaveLength(1);
  expect(calls[0].options).toMatchObject({ duration: 160, easing: "cubic-bezier(0, 0, 0, 1)" });
  expect(calls[0].keyframes[0]).toMatchObject({ transform: "translateX(24px)" });
});

test("animateMotion fades only under reduced motion and skips transform-only motion", () => {
  installEnvironment({ reduce: true, tokens: {} });
  const { element, calls } = fakeElement();
  expect(prefersReducedMotion()).toBe(true);
  animateMotion(element, [{ opacity: 0, transform: "translateX(24px)" }, { opacity: 1, transform: "none" }], { duration: "fast" });
  expect(calls[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  expect(animateMotion(element, [{ transform: "scale(0.97)" }, { transform: "none" }])).toBeNull();
  expect(calls).toHaveLength(1);
});

test("animateMotion is a no-op without WAAPI", () => {
  installEnvironment({ reduce: false, tokens: {} });
  expect(animateMotion({} as HTMLElement, [{ opacity: 0 }, { opacity: 1 }])).toBeNull();
});

test("easeProgress samples the token cubic-bezier curves and clamps to 0..1", () => {
  installEnvironment({ reduce: false, tokens: { "--motion-ease-decelerate": "cubic-bezier(0, 0, 0, 1)" } });
  expect(easeProgress("decelerate", 0)).toBe(0);
  expect(easeProgress("decelerate", 1)).toBe(1);
  expect(easeProgress("decelerate", -1)).toBe(0);
  expect(easeProgress("decelerate", 2)).toBe(1);
  // Decelerate front-loads the travel.
  expect(easeProgress("decelerate", 0.25)).toBeGreaterThan(0.6);
  expect(easeProgress("decelerate", 0.5)).toBeGreaterThan(easeProgress("decelerate", 0.25));
  expect(easeProgress("linear", 0.5)).toBeCloseTo(0.5, 5);
  restoreGlobals();
});
