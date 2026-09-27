/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "./Card";

const KEYS = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;

test("a static card has no button semantics", () => {
  const card = new JSDOM(renderToStaticMarkup(<Card interactive>Static</Card>)).window.document.body.firstElementChild!;
  expect(card.hasAttribute("role")).toBe(false);
  expect(card.hasAttribute("tabindex")).toBe(false);
});

test("an interactive card with onClick is a focusable button activated by Enter and Space", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let clicks = 0;
  try {
    await act(async () => root.render(<Card interactive aria-label="Open work" onClick={() => { clicks += 1; }}>Work</Card>));
    const card = dom.window.document.querySelector<HTMLElement>('[data-slot="card"]')!;
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    await act(async () => card.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => card.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true })));
    await act(async () => card.click());
    expect(clicks).toBe(3);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
