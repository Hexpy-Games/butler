/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { RollingSwap } from "./RollingSwap";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("rolls the previous frame above the incoming frame", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);

  await act(async () => root.render(
    <RollingSwap itemKey="first">First activity</RollingSwap>,
  ));
  expect(container.querySelector('[data-motion="outgoing"]')).toBeNull();

  await act(async () => root.render(
    <RollingSwap itemKey="second">Second activity</RollingSwap>,
  ));
  expect(container.querySelector('[data-motion="outgoing"]')?.textContent)
    .toBe("First activity");
  const incoming = container.querySelector('[data-motion="incoming"]');
  expect(incoming?.textContent).toBe("Second activity");

  await act(async () => incoming?.dispatchEvent(
    new dom.window.Event("animationend", { bubbles: true }),
  ));
  expect(container.querySelector('[data-motion="outgoing"]')).toBeNull();
  expect(container.querySelector('[data-motion="current"]')?.textContent)
    .toBe("Second activity");
  await act(async () => root.unmount());
});
