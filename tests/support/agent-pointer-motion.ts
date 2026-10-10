import { join } from "node:path";
import type { Browser, Locator } from "playwright";

// AgentPointer motion on the DS site (blocks/AgentPointer, the "Motion lab" stories):
// - rings never interpolate geometry: every ring keeps the rect of its first frame until it is gone, a new
//   target's ring fades in in place, the old one fades out where it was, and ring animations touch only opacity;
// - a whole-page target draws no ring;
// - the glide is curved (samples leave the straight chord) and ends exactly on the target;
// - a new target mid-glide continues from the drawn position (no jump > 2px in that frame);
// - the click ripple starts only when the pointer arrives (within 50ms of the landing frame), anchored on the
//   arrival point, and a target abandoned mid-glide never gets one;
// - reduced motion (forced by the prop, and the OS setting): the pointer jumps, no animation, no ring fade,
//   and the ripple is there at once.

const LAB = "Motion lab: curved glide, retarget mid-glide, whole page";
const REDUCED_LAB = "Motion lab, reduced motion: jumps, rings without fades";
const FRAME_STORIES = [
  "Frames: a ring appears in place (fade only)",
  "Frames: target change (old ring fades where it was, new ring fades in)",
  "Frames: whole-page target (no ring; the page edge shows it)",
  "Frames: curved glide (400ms)",
  "Frames: retarget at 160ms (continues from the drawn position)",
  "Frames: batch steps follow the path through the stops",
  "Frames: reduced motion (jumps, no fades)",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Trace {
  start: { x: number; y: number };
  target: { x: number; y: number };
  /** Per frame: the drawn pointer, and the click ripple's anchor (null when there is none). */
  samples: { x: number; y: number; t: number; ripple: { x: number; y: number } | null }[];
  /** The ripple in the frame of the click, after the update committed. */
  rippleAtPress: { x: number; y: number } | null;
  /** The target that was replaced mid-glide. */
  abandoned?: { x: number; y: number };
  /** Per ring element: every rect it had while it existed, and whether it ever animated more than opacity. */
  rings: { rects: number[][]; leavingSeen: boolean; nonOpacity: string[] }[];
  maxRings: number;
  jump?: number;
  interruptedAt?: number;
  settled: { x: number; y: number; running: number; rings: number };
}

/** Clicks a lab button and follows the pointer and rings frame by frame (in the page). */
async function play(lab: Locator, button: "next" | "page", interruptAfterMs?: number): Promise<Trace> {
  return lab.evaluate(async (root, [which, interruptAt]) => {
    const stage = root.querySelector<HTMLElement>("[data-pointer-lab]")!;
    // React commits a click's update in a microtask: wait for it without letting a frame pass.
    const press = async (name: string) => {
      const before = stage.innerHTML;
      root.querySelector<HTMLElement>(`[data-pointer-lab-${name}]`)!.click();
      for (let tick = 0; tick < 50 && stage.innerHTML === before; tick += 1) await Promise.resolve();
    };
    const pointer = () => stage.querySelector<HTMLElement>("[data-part=pointer]")!;
    const parse = (value: string) => { const [x = 0, y = 0] = value.split(" ").map((part) => Number.parseFloat(part) || 0); return { x, y }; };
    const drawn = () => parse(getComputedStyle(pointer()).translate);
    const ripple = () => { const node = stage.querySelector<HTMLElement>("[data-part=ripple]"); return node ? parse(node.style.translate) : null; };
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const rings = new Map<Element, { rects: number[][]; leavingSeen: boolean; nonOpacity: string[] }>();
    let maxRings = 0;
    const watchRings = () => {
      const nodes = [...stage.querySelectorAll("[data-part=ring]")];
      maxRings = Math.max(maxRings, nodes.length);
      for (const node of nodes) {
        const entry = rings.get(node) ?? { rects: [], leavingSeen: false, nonOpacity: [] };
        const box = node.getBoundingClientRect();
        entry.rects.push([box.x, box.y, box.width, box.height]);
        entry.leavingSeen ||= node.hasAttribute("data-leaving");
        for (const animation of node.getAnimations()) {
          const keys = (animation.effect as KeyframeEffect).getKeyframes().flatMap((keyframe) => Object.keys(keyframe));
          entry.nonOpacity.push(...keys.filter((key) => !["offset", "computedOffset", "easing", "composite", "opacity"].includes(key)));
        }
        rings.set(node, entry);
      }
    };
    await frame();
    const start = drawn();
    watchRings();
    await press(which);
    const rippleAtPress = ripple();
    let target = parse(pointer().style.translate);
    let abandoned: { x: number; y: number } | undefined;
    const samples: { x: number; y: number; t: number; ripple: { x: number; y: number } | null }[] = [];
    let jump: number | undefined;
    let interruptedAt: number | undefined;
    const begin = await frame();
    for (let now = begin; now - begin < 900; now = await frame()) {
      if (interruptAt !== undefined && jump === undefined && now - begin >= interruptAt) {
        const before = drawn();
        const frameTime = document.timeline.currentTime;
        await press("next");
        const after = drawn();
        if (document.timeline.currentTime !== frameTime) throw new Error("retarget: a frame passed before the update committed");
        jump = Math.hypot(after.x - before.x, after.y - before.y);
        interruptedAt = now - begin;
        abandoned = target;
        target = parse(pointer().style.translate);
      }
      samples.push({ ...drawn(), t: now - begin, ripple: ripple() });
      watchRings();
    }
    const end = drawn();
    return {
      start, target, samples, jump, interruptedAt, maxRings, rippleAtPress, abandoned,
      rings: [...rings.values()],
      settled: { ...end, running: pointer().getAnimations().length, rings: stage.querySelectorAll("[data-part=ring]").length },
    };
  }, [button, interruptAfterMs] as const);
}

/** Largest distance of a sample from the straight chord start → end. */
function bowOff(trace: Trace, from: { x: number; y: number }): number {
  const { target } = trace;
  const dx = target.x - from.x, dy = target.y - from.y, length = Math.hypot(dx, dy);
  return Math.max(...trace.samples.map((p) => Math.abs((p.x - from.x) * dy - (p.y - from.y) * dx) / length));
}

function assertRingsInPlace(trace: Trace, label: string): void {
  for (const ring of trace.rings) {
    const [first] = ring.rects;
    const drift = Math.max(...ring.rects.map((rect) => Math.max(...rect.map((value, index) => Math.abs(value - first![index]!)))));
    assert(drift <= 0.5, `${label}: a ring changed size or position while shown (${drift.toFixed(2)}px): ${JSON.stringify(ring.rects.slice(0, 6))}`);
    assert(ring.nonOpacity.length === 0, `${label}: ring animations may only fade: ${ring.nonOpacity.join(", ")}`);
  }
  assert(trace.maxRings <= 2, `${label}: at most the old and the new ring at once, saw ${trace.maxRings}`);
}

/**
 * The click ripple starts only on arrival: none in the click frame or while the pointer is on its way, then
 * within 50ms of the frame the pointer lands, anchored on the target; a target abandoned mid-glide never
 * gets one.
 */
function assertRippleOnArrival(trace: Trace, label: string): string {
  const same = (a: { x: number; y: number } | null | undefined, b: { x: number; y: number }) => !!a && Math.hypot(a.x - b.x, a.y - b.y) <= 0.01;
  const arrival = trace.samples.findIndex((p) => same(p, trace.target));
  const first = trace.samples.findIndex((p) => p.ripple);
  assert(trace.rippleAtPress === null, `${label}: a ripple was showing in the click frame: ${JSON.stringify(trace.rippleAtPress)}`);
  assert(arrival >= 0 && first >= arrival, `${label}: the ripple started before the pointer arrived (ripple frame ${first}, arrival frame ${arrival})`);
  const lag = trace.samples[first]!.t - trace.samples[arrival]!.t;
  assert(lag <= 50, `${label}: the ripple started ${lag.toFixed(1)}ms after the arrival`);
  assert(trace.samples.slice(first).every((p) => same(p.ripple, trace.target)), `${label}: the ripple must stay anchored on the arrival point ${JSON.stringify(trace.target)}`);
  const { abandoned } = trace;
  assert(!abandoned || !trace.samples.some((p) => same(p.ripple, abandoned)), `${label}: the abandoned target got a ripple`);
  return `${label}: arrival ${trace.samples[arrival]!.t.toFixed(0)}ms, ripple +${lag.toFixed(1)}ms`;
}

function assertSettled(trace: Trace, label: string): void {
  const off = Math.hypot(trace.settled.x - trace.target.x, trace.settled.y - trace.target.y);
  assert(off <= 0.01 && trace.settled.running === 0, `${label}: the glide must end exactly on the target: ${JSON.stringify({ off, settled: trace.settled, target: trace.target })}`);
}

export async function checkAgentPointerMotion(browser: Browser, origin: string, shots: string): Promise<string[]> {
  const report: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?page=blocks/AgentPointer&theme=light&width=wide`, { waitUntil: "networkidle" });
  const lab = page.locator(`[data-ds-story="${LAB}"] [data-ds-theme="light"]`).first();
  await lab.locator("[data-pointer-lab] [data-part=pointer]").waitFor({ state: "visible", timeout: 20_000 });

  // 1. Target change: card 4 → card 3 (a long diagonal).
  const change = await play(lab, "next");
  const travel = Math.hypot(change.target.x - change.start.x, change.target.y - change.start.y);
  const bow = bowOff(change, change.start);
  const moving = change.samples.filter((p) => p.t < 380);
  report.push(`glide ${travel.toFixed(1)}px: bow ${bow.toFixed(1)}px (${(bow / travel * 100).toFixed(1)}%), ${moving.length} frames < 380ms`);
  assert(moving.length >= 8, `glide: too few frames while moving (${moving.length})`);
  assert(bow >= Math.max(6, travel * 0.06), `glide: the path must curve off the straight line (bow ${bow.toFixed(2)}px over ${travel.toFixed(1)}px)`);
  assertSettled(change, "glide");
  report.push(assertRippleOnArrival(change, "ripple"));
  assertRingsInPlace(change, "target change");
  assert(change.rings.some((ring) => ring.leavingSeen) && change.settled.rings === 1,
    `target change: the old ring fades out where it was and only the new ring stays: ${JSON.stringify({ rings: change.rings.length, settled: change.settled })}`);

  // 2. Retarget mid-glide: card 3 → card 0, then card 7 after 150ms.
  const retarget = await play(lab, "next", 150);
  // Speed (px/ms) in the frame before and the frame after the retarget: the new glide carries the speed on.
  const at = retarget.samples.findIndex((p) => p.t === retarget.interruptedAt);
  const speed = (i: number) => {
    const [a, b] = [retarget.samples[i - 1]!, retarget.samples[i]!];
    return Math.hypot(b.x - a.x, b.y - a.y) / (b.t - a.t);
  };
  const [speedBefore, speedAfter] = at > 0 && at + 1 < retarget.samples.length ? [speed(at), speed(at + 1)] : [Number.NaN, Number.NaN];
  report.push(`retarget at ${retarget.interruptedAt?.toFixed(0)}ms: same-frame jump ${retarget.jump?.toFixed(3)}px, speed ${speedBefore.toFixed(2)} → ${speedAfter.toFixed(2)} px/ms`);
  assert(retarget.jump !== undefined && retarget.jump <= 2, `retarget: the pointer jumped ${retarget.jump}px when the target changed mid-glide`);
  assert(speedAfter <= speedBefore * 2 + 0.05, `retarget: the pointer lurched after the retarget (${speedBefore.toFixed(2)} → ${speedAfter.toFixed(2)} px/ms)`);
  assertSettled(retarget, "retarget");
  report.push(assertRippleOnArrival(retarget, "retarget ripple"));
  assertRingsInPlace(retarget, "retarget");

  // 3. Whole page: no ring; the card ring fades out in place.
  const whole = await play(lab, "page");
  assertRingsInPlace(whole, "whole page");
  assert(whole.settled.rings === 0, `whole page: no ring for a whole-page target, found ${whole.settled.rings}`);
  report.push(`whole page: rings after ${whole.samples.at(-1)?.t.toFixed(0)}ms ${whole.settled.rings}`);
  for (const name of [LAB, ...FRAME_STORIES]) {
    const story = page.locator(`[data-ds-story="${name}"] [data-ds-theme="light"]`).first();
    await story.screenshot({ path: join(shots, `agent-pointer-${name.replace(/[^a-z0-9]+/giu, "-").slice(0, 48).toLowerCase()}.png`) });
  }

  // 4. Reduced motion, forced by the prop: the pointer jumps and the ring appears without a fade.
  const reducedLab = page.locator(`[data-ds-story="${REDUCED_LAB}"] [data-ds-theme="light"]`).first();
  report.push(`reduced (prop): ${await assertJumps(reducedLab, "reduced (prop)")}`);
  assert(errors.length === 0, `agent pointer: page errors ${errors.join(" | ")}`);
  await context.close();

  // 5. Reduced motion from the OS setting, on the regular lab.
  const os = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  const osPage = await os.newPage();
  await osPage.goto(`${origin}/?page=blocks/AgentPointer&theme=light&width=wide`, { waitUntil: "networkidle" });
  const osLab = osPage.locator(`[data-ds-story="${LAB}"] [data-ds-theme="light"]`).first();
  await osLab.locator("[data-pointer-lab] [data-part=pointer]").waitFor({ state: "visible", timeout: 20_000 });
  report.push(`reduced (OS): ${await assertJumps(osLab, "reduced (OS)")}`);
  await os.close();
  return report;
}

/** In the frame of the click: the pointer is on the target, nothing animates, one ring at full opacity. */
async function assertJumps(lab: Locator, label: string): Promise<string> {
  await lab.locator("[data-pointer-lab] [data-part=pointer]").waitFor({ state: "visible", timeout: 20_000 });
  const facts = await lab.evaluate(async (root) => {
    const stage = root.querySelector<HTMLElement>("[data-pointer-lab]")!;
    const before = stage.innerHTML;
    const frameTime = document.timeline.currentTime;
    root.querySelector<HTMLElement>("[data-pointer-lab-next]")!.click();
    for (let tick = 0; tick < 50 && stage.innerHTML === before; tick += 1) await Promise.resolve();
    if (stage.innerHTML === before || document.timeline.currentTime !== frameTime) throw new Error("the click did not commit within the frame");
    const pointer = stage.querySelector<HTMLElement>("[data-part=pointer]")!;
    const rings = [...stage.querySelectorAll<HTMLElement>("[data-part=ring]")];
    return {
      drawn: getComputedStyle(pointer).translate, target: pointer.style.translate,
      animations: pointer.getAnimations().length + rings.reduce((sum, ring) => sum + ring.getAnimations().length, 0),
      rings: rings.map((ring) => ({ opacity: getComputedStyle(ring).opacity, leaving: ring.hasAttribute("data-leaving") })),
      ripple: stage.querySelector<HTMLElement>("[data-part=ripple]")?.style.translate ?? null,
    };
  });
  const near = (a: string, b: string) => {
    const [ax = 0, ay = 0] = a.split(" ").map(Number.parseFloat), [bx = 0, by = 0] = b.split(" ").map(Number.parseFloat);
    return Math.hypot(ax - bx, ay - by) <= 0.01;
  };
  assert(near(facts.drawn, facts.target) && facts.animations === 0, `${label}: the pointer must jump with no animation: ${JSON.stringify(facts)}`);
  assert(facts.ripple !== null && near(facts.ripple, facts.target), `${label}: the ripple starts at once on the target: ${JSON.stringify(facts)}`);
  assert(facts.rings.length === 1 && facts.rings[0]!.opacity === "1" && !facts.rings[0]!.leaving, `${label}: one ring, shown at once: ${JSON.stringify(facts.rings)}`);
  return `jump to ${facts.target}, ripple at ${facts.ripple}, ${facts.animations} animations, rings ${JSON.stringify(facts.rings)}`;
}
