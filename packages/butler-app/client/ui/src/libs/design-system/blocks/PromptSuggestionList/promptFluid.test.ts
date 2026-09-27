/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
  FLUID_TIME_PERIOD_SECONDS,
  createFluidRenderer,
  fluidShaderTime,
  type FluidVariant,
} from "./promptFluid";
import {
  BLOOM_FRAGMENT_SHADER,
  SILK_FRAGMENT_SHADER,
} from "./promptFluidShaders";

const MEDIUMP_MAX = 2 ** 14;
const TAU = Math.PI * 2;
const VARIANTS: FluidVariant[] = ["bloom", "silk"];

function isWholeNumber(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

test("fluid shaders prefer highp and fall back to mediump", () => {
  for (const shader of [BLOOM_FRAGMENT_SHADER, SILK_FRAGMENT_SHADER]) {
    expect(shader).toContain(
      "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif",
    );
    // Time arrives in seconds; the shader no longer scales milliseconds.
    expect(shader).not.toContain("u*.001");
    expect(shader).toContain("float t=u;");
  }
});

test("every bloom time frequency repeats within the bloom period", () => {
  const frequencies = [...BLOOM_FRAGMENT_SHADER.matchAll(/t\*(\.\d+)/gu)]
    .map((match) => Number(match[1]));
  expect(frequencies).toHaveLength(20);
  for (const frequency of frequencies) {
    expect(isWholeNumber((FLUID_TIME_PERIOD_SECONDS.bloom * frequency) / TAU)).toBe(true);
  }
});

test("every silk phase frequency repeats within the silk period", () => {
  // phase = t*.64, used as phase, phase*.5, .02*phase*2.5, .1*phase*10 and phase*.18.
  for (const term of ["float phase=t*.64", "-phase)", "phase*.5", ".02*phase", ".1*phase", "phase*.18"]) {
    expect(SILK_FRAGMENT_SHADER).toContain(term);
  }
  for (const frequency of [0.64, 0.64 * 0.5, 0.64 * 0.02 * 2.5, 0.64 * 0.1 * 10, 0.64 * 0.18]) {
    expect(isWholeNumber((FLUID_TIME_PERIOD_SECONDS.silk * frequency) / TAU)).toBe(true);
  }
});

test("shader time wraps into a small, continuous range", () => {
  for (const variant of VARIANTS) {
    const period = FLUID_TIME_PERIOD_SECONDS[variant];
    expect(period).toBeLessThan(MEDIUMP_MAX);
    for (const ms of [0, 16.7, 59_999, 3_600_000, 86_400_000 * 7]) {
      const value = fluidShaderTime(ms, variant);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(period);
      expect(fluidShaderTime(ms + period * 1000, variant)).toBeCloseTo(value, 6);
    }
    expect(fluidShaderTime(1500, variant)).toBeCloseTo(1.5, 9);
  }
});

test("draw passes the wrapped time uniform in seconds", () => {
  for (const variant of VARIANTS) {
    const calls: Array<[unknown, number]> = [];
    const gl = new Proxy(
      {
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getUniformLocation: (_program: unknown, name: string) => name,
        getAttribLocation: () => 0,
        uniform1f: (location: unknown, value: number) => calls.push([location, value]),
      } as Record<string, unknown>,
      { get: (target, key) => target[key as string] ?? (() => ({})) },
    );
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => gl,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    } as unknown as HTMLCanvasElement;
    const previousWindow = globalThis.window;
    globalThis.window = { devicePixelRatio: 1, innerWidth: 100, innerHeight: 100 } as typeof window;
    try {
      const renderer = createFluidRenderer(canvas, undefined, "light", variant);
      const frameTime = 86_400_000 * 3 + 1234;
      renderer?.draw(frameTime);
      const time = calls.find(([location]) => location === "u")?.[1];
      expect(time).toBeCloseTo(fluidShaderTime(frameTime, variant), 6);
      expect(time!).toBeLessThan(FLUID_TIME_PERIOD_SECONDS[variant]);
    } finally {
      globalThis.window = previousWindow;
    }
  }
});
