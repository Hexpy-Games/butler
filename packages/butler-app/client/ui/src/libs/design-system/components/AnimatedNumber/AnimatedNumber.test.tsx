/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AnimatedNumber } from "./AnimatedNumber";

const css = readFileSync(new URL("./AnimatedNumber.module.css", import.meta.url), "utf8");
const KEYS = ["window", "document", "navigator", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;

async function mount({ reduce }: { reduce: boolean }) {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const frames: FrameRequestCallback[] = [];
  const animations: Keyframe[][] = [];
  Object.defineProperty(dom.window, "matchMedia", {
    value: (query: string) => ({ matches: reduce && query.includes("reduce"), addEventListener() {}, removeEventListener() {} }),
  });
  (dom.window.HTMLElement.prototype as unknown as { animate: unknown }).animate = function (keyframes: Keyframe[]) {
    animations.push(keyframes);
    return { cancel() {}, finished: Promise.resolve() };
  };
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const format = (value: number) => value.toLocaleString("en-US");
  const render = (value: number, live = false) => act(async () => root.render(<AnimatedNumber value={value} format={format} live={live} />));
  const flush = async (timestamp: number) => {
    const pending = frames.splice(0);
    await act(async () => { for (const frame of pending) frame(timestamp); });
  };
  return {
    container, render, flush, animations,
    visible: () => container.querySelector('[data-slot="animated-number-value"]')!.textContent,
    spoken: () => container.querySelector('[data-slot="animated-number-final"]')!.textContent,
    async cleanup() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test("AnimatedNumber shows the first value without animating and exposes the final value as static text", async () => {
  const view = await mount({ reduce: false });
  try {
    await view.render(1284);
    const root = view.container.querySelector('[data-slot="animated-number"]')!;
    expect(root.getAttribute("data-numeric")).toBe("tabular");
    expect(view.visible()).toBe("1,284");
    expect(view.spoken()).toBe("1,284");
    expect(view.container.querySelector('[data-slot="animated-number-value"]')!.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(view.container.querySelector('[data-slot="animated-number-final"]')!.closest('[aria-hidden="true"]')).toBeNull();
    expect(view.container.querySelector("[aria-live]")).toBeNull();
  } finally { await view.cleanup(); }
});

test("AnimatedNumber counts to a new value with decelerate easing over the deliberate duration", async () => {
  const view = await mount({ reduce: false });
  try {
    await view.render(0);
    await view.render(1000, true);
    // Screen readers get the final value at once, politely.
    expect(view.spoken()).toBe("1,000");
    expect(view.container.querySelector('[aria-live="polite"]')!.textContent).toBe("1,000");
    await view.flush(1000);
    expect(view.visible()).toBe("0");
    await view.flush(1080); // quarter of 320ms: decelerate is past halfway
    const quarter = Number(view.visible()!.replace(/,/gu, ""));
    expect(quarter).toBeGreaterThan(500);
    expect(quarter).toBeLessThan(1000);
    await view.flush(1400);
    expect(view.visible()).toBe("1,000");
    // Start and end values are kept as invisible sizers in the same cell.
    const sizers = [...view.container.querySelectorAll('[data-slot="animated-number-sizer"]')].map((node) => node.textContent);
    expect(sizers).toContain("1,000");
  } finally { await view.cleanup(); }
});

test("AnimatedNumber under reduced motion swaps instantly and fades the new value in", async () => {
  const view = await mount({ reduce: true });
  try {
    await view.render(3);
    await view.render(42);
    expect(view.visible()).toBe("42");
    expect(view.animations.length).toBe(1);
    expect(view.animations[0]!.map((frame) => frame.opacity)).toEqual([0, 1]);
    expect(view.animations[0]!.some((frame) => "transform" in frame)).toBe(false);
  } finally { await view.cleanup(); }
});

test("AnimatedNumber CSS stacks sizers and value in one grid cell with tabular numerals", () => {
  expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/u);
  expect(css).toMatch(/grid-area:\s*1\s*\/\s*1/u);
  expect(css).toMatch(/visibility:\s*hidden/u);
});
