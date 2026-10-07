// test-category: pure-logic
/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  SEND_FLIGHT_MAX_HEIGHT_RATIO,
  SEND_ORIGIN_MAX_AGE_MS,
  clearSendOrigin,
  flySendBubble,
  hasSendOrigin,
  recordSendOrigin,
} from "./sendFlight";

const GLOBAL_KEYS = ["window", "document", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean };
let calls: Call[] = [];
let reduced = false;
let now = 1_000;
const realNow = Date.now;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function element(box: DOMRect, padding = { left: 10, top: 6, right: 10 }): HTMLElement {
  const node = document.createElement("div");
  document.body.append(node);
  node.getBoundingClientRect = () => box;
  node.style.paddingLeft = `${padding.left}px`;
  node.style.paddingTop = `${padding.top}px`;
  node.style.paddingRight = `${padding.right}px`;
  (node as unknown as { animate: unknown }).animate = (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    const call: Call = { keyframes, options, cancelled: false };
    calls.push(call);
    return { cancel: () => { call.cancelled = true; }, currentTime: 0 } as unknown as Animation;
  };
  return node;
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "innerWidth", { value: 1200, configurable: true });
  dom.window.matchMedia = ((query: string) => ({ matches: reduced && query.includes("reduce"), media: query })) as typeof dom.window.matchMedia;
  calls = [];
  reduced = false;
  now = 1_000;
  Date.now = () => now;
  clearSendOrigin();
});

