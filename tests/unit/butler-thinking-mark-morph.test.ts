import { expect, test } from "bun:test";
import {
  CENTER,
  HS_R,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/constants.ts";
import { sdRibbon } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/ribbon-geometry.ts";
import {
  createFrameParams,
  dotRadius,
  latticeFor,
  setFrameParams,
  type HalftoneLayer,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/halftone-model.ts";
import {
  clipMargin,
  morphSd,
  OUTLINE_RAYS,
  traceOutline,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/morph-outline.ts";
import {
  MorphSim,
  speedOf,
} from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/motion.ts";
import { drawFrame } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/canvas-drawing.ts";
import type { MarkSurface } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/mark-surface.ts";
import { RISO_INKS } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/butlerMarkTheme.ts";

const DT = 1 / 60;
const SAMPLES = [0.25, 0.5, 0.75];
const T_FIXED = 1.4;

function layers(cls: 0 | 1 | 2 = 1) {
  const [key, blue, pink] = latticeFor(cls);
  if (!key || !blue || !pink) throw new Error("missing screens");
  return { key, blue, pink };
}

/** Distance from the centre to the morphing outline along a ray (the shape's scale on that axis). */
function extent(progress: number, angle: number) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let last = 0;
  for (let r = 0; r <= 420; r += 0.5) {
    const x = CENTER + dx * r;
    const y = CENTER + dy * r;
    if (morphSd(sdRibbon(x, y), r, progress, 1) > 0) return last;
    last = r;
  }
  return last;
}

/** Sum of dot radii on one screen at a given progress, with the motion clock held still. */
function inkTotal(layer: HalftoneLayer, ink: number, progress: number, interiorOnly = false) {
  const params = createFrameParams();
  setFrameParams(params, progress, T_FIXED, 2);
  let sum = 0;
  for (let i = 0; i < layer.N; i += 1) {
    // Interior: inside both the ribbon and the moon, so only the fill -> dots change counts.
    if (interiorOnly && (layer.SR[i]! > -layer.pitch || layer.DC[i]! > HS_R - layer.pitch)) continue;
    sum += dotRadius(layer, i, ink, params);
  }
  return sum;
}

function setParams(progress: number, T = T_FIXED) {
  const params = createFrameParams();
  setFrameParams(params, progress, T, 2);
  return params;
}

function strictlyBetween(value: number, a: number, b: number) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  expect(value).toBeGreaterThan(lo + (hi - lo) * 0.02);
  expect(value).toBeLessThan(hi - (hi - lo) * 0.02);
}

test("every channel moves together: no channel is pinned at an endpoint while another moves", () => {
  const { key, blue } = layers(2);
  const shapeLobe = [extent(0, 0), extent(1, 0)];
  const shapeWaist = [extent(0, -Math.PI / 2), extent(1, -Math.PI / 2)];
  const keyInk = [inkTotal(key, 0, 0, true), inkTotal(key, 0, 1, true)];
  const blueInk = [inkTotal(blue, 1, 0), inkTotal(blue, 1, 1)];
  const speed = [speedOf(0), speedOf(1)];
  // The endpoints differ, so "strictly between" is meaningful for every channel.
  expect(shapeLobe[0]).toBeGreaterThan(HS_R + 40);
  expect(shapeLobe[1]).toBeCloseTo(HS_R, -1);
  expect(shapeWaist[0]).toBeLessThan(80);
  expect(blueInk[0]).toBe(0);
  for (const p of SAMPLES) {
    strictlyBetween(extent(p, 0), shapeLobe[0]!, shapeLobe[1]!); // scale toward the centre along the lobes
    strictlyBetween(extent(p, -Math.PI / 2), shapeWaist[0]!, shapeWaist[1]!); // the waist rounds out
    strictlyBetween(inkTotal(key, 0, p, true), keyInk[0]!, keyInk[1]!); // solid fill resolving into dots
    strictlyBetween(inkTotal(blue, 1, p), blueInk[0]!, blueInk[1]!); // riso colour
    strictlyBetween(speedOf(p), speed[0]!, speed[1]!); // motion clock
  }
});

test("shape and colour channels are monotonic in progress", () => {
  const { blue } = layers(1);
  let lobe = Infinity;
  let waist = -Infinity;
  let color = -Infinity;
  for (let i = 0; i <= 40; i += 1) {
    const p = i / 40;
    const l = extent(p, 0);
    const w = extent(p, -Math.PI / 2);
    const c = inkTotal(blue, 1, p);
    expect(l).toBeLessThanOrEqual(lobe);
    expect(w).toBeGreaterThanOrEqual(waist);
    expect(c).toBeGreaterThanOrEqual(color - 1e-6);
    lobe = l;
    waist = w;
    color = c;
  }
});

test("each dot keeps its identity: radius varies continuously with progress (no pops)", () => {
  for (const cls of [0, 1, 2] as const) {
    const { key, blue, pink } = layers(cls);
    for (const [layer, ink] of [[key, 0], [blue, 1], [pink, 2]] as const) {
      const previous = new Float32Array(layer.N);
      for (let step = 0; step <= 1000; step += 1) {
        const params = setParams(step / 1000);
        for (let i = 0; i < layer.N; i += 1) {
          const r = dotRadius(layer, i, ink, params);
          if (step > 0) expect(Math.abs(r - previous[i]!)).toBeLessThan(layer.pitch * 0.1);
          previous[i] = r;
        }
      }
    }
  }
});

test("the outline clip follows the morphing shape: star-shaped, and every inside dot is kept", () => {
  const { key } = layers(2);
  const outline = new Float32Array(OUTLINE_RAYS);
  expect(clipMargin(0, key.pitch)).toBe(0);
  for (let step = 0; step <= 50; step += 1) {
    const p = step / 50;
    traceOutline(p, 1, outline);
    // Star-shaped: past the traced radius a ray never re-enters the shape.
    for (let a = 0; a < OUTLINE_RAYS; a += 1) {
      const angle = (a / OUTLINE_RAYS) * Math.PI * 2;
      for (let r = outline[a]! + 1; r <= 440; r += 4) {
        const x = CENTER + Math.cos(angle) * r;
        const y = CENTER + Math.sin(angle) * r;
        expect(morphSd(sdRibbon(x, y), r, p, 1)).toBeGreaterThan(0);
      }
    }
    // Cells inside the shape sit inside the traced polygon (within chord error).
    for (let i = 0; i < key.N; i += 1) {
      if (morphSd(key.SR[i]!, key.DC[i]!, p, 1) > 0) continue;
      const angle = Math.atan2(key.Y[i]! - CENTER, key.X[i]! - CENTER);
      const a = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * OUTLINE_RAYS) % OUTLINE_RAYS;
      const bound = Math.max(outline[a]!, outline[(a + 1) % OUTLINE_RAYS]!, outline[(a + OUTLINE_RAYS - 1) % OUTLINE_RAYS]!);
      expect(key.DC[i]!).toBeLessThanOrEqual(bound + 1);
    }
  }
  // At rest the traced outline is the logo's edge: lobe tip radius = RR + RHO.
  traceOutline(0, 1, outline);
  expect(outline[0]!).toBeCloseTo(329.43 + 34, 0);
});

