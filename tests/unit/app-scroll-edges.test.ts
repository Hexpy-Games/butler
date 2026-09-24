/// <reference lib="dom" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  observeScrollEdges,
  readScrollEdges,
} from "../../packages/butler-app/client/ui/src/libs/design-system/lib/useScrollEdges.ts";

type Metrics = { position: number; size: number; total: number };

const saved: Record<string, unknown> = {};
let frames: Array<() => void> = [];
let resizeCallbacks: Array<() => void> = [];
let observedTargets: Element[] = [];

beforeEach(() => {
  for (const key of ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "MutationObserver"]) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
  }
  frames = [];
  resizeCallbacks = [];
  observedTargets = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: (id: number) => {
      frames[id - 1] = () => {};
    },
    ResizeObserver: class {
      constructor(private callback: () => void) {}
      observe(target: Element) {
        observedTargets.push(target);
        resizeCallbacks.push(this.callback);
      }
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback);
      }
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, saved);
});

function flushFrames() {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame();
}

function scroller(axis: "x" | "y", metrics: Metrics): HTMLDivElement {
  const dom = new JSDOM("<!doctype html><div><div>content</div></div>");
  (globalThis as Record<string, unknown>).MutationObserver = dom.window.MutationObserver;
  const element = dom.window.document.querySelector("div") as HTMLDivElement;
  const [position, size, total] = axis === "x"
    ? ["scrollLeft", "clientWidth", "scrollWidth"]
    : ["scrollTop", "clientHeight", "scrollHeight"];
  Object.defineProperty(element, position, { configurable: true, get: () => metrics.position });
  Object.defineProperty(element, size, { configurable: true, get: () => metrics.size });
  Object.defineProperty(element, total, { configurable: true, get: () => metrics.total });
  return element;
}

function edges(element: HTMLElement) {
  return {
    overflowing: element.dataset.overflowing,
    atStart: element.dataset.atStart,
    atEnd: element.dataset.atEnd,
  };
}

test("readScrollEdges reports resting edges with a 1px tolerance on both axes", () => {
  for (const axis of ["x", "y"] as const) {
    const metrics = { position: 0, size: 100, total: 300 };
    const element = scroller(axis, metrics);
    expect(readScrollEdges(element, axis)).toEqual({ overflowing: true, atStart: true, atEnd: false });
    metrics.position = 1;
    expect(readScrollEdges(element, axis)).toEqual({ overflowing: true, atStart: true, atEnd: false });
    metrics.position = 100;
    expect(readScrollEdges(element, axis)).toEqual({ overflowing: true, atStart: false, atEnd: false });
    metrics.position = 199;
    expect(readScrollEdges(element, axis)).toEqual({ overflowing: true, atStart: false, atEnd: true });
    metrics.total = 101;
    metrics.position = 0;
    expect(readScrollEdges(element, axis)).toEqual({ overflowing: false, atStart: true, atEnd: true });
  }
});

test("observeScrollEdges writes data attributes and batches scroll updates per frame", () => {
  const metrics = { position: 0, size: 100, total: 300 };
  const element = scroller("x", metrics);
  const stop = observeScrollEdges(element, "x");
  expect(edges(element)).toEqual({ overflowing: "true", atStart: "true", atEnd: "false" });

  metrics.position = 50;
  element.dispatchEvent(new element.ownerDocument.defaultView!.Event("scroll"));
  element.dispatchEvent(new element.ownerDocument.defaultView!.Event("scroll"));
  expect(frames.length).toBe(1);
  expect(edges(element).atStart).toBe("true");
  flushFrames();
  expect(edges(element)).toEqual({ overflowing: "true", atStart: "false", atEnd: "false" });

  metrics.position = 200;
  element.dispatchEvent(new element.ownerDocument.defaultView!.Event("scroll"));
  flushFrames();
  expect(edges(element)).toEqual({ overflowing: "true", atStart: "false", atEnd: "true" });

  stop();
  metrics.position = 0;
  element.dispatchEvent(new element.ownerDocument.defaultView!.Event("scroll"));
  expect(frames.length).toBe(0);
  expect(edges(element).atStart).toBe("false");
});

test("observeScrollEdges reacts to element and first-child resizes", () => {
  const metrics = { position: 0, size: 100, total: 300 };
  const element = scroller("y", metrics);
  const stop = observeScrollEdges(element, "y");
  expect(observedTargets).toContain(element);
  expect(observedTargets).toContain(element.firstElementChild!);

  metrics.total = 90;
  for (const callback of resizeCallbacks) callback();
  flushFrames();
  expect(edges(element)).toEqual({ overflowing: "false", atStart: "true", atEnd: "true" });
  stop();
  expect(resizeCallbacks.length).toBe(0);
});

test("scroll-fade stylesheet drives per-edge masks from the edge attributes", () => {
  const css = readFileSync(
    "packages/butler-app/client/ui/src/libs/design-system/scroll-fade.css",
    "utf8",
  );
  const tokens = readFileSync(
    "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
    "utf8",
  );
  expect(tokens.trimStart().startsWith('@import url("./scroll-fade.css");')).toBe(true);
  expect(css).toContain('[data-scroll-fade="x"]');
  expect(css).toContain('[data-scroll-fade="y"]');
  expect(css).toContain('[data-overflowing="true"]:not([data-at-start="true"])');
  expect(css).toContain('[data-overflowing="true"]:not([data-at-end="true"])');
  expect(css).toContain("var(--scroll-fade-size)");
  expect(css).toContain("--scroll-fade-gutter");
  expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{[^}]*transition/u);
});
