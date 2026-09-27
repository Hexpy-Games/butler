/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Presence } from "./Presence";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

function setup(animationName: string) {
  const dom = new JSDOM('<div id="root"></div>');
  const getComputedStyle = () => ({ animationName, animationDuration: "0.09s", animationDelay: "0s" }) as CSSStyleDeclaration;
  Object.assign(dom.window, { getComputedStyle });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  return dom.window.document;
}

async function render(present: boolean) {
  await act(async () => root!.render(
    <Presence present={present}>
      <span data-test-class="panel">Panel</span>
    </Presence>,
  ));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("Presence mounts its child with data-state=open", async () => {
  const document = setup("none");
  await render(true);
  expect(document.querySelector('[data-test-class="panel"]')?.getAttribute("data-state")).toBe("open");
  await render(false);
  expect(document.querySelector('[data-test-class="panel"]')).toBeNull();
});

test("Presence keeps the child mounted with data-state=closed until its exit animation ends", async () => {
  const document = setup("tooltip-exit");
  await render(true);
  await render(false);
  const panel = document.querySelector('[data-test-class="panel"]');
  expect(panel?.getAttribute("data-state")).toBe("closed");
  await act(async () => {
    panel!.dispatchEvent(new document.defaultView!.Event("animationend", { bubbles: true }));
  });
  expect(document.querySelector('[data-test-class="panel"]')).toBeNull();
});

test("Presence reopens a closing child without remounting it", async () => {
  const document = setup("tooltip-exit");
  await render(true);
  const first = document.querySelector('[data-test-class="panel"]');
  await render(false);
  await render(true);
  const panel = document.querySelector('[data-test-class="panel"]');
  expect(panel).toBe(first);
  expect(panel?.getAttribute("data-state")).toBe("open");
});

test("Presence renders nothing while never present", async () => {
  const document = setup("none");
  await render(false);
  expect(document.querySelector('[data-test-class="panel"]')).toBeNull();
});
