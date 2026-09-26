import { expect, test } from "bun:test";
import {
  MorphSim,
  createRand,
  mLocal,
  speedOf,
  spring,
} from "../../packages/butler-app/client/ui/src/components/common/thinking-mark/motion.ts";
import { MORPH_SPRING } from "../../packages/butler-app/client/ui/src/components/common/thinking-mark/constants.ts";

const DT = 1 / 60;

function step(sim: MorphSim, seconds: number, working: boolean) {
  for (let t = 0; t < seconds; t += DT) sim.update(DT, working);
}

test("morph spring converges to its target with under 2% overshoot", () => {
  const state = { x: 0, v: 0 };
  let peak = 0;
  for (let t = 0; t < 5; t += DT) {
    spring(state, 1, MORPH_SPRING.k, MORPH_SPRING.zeta, DT);
    peak = Math.max(peak, state.x);
  }
  expect(peak).toBeLessThan(1.02);
  expect(Math.abs(state.x - 1)).toBeLessThan(0.001);
});

test("MorphSim returns exactly to rest after exit and the motion clock stops", () => {
  const sim = new MorphSim();
  expect(sim.idle).toBe(true);
  step(sim, 3, true);
  expect(sim.idle).toBe(false);
  expect(sim.M.x).toBeGreaterThan(0.95);
  expect(sim.T).toBeGreaterThan(1);

  let settledAfter = -1;
  for (let t = 0; t < 6; t += DT) {
    sim.update(DT, false);
    if (sim.idle) {
      settledAfter = t;
      break;
    }
  }
  expect(settledAfter).toBeGreaterThan(0);
  expect(sim.M.x).toBe(0);
  expect(sim.M.v).toBe(0);

  const clock = sim.th;
  step(sim, 1, false);
  expect(sim.th).toBe(clock);
  expect(sim.idle).toBe(true);
});

test("MorphSim motion runs concurrently with the morph from the first frames", () => {
  const sim = new MorphSim();
  step(sim, 0.2, true);
  expect(sim.M.x).toBeGreaterThan(0);
  expect(sim.M.x).toBeLessThan(0.8);
  expect(sim.T).toBeGreaterThan(0);
});

test("MorphSim restarts the motion phase on each entry", () => {
  const sim = new MorphSim();
  step(sim, 2, true);
  step(sim, 6, false);
  expect(sim.idle).toBe(true);
  sim.update(DT, true);
  expect(sim.T).toBeLessThan(0.01);
});

test("reduced-motion breathe level settles to zero when idle", () => {
  const sim = new MorphSim();
  for (let t = 0; t < 2; t += DT) sim.updateReduced(DT, true);
  expect(sim.rm).toBeGreaterThan(0.9);
  expect(sim.reducedSettled(true)).toBe(false);
  for (let t = 0; t < 4; t += DT) sim.updateReduced(DT, false);
  expect(sim.rm).toBe(0);
  expect(sim.reducedSettled(false)).toBe(true);
});

test("reduced motion parks the morph at rest so leaving it never replays an exit", () => {
  const sim = new MorphSim();
  step(sim, 2, true);
  expect(sim.M.x).toBeGreaterThan(0.9);
  sim.updateReduced(DT, true);
  expect(sim.M.x).toBe(0);
  expect(sim.idle).toBe(true);
});

test("speedOf is zero at rest, one when formed, and monotonic", () => {
  expect(speedOf(0)).toBe(0);
  expect(speedOf(1)).toBe(1);
  let previous = -1;
  for (let i = 0; i <= 200; i += 1) {
    const value = speedOf(i / 200);
    expect(value).toBeGreaterThanOrEqual(previous);
    previous = value;
  }
});

test("mLocal granulates from the crossing outward", () => {
  expect(mLocal(0, 0)).toBe(0);
  expect(mLocal(1, 0)).toBe(1);
  expect(mLocal(1, 1)).toBe(1);
  expect(mLocal(0.3, 0)).toBeGreaterThan(mLocal(0.3, 0.8));
});

test("seeded rand is deterministic and in [0, 1)", () => {
  const a = createRand(7);
  const b = createRand(7);
  for (let i = 0; i < 50; i += 1) {
    const value = a();
    expect(value).toBe(b());
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
});
