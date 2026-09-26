import { expect, test } from "bun:test";
import {
  CENTER,
  DISC_R,
  HALFTONE_PRESETS,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/constants.ts";
import {
  sdRibbon,
  sizeClass,
  traceRibbon,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/ribbon-geometry.ts";
import {
  buildHalftone,
  createFrameParams,
  dotRadius,
  latticeFor,
  renderMode,
  setFrameParams,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/halftone-model.ts";
import { MorphSim } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/motion.ts";

const DOT_BUDGET_PER_LAYER = [80, 200, 900];

test("sdRibbon is negative at the crossing and positive outside the ring", () => {
  expect(sdRibbon(CENTER, CENTER)).toBeLessThan(0);
  expect(sdRibbon(CENTER - 250, CENTER)).toBeLessThan(0);
  expect(sdRibbon(CENTER + 500, CENTER)).toBeGreaterThan(0);
  expect(sdRibbon(CENTER, CENTER - 300)).toBeGreaterThan(0);
});

test("sizeClass maps 14, 24 and 64px to the three presets", () => {
  expect(sizeClass(14)).toBe(0);
  expect(sizeClass(18)).toBe(0);
  expect(sizeClass(24)).toBe(1);
  expect(sizeClass(64)).toBe(2);
  expect(sizeClass(230)).toBe(2);
});

test("traceRibbon emits two closed sectors", () => {
  const ops: string[] = [];
  const sink = {
    beginPath: () => ops.push("begin"),
    moveTo: () => ops.push("move"),
    lineTo: () => ops.push("line"),
    arc: () => ops.push("arc"),
    closePath: () => ops.push("close"),
  };
  traceRibbon(sink);
  expect(ops.filter((op) => op === "arc")).toHaveLength(2);
  expect(ops.filter((op) => op === "close")).toHaveLength(2);
});

test("every size class prints all three inks within the dot budget", () => {
  for (const cls of [0, 1, 2] as const) {
    const layers = buildHalftone(cls);
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      expect(layer.N).toBeGreaterThan(20);
      expect(layer.N).toBeLessThanOrEqual(DOT_BUDGET_PER_LAYER[cls] ?? 0);
      for (let i = 0; i < layer.N; i += 1) {
        expect(layer.DC[i]).toBeLessThanOrEqual(DISC_R + 0.001);
      }
    }
    expect(HALFTONE_PRESETS[cls]?.mis).toBeGreaterThan(0);
  }
});

test("halftone lattices are deterministic and cached per size class", () => {
  const a = buildHalftone(1);
  const b = buildHalftone(1);
  expect(Array.from(a[0]?.X ?? [])).toEqual(Array.from(b[0]?.X ?? []));
  expect(Array.from(a[2]?.NRZ ?? [])).toEqual(Array.from(b[2]?.NRZ ?? []));
  expect(latticeFor(1)).toBe(latticeFor(1));
});

test("the render path draws the rest logo at M = 0", () => {
  const sim = new MorphSim({ reducedFade: 0.22, breathePeriod: 5, ease: (t: number) => t });
  expect(renderMode(sim, false)).toBe("rest");
  expect(renderMode(sim, true)).toBe("reduced");
  sim.update(1 / 60, true);
  expect(renderMode(sim, false)).toBe("halftone");
  for (let t = 0; t < 2; t += 1 / 60) sim.update(1 / 60, true);
  for (let t = 0; t < 6; t += 1 / 60) sim.update(1 / 60, false);
  expect(renderMode(sim, false)).toBe("rest");
});

test("riso inks stay off until the morph starts and appear once working", () => {
  const params = createFrameParams();
  const layers = latticeFor(0);
  const blue = layers[1];
  if (!blue) throw new Error("missing blue screen");

  setFrameParams(params, 0, 0, 0);
  let inkAtRest = 0;
  for (let i = 0; i < blue.N; i += 1) inkAtRest += dotRadius(blue, i, 1, params);
  expect(inkAtRest).toBe(0);

  setFrameParams(params, 1, 1.4, 0);
  let inkWorking = 0;
  for (let i = 0; i < blue.N; i += 1) inkWorking += dotRadius(blue, i, 1, params);
  expect(inkWorking).toBeGreaterThan(0);
});

test("key ink dots are fused across the bowtie at the very start of the morph", () => {
  const params = createFrameParams();
  const key = latticeFor(2)[0];
  if (!key) throw new Error("missing key screen");
  setFrameParams(params, 0.001, 0, 2);
  let insideCount = 0;
  for (let i = 0; i < key.N; i += 1) {
    if ((key.SR[i] ?? 0) < -key.pitch) {
      insideCount += 1;
      expect(dotRadius(key, i, 0, params)).toBeGreaterThan(key.pitch * 0.7);
    }
  }
  expect(insideCount).toBeGreaterThan(50);
});
