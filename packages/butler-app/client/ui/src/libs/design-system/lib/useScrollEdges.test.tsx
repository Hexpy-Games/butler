/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { ScrollArea } from "../blocks/ScrollArea";

async function renderInDom(node: React.ReactNode) {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = Object.fromEntries(["window", "document", "navigator", "HTMLElement", "Node", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, (globalThis as any)[key]]));
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, ResizeObserver: Observer, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(node));
  return {
    document: dom.window.document,
    async cleanup() {
      await act(async () => root.unmount());
      Object.assign(globalThis, saved);
    },
  };
}

test("ScrollArea opts its scroller into the shared fade on the requested axis", async () => {
  const scrollRef = createRef<HTMLDivElement>();
  const view = await renderInDom(<>
    <ScrollArea dataTestClass="vertical" scrollRef={scrollRef}>content</ScrollArea>
    <ScrollArea dataTestClass="horizontal" orientation="x">content</ScrollArea>
  </>);
  try {
    const vertical = view.document.querySelector<HTMLDivElement>('[data-test-class="vertical"]')!;
    const horizontal = view.document.querySelector<HTMLElement>('[data-test-class="horizontal"]')!;
    expect(vertical.dataset.scrollFade).toBe("y");
    expect(horizontal.dataset.scrollFade).toBe("x");
    expect(vertical.dataset.overflowing).toBe("false");
    expect(scrollRef.current).toBe(vertical);
  } finally {
    await view.cleanup();
  }
});

