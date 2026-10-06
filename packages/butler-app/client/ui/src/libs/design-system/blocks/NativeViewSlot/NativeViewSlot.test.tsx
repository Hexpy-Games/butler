/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeViewScale, toNativeViewBounds, type NativeViewBounds } from "./nativeViewGeometry";
import { createNativeViewTracker } from "./nativeViewTracker";
import { NativeViewSlot } from "./NativeViewSlot";

type Rect = { left: number; top: number; width: number; height: number };
let dom: JSDOM;
let frames: Array<() => void> = [];
const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "document", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"];

function setRect(element: Element, rect: Rect) {
  const box = { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
  element.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
}

/** Runs queued animation frames (and the frames they queue) up to `limit`. */
async function flush(limit = 10) {
  await Promise.resolve();
  for (let index = 0; index < limit && frames.length; index += 1) {
    const batch = frames;
    frames = [];
    batch.forEach((run) => run());
    await Promise.resolve();
  }
}

beforeEach(() => {
  dom = new JSDOM('<div id="shell"><div id="slot"><div id="frame"></div></div></div>');
  for (const key of GLOBALS) saved[key] = (globalThis as Record<string, unknown>)[key];
  frames = [];
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (run: () => void) => frames.push(run), cancelAnimationFrame: () => { frames = []; },
  });
});

afterEach(() => {
  Object.assign(globalThis, saved);
  dom.window.close();
});

function track(options: { hidden?: boolean } = {}) {
  const doc = dom.window.document;
  const root = doc.getElementById("slot")!;
  const target = doc.getElementById("frame")!;
  setRect(target, { left: 300.4, top: 80.6, width: 800, height: 600 });
  setRect(root, { left: 300, top: 80, width: 800, height: 600 });
  const bounds: NativeViewBounds[] = [];
  const occlusion: boolean[] = [];
  const tracker = createNativeViewTracker({
    root, target, hidden: options.hidden ?? false, covered: false,
    onBounds: (next) => bounds.push(next), onOcclusion: (next) => occlusion.push(next),
  });
  return { doc, root, target, bounds, occlusion, tracker };
}

// test-category: race
test("bounds are reported at most once per frame and only when they change", async () => {
  const view = track();
  view.tracker.update({ hidden: false, covered: false });
  view.tracker.update({ hidden: false, covered: false });
  await flush();
  expect(view.bounds).toEqual([{ x: 300, y: 81, width: 800, height: 600, visible: true, scale: 1 }]);
  setRect(view.target, { left: 0, top: 81, width: 1100, height: 600 });
  view.doc.dispatchEvent(new dom.window.Event("scroll"));
  await flush();
  expect(view.bounds.at(-1)).toEqual({ x: 0, y: 81, width: 1100, height: 600, visible: true, scale: 1 });
  expect(view.bounds).toHaveLength(2);
  view.tracker.destroy();
  expect(view.bounds.at(-1)?.visible).toBe(false);
});

// test-category: race
test("hidden or zero-size slots report visible=false", async () => {
  const view = track({ hidden: true });
  await flush();
  expect(view.bounds.at(-1)?.visible).toBe(false);
  view.tracker.update({ hidden: false, covered: false });
  setRect(view.target, { left: 10, top: 10, width: 0, height: 400 });
  await flush();
  expect(view.bounds.at(-1)).toMatchObject({ width: 0, visible: false });
  view.tracker.destroy();
});

// test-category: race
test("a DS overlay over the slot occludes it until it is removed", async () => {
  const view = track();
  await flush();
  const menu = view.doc.createElement("div");
  menu.setAttribute("data-slot", "dropdown-menu-content");
  setRect(menu, { left: 900, top: 60, width: 220, height: 200 });
  view.doc.body.append(menu);
  await flush();
  expect(view.occlusion).toEqual([true]);
  menu.remove();
  await flush();
  expect(view.occlusion).toEqual([true, false]);
  const far = view.doc.createElement("div");
  far.setAttribute("data-slot", "tooltip-content");
  setRect(far, { left: 10, top: 10, width: 60, height: 20 });
  view.doc.body.append(far);
  await flush();
  expect(view.occlusion).toEqual([true, false]);
  view.tracker.destroy();
});

// test-category: race
test("a panel animating the slot's ancestor occludes it and frames stop once it settles", async () => {
  const view = track();
  await flush();
  let playState = "running";
  const slide = { playState: "", effect: { getKeyframes: () => [{ transform: "translateX(304px)" }, { transform: "none" }] } };
  Object.defineProperty(slide, "playState", { get: () => playState });
  view.doc.getElementById("shell")!.getAnimations = () => [slide as unknown as Animation];
  view.doc.dispatchEvent(new dom.window.Event("scroll"));
  await flush(3);
  expect(view.occlusion).toEqual([true]);
  expect(frames.length).toBe(1);
  playState = "finished";
  await flush();
  expect(view.occlusion).toEqual([true, false]);
  expect(frames.length).toBe(0);
  view.tracker.destroy();
});

// test-category: pure-logic
test("fixed viewports report their scale and keep their aspect", () => {
  expect(nativeViewScale({ width: 1280, height: 800 }, 640)).toBe(0.5);
  expect(nativeViewScale(undefined, 640)).toBe(1);
  expect(toNativeViewBounds({ left: 0.5, top: 0, right: 960.5, bottom: 600, width: 960, height: 600 }, true, { width: 1280, height: 800 }))
    .toEqual({ x: 1, y: 0, width: 960, height: 600, visible: true, scale: 0.75 });
  const html = renderToStaticMarkup(<NativeViewSlot viewport={{ width: 1280, height: 800 }} onBoundsChange={() => undefined} />);
  expect(html).toContain('data-fixed="true"');
  expect(html).toContain("--native-view-width:1280");
});
