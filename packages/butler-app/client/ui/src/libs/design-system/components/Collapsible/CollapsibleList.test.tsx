/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CollapsibleList } from "./CollapsibleList";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;
let document: Document;

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(dom.window, {
    getComputedStyle: () => ({ animationName: "none", transitionDuration: "0.11s", transitionDelay: "0s" }),
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  });
  document = dom.window.document;
  root = createRoot(document.getElementById("root")!);
}

const render = (keys: string[], scope = "all") => act(async () => root!.render(
  <CollapsibleList scope={scope}>
    {keys.map((key) => <span key={key} data-row={key}>{key}</span>)}
  </CollapsibleList>,
));
const items = () => [...document.querySelectorAll('[data-slot="collapsible-list-item"]')];
const row = (key: string) => document.querySelector(`[data-row="${key}"]`)?.parentElement ?? null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("rows present on the first render, or the first rows after an empty list, do not animate in", async () => {
  setup();
  await render([]);
  await render(["a", "b"]);
  expect(items().map((item) => item.hasAttribute("data-enter"))).toEqual([false, false]);
});

test("a row inserted later reveals (height + fade) in its place", async () => {
  setup();
  await render(["a", "b"]);
  await render(["new", "a", "b"]);
  expect(items().map((item) => item.textContent)).toEqual(["new", "a", "b"]);
  expect(row("new")?.getAttribute("data-enter")).toBe("true");
  expect(row("a")?.hasAttribute("data-enter")).toBe(false);
});

test("a removed row folds away in place and unmounts after its exit", async () => {
  setup();
  await render(["a", "b", "c"]);
  await render(["a", "c"]);
  expect(items().map((item) => item.textContent)).toEqual(["a", "b", "c"]);
  // It starts folding a frame after the removal commit.
  expect(row("b")?.getAttribute("data-state")).toBe("open");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  expect(row("b")?.getAttribute("data-state")).toBe("closed");
  await act(async () => {
    row("b")!.dispatchEvent(new document.defaultView!.Event("transitionend", { bubbles: true }));
  });
  expect(items().map((item) => item.textContent)).toEqual(["a", "c"]);
});

test("a scope change (another tab) swaps rows without insert or remove motion", async () => {
  setup();
  await render(["a", "b"], "all");
  await render(["x", "y"], "recent");
  expect(items().map((item) => item.textContent)).toEqual(["x", "y"]);
  expect(items().some((item) => item.hasAttribute("data-enter"))).toBe(false);
});