test("morph progress is monotonic on entry and on settle, and stays in [0, 1]", () => {
  const sim = new MorphSim();
  let last = 0;
  for (let t = 0; t < 4; t += DT) {
    sim.update(DT, true);
    expect(sim.M.x).toBeGreaterThanOrEqual(last);
    expect(sim.M.x).toBeLessThanOrEqual(1);
    last = sim.M.x;
  }
  for (let t = 0; t < 8 && !sim.idle; t += DT) {
    sim.update(DT, false);
    expect(sim.M.x).toBeLessThanOrEqual(last);
    expect(sim.M.x).toBeGreaterThanOrEqual(0);
    last = sim.M.x;
  }
  expect(sim.idle).toBe(true);
  // An interrupted morph turns around once, without overshooting either end.
  const turn = new MorphSim();
  for (let t = 0; t < 0.6; t += DT) turn.update(DT, true);
  let previous = turn.M.x;
  let falling = false;
  for (let t = 0; t < 8 && !turn.idle; t += DT) {
    turn.update(DT, false);
    expect(turn.M.x).toBeGreaterThanOrEqual(0);
    expect(turn.M.x).toBeLessThan(1);
    if (turn.M.x < previous) falling = true;
    else if (falling) expect(turn.M.x).toBeLessThanOrEqual(previous);
    previous = turn.M.x;
  }
  expect(turn.idle).toBe(true);
});

