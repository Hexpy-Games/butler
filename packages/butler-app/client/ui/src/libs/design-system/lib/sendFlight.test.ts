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

function element(box: DOMRect, padding = { left: 10, top: 6 }): HTMLElement {
  const node = document.createElement("div");
  document.body.append(node);
  node.getBoundingClientRect = () => box;
  node.style.paddingLeft = `${padding.left}px`;
  node.style.paddingTop = `${padding.top}px`;
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

test("a recorded send origin flies the next bubble from the composer text with translate only", () => {
  recordSendOrigin(element(rect(100, 700, 600, 24)));
  expect(hasSendOrigin()).toBe(true);
  const bubble = element(rect(760, 420, 300, 36));

  const flight = flySendBubble(bubble);

  expect(flight).not.toBeNull();
  expect(calls).toHaveLength(1);
  const [call] = calls;
  // Bubble text (inside 10/6px padding) starts where the composer text started.
  expect(call!.keyframes[0]).toEqual({ translate: "-670px 274px" });
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
  let box = rect(760, 420, 300, 36);
  const bubble = element(box);
  bubble.getBoundingClientRect = () => box;
  flySendBubble(bubble);
  // The list scrolls the row up by 80px in the same commit; no translate is computed in jsdom.
  box = rect(760, 340, 300, 36);
  await Promise.resolve();
  expect(calls[0]!.cancelled).toBe(true);
  expect(calls[1]!.keyframes[0]).toEqual({ translate: "0px 0px" });
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
