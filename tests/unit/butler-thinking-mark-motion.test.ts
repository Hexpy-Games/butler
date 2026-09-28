import { expect, test } from "bun:test";
import {
  MorphSim,
  createRand,
  speedOf,
  spring,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/motion.ts";
import { MORPH_SPRING, MOTION_FULL_SPEED_AT } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/constants.ts";

const DT = 1 / 60;

function step(sim: MorphSim, seconds: number, working: boolean) {
  for (let t = 0; t < seconds; t += DT) sim.update(DT, working);
}

test("morph spring converges to its target without overshoot", () => {
  const state = { x: 0, v: 0 };
  let peak = 0;
  for (let t = 0; t < 5; t += DT) {
    spring(state, 1, MORPH_SPRING.k, MORPH_SPRING.zeta, DT);
    peak = Math.max(peak, state.x);
  }
  expect(peak).toBeLessThanOrEqual(1);
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

test("reduced motion parks the morph at rest so leaving it never replays an exit", () => {
  const sim = new MorphSim();
  step(sim, 2, true);
  expect(sim.M.x).toBeGreaterThan(0.9);
  sim.park();
  expect(sim.M.x).toBe(0);
  expect(sim.M.v).toBe(0);
  expect(sim.idle).toBe(true);
});

test("speedOf rises smoothly with the morph and is exactly full speed from MOTION_FULL_SPEED_AT", () => {
  expect(speedOf(0)).toBe(0);
  expect(speedOf(MOTION_FULL_SPEED_AT / 2)).toBeCloseTo(0.5, 6);
  expect(speedOf(MOTION_FULL_SPEED_AT)).toBe(1);
  expect(speedOf(0.6)).toBe(1);
  expect(speedOf(1)).toBe(1);
  let previous = -1;
  let maxJump = 0;
  for (let i = 0; i <= 400; i += 1) {
    const value = speedOf(i / 400);
    expect(value).toBeGreaterThanOrEqual(previous);
    if (previous >= 0) maxJump = Math.max(maxJump, value - previous);
    previous = value;
  }
  // continuous (and C1: smoothstep), no jolt at either end of the ramp
  expect(maxJump).toBeLessThan(0.02);
});

test("the thinking loop reaches its intended speed quickly and then runs at exactly that constant", () => {
  const sim = new MorphSim();
  let fullSpeedAt = -1;
  let previousT = 0;
  const velocities: number[] = [];
  for (let frame = 1; frame <= 60 * 6; frame += 1) {
    sim.update(DT, true);
    const velocity = (sim.T - previousT) / DT;
    previousT = sim.T;
    if (fullSpeedAt < 0 && velocity >= 0.999) fullSpeedAt = frame * DT;
    if (frame * DT >= 1) velocities.push(velocity);
  }
  // full speed about 0.45s in (the calm morph itself takes ~1.9s to 95%)
  expect(fullSpeedAt).toBeGreaterThan(0.2);
  expect(fullSpeedAt).toBeLessThan(0.6);
  // steady state: the phase advances at exactly 1 (design units of T per second), every frame
  for (const velocity of velocities) expect(velocity).toBeCloseTo(1, 9);
  // half speed well inside the first quarter second
  const early = new MorphSim();
  step(early, 0.25, true);
  expect(speedOf(early.M.x)).toBeGreaterThan(0.45);
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