afterEach(() => {
  Date.now = realNow;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("a recorded send origin flies the next bubble up from the composer with translate only", () => {
  // The composer's text box spans the column (content edge 410..1070); the
  // user bubble is right-aligned (text edge ..1050).
  recordSendOrigin(element(rect(400, 700, 680, 24)));
  expect(hasSendOrigin()).toBe(true);
  const bubble = element(rect(760, 420, 300, 36));

  const flight = flySendBubble(bubble);

  expect(flight).not.toBeNull();
  expect(calls).toHaveLength(1);
  const [call] = calls;
  // The bubble starts right-aligned to the composer text box, with its text
  // top where the composer text sat: mostly vertical travel, never a slide
  // from the composer's left edge.
  expect(call!.keyframes[0]).toEqual({ translate: "20px 274px" });
  expect(call!.keyframes[1]).toEqual({ translate: "0px 0px" });
  expect(Object.keys(call!.keyframes[0]!)).toEqual(["translate"]);
  expect(call!.options.easing).toContain("cubic-bezier(0, 0, 0, 1)");
  expect(call!.options.duration).toBe(320);
  // One origin feeds one bubble.
  expect(flySendBubble(element(rect(760, 480, 300, 36)))).toBeNull();
});

test("short travel uses the slow token and cancel stops the flight", () => {
  recordSendOrigin(element(rect(700, 560, 300, 24)));
  const flight = flySendBubble(element(rect(760, 440, 300, 36)));
  expect(calls[0]!.options.duration).toBe(220);
  flight!.cancel();
  expect(calls[0]!.cancelled).toBe(true);
});

test("the same bubble may re-claim its origin (effects that run twice)", () => {
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  const bubble = element(rect(760, 420, 300, 36));
  flySendBubble(bubble)!.cancel();
  expect(flySendBubble(bubble)).not.toBeNull();
});

test("stale origins, off-screen bubbles and reduced motion fall back to the regular insert", () => {
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  now += SEND_ORIGIN_MAX_AGE_MS + 1;
  expect(hasSendOrigin()).toBe(false);
  expect(flySendBubble(element(rect(760, 420, 300, 36)))).toBeNull();

  reduced = true;
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  expect(flySendBubble(element(rect(760, 420, 300, 36)))).toBeNull();
  expect(calls).toHaveLength(0);
});

test("a bubble that ends outside the viewport after the list scrolls uses the regular insert", async () => {
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  expect(flySendBubble(element(rect(760, 900, 300, 36)))).not.toBeNull();
  await Promise.resolve();
  expect(calls[0]!.cancelled).toBe(true);
  expect(calls[1]!.keyframes[0]).toEqual({ opacity: 0, translate: "0px 4px" });
  expect(calls[1]!.options.duration).toBe(160);
});

test("a layout change after mount keeps the bubble where it is seen and finishes at the new place", async () => {
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  const row = element(rect(700, 410, 400, 56));
  const bubble = element(rect(760, 420, 300, 36));
  row.append(bubble);
  flySendBubble(bubble);
  const [startX, startY] = String(calls[0]!.keyframes[0]!.translate).split(" ").map((part) => Number.parseFloat(part));
  // The list scrolls the row up by 80px after the flight started, before its
  // first frame: the bubble was drawn at its start offset from the old place.
  row.getBoundingClientRect = () => rect(700, 330, 400, 56);
  await Promise.resolve();
  expect(calls[0]!.cancelled).toBe(true);
  // The scroll does not drag the bubble: it continues from where it was drawn.
  expect(calls[1]!.keyframes[0]).toEqual({ translate: `${startX}px ${startY! + 80}px` });
});

test("retargeting reads layout from the unanimated row and never samples the animated style", async () => {
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  const row = element(rect(700, 410, 400, 56));
  const bubble = element(rect(760, 420, 300, 36));
  row.append(bubble);
  let bubbleReads = 0;
  bubble.getBoundingClientRect = () => { bubbleReads += 1; return rect(760, 420, 300, 36); };
  const computed = window.getComputedStyle.bind(window);
  let styleReads = 0;
  window.getComputedStyle = ((node: Element) => { if (node === bubble) styleReads += 1; return computed(node); }) as typeof window.getComputedStyle;
  flySendBubble(bubble);
  const before = { bubbleReads, styleReads };
  await Promise.resolve();
  // Reading the animated bubble (its box or computed translate) would pull a
  // compositor animation back to the main thread every retarget frame.
  expect(bubbleReads).toBe(before.bubbleReads);
  expect(styleReads).toBe(before.styleReads);
});

test("a long message (tall origin text or tall bubble) uses the regular insert", () => {
  // Composer text taller than 35% of the 800px viewport.
  recordSendOrigin(element(rect(100, 300, 600, 420)));
  expect(flySendBubble(element(rect(760, 420, 300, 36)))).toBeNull();
  // Bubble taller than 35% of the viewport.
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  expect(flySendBubble(element(rect(760, 200, 300, 300)))).toBeNull();
  // Just under the threshold still flies.
  recordSendOrigin(element(rect(100, 500, 600, 270)));
  expect(flySendBubble(element(rect(760, 200, 300, 270)))).not.toBeNull();
  expect(SEND_FLIGHT_MAX_HEIGHT_RATIO).toBe(0.35);
});

test("without a measurable origin nothing is recorded", () => {
  recordSendOrigin(null);
  expect(hasSendOrigin()).toBe(false);
  recordSendOrigin(element(rect(0, 0, 0, 0)));
  expect(hasSendOrigin()).toBe(false);
});

test("retargeting stops after its time window whatever the frame rate", async () => {
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  const row = element(rect(700, 410, 400, 56));
  const bubble = element(rect(760, 420, 300, 36));
  row.append(bubble);
  const realPerformanceNow = performance.now.bind(performance);
  let clock = 0;
  performance.now = () => clock;
  const scheduled: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => { scheduled.push(callback); return scheduled.length; }) as typeof requestAnimationFrame;
  try {
    flySendBubble(bubble);
    await Promise.resolve();
    // 60Hz frames: 8 frames would last 133ms; the window ends at 64ms.
    let frames = 0;
    while (scheduled.length > 0 && frames < 20) {
      clock += 16.7;
      scheduled.shift()!(clock);
      frames += 1;
    }
    expect(frames).toBeLessThanOrEqual(4);
  } finally {
    performance.now = realPerformanceNow;
  }
});