test("the morph is calm: roughly two seconds to 95%, with visible change spread across it", () => {
  const sim = new MorphSim();
  let t95 = 0;
  let t50 = 0;
  for (let t = 0; t < 5; t += DT) {
    sim.update(DT, true);
    if (!t50 && sim.M.x >= 0.5) t50 = t;
    if (!t95 && sim.M.x >= 0.95) t95 = t;
  }
  expect(t50).toBeGreaterThan(0.5);
  expect(t95).toBeGreaterThan(1.6);
  expect(t95).toBeLessThan(2.4);
});

test("no discontinuity at the loop hand-off: as the morph lands, dot motion per frame eases into the steady loop", () => {
  const { key, blue, pink } = layers(1);
  const screens = [[key, 0], [blue, 1], [pink, 2]] as const;
  const sim = new MorphSim();
  const params = createFrameParams();
  const prev = screens.map(([layer]) => new Float32Array(layer.N));
  let handOffMax = 0;
  let loopMax = 0;
  let frame = 0;
  for (let t = 0; t < 8; t += DT, frame += 1) {
    sim.update(DT, true);
    setFrameParams(params, sim.M.x, sim.T, 1);
    let frameMax = 0;
    screens.forEach(([layer, ink], s) => {
      for (let i = 0; i < layer.N; i += 1) {
        const r = dotRadius(layer, i, ink, params);
        if (frame > 0) frameMax = Math.max(frameMax, Math.abs(r - prev[s]![i]!));
        prev[s]![i] = r;
      }
    });
    // The hand-off window: the last 2% of the morph, while the loop is already running.
    if (t < 4 && sim.M.x >= 0.98) handOffMax = Math.max(handOffMax, frameMax);
    else if (t >= 4) loopMax = Math.max(loopMax, frameMax);
  }
  expect(loopMax).toBeGreaterThan(0);
  expect(handOffMax).toBeGreaterThan(0);
  expect(handOffMax).toBeLessThan(loopMax * 3);
});

function recorder(log: string[], name: string) {
  const canvas = { width: 0, height: 0, name };
  const target: Record<string, unknown> = { canvas };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop as string];
      return (...args: unknown[]) => {
        log.push(`${name}.${String(prop)}(${args.map((a) => (typeof a === "object" && a && "name" in a ? `<${(a as { name: string }).name}>` : String(a))).join(",")})`);
      };
    },
    set(obj, prop, value) {
      obj[prop as string] = value;
      log.push(`${name}.${String(prop)}=${String(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function surface(log: string[]): MarkSurface {
  return {
    ctx: recorder(log, "main"),
    ink: "#0a0a0b",
    riso: RISO_INKS.light,
    px: 48,
    k: 48 / 1200,
    cls: 1,
    layers: latticeFor(1),
    params: createFrameParams(),
    outline: new Float32Array(OUTLINE_RAYS),
    lctx: recorder(log, "layer"),
    rctx: recorder(log, "rest"),
    mctx: recorder(log, "mask"),
    grain: null,
    rand: () => 0.5,
  };
}

test("thinking -> idle settles on exactly the idle logo frame", () => {
  const idleLog: string[] = [];
  drawFrame(surface(idleLog), new MorphSim(), false);

  const sim = new MorphSim();
  for (let t = 0; t < 3; t += DT) sim.update(DT, true);
  for (let t = 0; t < 8 && !sim.idle; t += DT) sim.update(DT, false);
  expect(sim.idle).toBe(true);
  const settledLog: string[] = [];
  drawFrame(surface(settledLog), sim, false);

  expect(idleLog.length).toBeGreaterThan(0);
  expect(settledLog).toEqual(idleLog);
});
