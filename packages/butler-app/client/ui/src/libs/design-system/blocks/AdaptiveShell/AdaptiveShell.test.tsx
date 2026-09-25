/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace } from "./AdaptiveShell";

const css = readFileSync(new URL("./AdaptiveShell.module.css", import.meta.url), "utf8");
const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

type FakeAnimation = { keyframes: Keyframe[]; cancelled: boolean; finish: () => void };

function setup({ reducedMotion = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const animations: FakeAnimation[] = [];
  dom.window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") ? reducedMotion : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof dom.window.matchMedia;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function rect() {
    return { width: this.getAttribute("data-slot") === "adaptive-shell-sidebar" ? 300 : 900, height: 600, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  (dom.window.HTMLElement.prototype as unknown as { animate: unknown }).animate = function animate(keyframes: Keyframe[]) {
    let resolve!: () => void;
    const finished = new Promise<void>((done) => { resolve = done; });
    const animation: FakeAnimation & { finished: Promise<void>; cancel: () => void } = {
      keyframes, cancelled: false, finished,
      finish: () => resolve(),
      cancel: () => { animation.cancelled = true; },
    };
    animations.push(animation);
    return animation;
  };
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  const render = (leftOpen: boolean) => act(async () => root!.render(
    <AdaptiveShell leftOpen={leftOpen} rightOpen={false}>
      <AdaptiveShellSidebar open={leftOpen}>nav</AdaptiveShellSidebar>
      <AdaptiveShellWorkspace>work</AdaptiveShellWorkspace>
    </AdaptiveShell>,
  ));
  const shell = () => dom.window.document.querySelector<HTMLElement>("[data-left-open]")!;
  return { render, shell, animations };
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("closing the sidebar collapses the track at once and slides the workspace in from the sidebar width", async () => {
  const { render, shell, animations } = setup();
  await render(true);
  expect(shell().getAttribute("data-left-track")).toBe("true");
  await render(false);
  expect(shell().getAttribute("data-left-track")).toBe("false");
  expect(animations).toHaveLength(1);
  expect(animations[0]!.keyframes).toEqual([
    { transform: "translateX(300px)", clipPath: "inset(0px 300px 0px 0px)" },
    { transform: "translateX(0px)", clipPath: "inset(0px 0px 0px 0px)" },
  ]);
});

test("opening keeps the collapsed track until the slide finishes, then commits it and drops the held transform", async () => {
  const { render, shell, animations } = setup();
  await render(false);
  await render(true);
  expect(shell().getAttribute("data-left-open")).toBe("true");
  expect(shell().getAttribute("data-left-track")).toBe("false");
  expect(animations[0]!.keyframes).toEqual([
    { transform: "translateX(0px)", clipPath: "inset(0px 0px 0px 0px)" },
    { transform: "translateX(300px)", clipPath: "inset(0px 300px 0px 0px)" },
  ]);
  await act(async () => { animations[0]!.finish(); await Promise.resolve(); });
  expect(shell().getAttribute("data-left-track")).toBe("true");
  expect(animations[0]!.cancelled).toBe(true);
});

test("reduced motion commits the track immediately without travel", async () => {
  const { render, shell, animations } = setup({ reducedMotion: true });
  await render(false);
  await render(true);
  expect(shell().getAttribute("data-left-track")).toBe("true");
  expect(animations).toHaveLength(0);
});

test("the grid never interpolates a sidebar track switch; the sidebar moves by transform", () => {
  expect(css).toMatch(/\.root\[data-track-switching="true"\]\s*\{\s*transition:\s*none;/u);
  expect(css).toMatch(/\.sidebar\[data-open="false"\]\s*\{[^}]*transform:\s*translateX\(-100%\)/u);
});
