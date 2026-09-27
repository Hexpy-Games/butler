/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoadingIndicator } from "./LoadingIndicator";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
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

test("loading shows the Spinner; completing swaps in the drawing check at the same size", async () => {
  const document = setup();
  await act(async () => root!.render(<LoadingIndicator state="loading" size={20} label="Running" doneLabel="Complete" />));
  const spinner = document.querySelector('[data-slot="spinner"]')!;
  expect(spinner.getAttribute("width")).toBe("20");
  expect(spinner.getAttribute("aria-label")).toBe("Running");
  expect(document.querySelector('[data-slot="success-check"]')).toBeNull();
  await act(async () => root!.render(<LoadingIndicator state="done" size={20} label="Running" doneLabel="Complete" />));
  expect(document.querySelector('[data-slot="spinner"]')).toBeNull();
  const check = document.querySelector('[data-slot="success-check"]')!;
  expect(check.getAttribute("width")).toBe("20");
  expect(check.getAttribute("data-animate")).toBe("true");
  expect(check.getAttribute("aria-label")).toBe("Complete");
  expect(check.querySelector("circle")).not.toBeNull();
});

test("an indicator that mounts already done shows a static check (history rows do not replay)", async () => {
  const document = setup();
  await act(async () => root!.render(<LoadingIndicator state="done" />));
  expect(document.querySelector('[data-slot="success-check"]')!.getAttribute("data-animate")).toBe("false");
});
