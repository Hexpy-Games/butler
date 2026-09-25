/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CollapsibleNavGroup } from "./CollapsibleNavGroup";

const css = readFileSync(new URL("./CollapsibleNavGroup.module.css", import.meta.url), "utf8");
const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(dom.window, {
    getComputedStyle: () => ({ animationName: "none", transitionDuration: "0.16s", transitionDelay: "0s" }),
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  return dom.window.document;
}

async function render(expanded: boolean, stickyDepth?: number) {
  await act(async () => root!.render(
    <CollapsibleNavGroup label="Project" expanded={expanded} onToggle={() => {}} stickyDepth={stickyDepth} contentDataTestClass="items">
      <span>Session</span>
    </CollapsibleNavGroup>,
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

for (const stickyDepth of [undefined, 0]) {
  test(`group content reveals through the DS Collapsible (sticky=${stickyDepth !== undefined})`, async () => {
    const document = setup();
    await render(true, stickyDepth);
    const content = document.querySelector('[data-test-class="items"]');
    expect(content?.getAttribute("data-slot")).toBe("collapsible");
    expect(content?.getAttribute("data-state")).toBe("open");
    await render(false, stickyDepth);
    // Closing keeps the region mounted so its height/opacity exit can play.
    expect(document.querySelector('[data-test-class="items"]')?.getAttribute("data-state")).toBe("closed");
    await act(async () => {
      document.querySelector('[data-test-class="items"]')!
        .dispatchEvent(new document.defaultView!.Event("transitionend", { bubbles: true }));
    });
    expect(document.querySelector('[data-test-class="items"]')).toBeNull();
    await render(true, stickyDepth);
    expect(document.querySelector('[data-test-class="items"]')?.getAttribute("data-enter")).toBe("true");
  });
}

test("collapsed groups never hide the region with display:none or a grid-rows snap", () => {
  expect(css).not.toMatch(/display:\s*none/u);
  expect(css).not.toMatch(/grid-template-rows/u);
});
