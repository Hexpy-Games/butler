/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TodoProgressItemRow } from "./TodoProgressItemRow";
import type { TodoProgressPanelItemState } from "./TodoProgressPanel";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("a todo that finishes while shown draws the check; one loaded as completed stays static", async () => {
  const dom = new JSDOM('<ul id="root"></ul>');
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  const render = (state: TodoProgressPanelItemState, id = "a") => act(async () => root!.render(
    <TodoProgressItemRow item={{ id, title: "Build", state, statusLabel: state }} />,
  ));
  const check = () => dom.window.document.querySelector('[data-slot="success-check"]');
  await render("running");
  expect(dom.window.document.querySelector('[data-slot="spinner"]')).not.toBeNull();
  await render("completed");
  expect(check()!.getAttribute("data-animate")).toBe("true");
  await act(async () => root!.unmount());
  root = createRoot(dom.window.document.getElementById("root")!);
  await render("completed", "b");
  expect(check()!.getAttribute("data-animate")).toBe("false");
});
