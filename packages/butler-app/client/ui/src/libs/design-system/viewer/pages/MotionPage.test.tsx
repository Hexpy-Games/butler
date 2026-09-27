/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_VIEWER_STATE } from "../viewerState";
import { MotionPage } from "./MotionPage";

const css = readFileSync(new URL("../DesignSystemViewer.module.css", import.meta.url), "utf8");
const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

function setup() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  return dom.window.document;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

test("each Replay remounts its demos so their CSS animations restart from the first frame", async () => {
  const document = setup();
  await act(async () => root!.render(
    <MotionPage entries={[]} locale="en-US" state={DEFAULT_VIEWER_STATE} onChange={() => undefined} onOpen={() => undefined} />,
  ));
  for (const [group, selector] of [["durations", "[data-ds-motion-group=\"durations\"] [data-ds-motion-demo]"],
    ["easings", "[data-ds-motion-group=\"easings\"] [data-ds-motion-demo]"],
    ["distances", "[data-ds-motion-group=\"distances\"] [data-ds-motion-demo]"]] as const) {
    const before = [...document.querySelectorAll(selector)];
    expect(before.length).toBeGreaterThan(0);
    const button = document.querySelector<HTMLButtonElement>(`[data-ds-motion="${group}"]`)!;
    await act(async () => { button.click(); });
    const after = [...document.querySelectorAll(selector)];
    expect(after.length).toBe(before.length);
    // New nodes: the browser starts their animations again; a toggled attribute would reverse a transition instead.
    after.forEach((node, index) => expect(node).not.toBe(before[index]));
    expect(after[0]!.getAttribute("data-ds-motion-run")).toBe("1");
  }
});

test("motion demos animate on mount (keyframes), not through a transition on a toggled attribute", () => {
  expect(rule(".motionDot")).toMatch(/animation:\s*motion-travel /u);
  expect(rule(".motionBox")).toMatch(/animation:\s*motion-shift /u);
  expect(css).not.toContain("[data-on=");
  expect(css).toMatch(/@keyframes motion-travel/u);
  expect(css).toMatch(/@keyframes motion-shift/u);
});
